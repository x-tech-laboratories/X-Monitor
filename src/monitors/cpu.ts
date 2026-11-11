// CPU utilization, overall and per core, sampled from /proc/stat and ranked against warning and threshold; a sample
// that could not be read or parsed is unavailable.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { format_fixed } from "../shared/numbers.ts";
import { log_level_of } from "../shared/status.ts";
import type { CardSpec, ChartSpec, LayoutRow } from "../shared/ui_spec.ts";
import { level_for, limit_from, limits_text, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin, worst_status } from "./base/signal_plugin.ts";

// ── Parsing ──────────────────────────────────────────────────────────────────

function parse_cpu_line(line: string): [total: number, idle: number] {
  const parts = line.split(/\s+/).filter((part) => part !== "");
  const field = (index: number): number => {
    if (index >= parts.length) return 0;
    if (!/^-?\d+$/.test(parts[index])) throw new Error(`invalid literal for int(): '${parts[index]}'`);
    return Number(parts[index]);
  };
  if (parts.length < 5) throw new Error("list index out of range");
  const [user, nice, system, idle] = [field(1), field(2), field(3), field(4)];
  const [iowait, irq, softirq, steal] = [field(5), field(6), field(7), field(8)];
  return [user + nice + system + idle + iowait + irq + softirq + steal, idle + iowait];
}

function cpu_pct(first: string, second: string): number {
  const [total1, idle1] = parse_cpu_line(first);
  const [total2, idle2] = parse_cpu_line(second);
  const delta_total = total2 - total1;
  const delta_idle = idle2 - idle1;
  if (delta_total <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - delta_idle / delta_total)));
}

// The output's /proc/stat samples, each mapping "cpu" or "cpu<n>" to its line.
function split_samples(stdout: string): Map<string, string>[] {
  const samples: Map<string, string>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const name = line.trim() ? line.trim().split(/\s+/)[0] : "";
    if (!name.startsWith("cpu")) continue;
    if (name === "cpu") samples.push(new Map());
    samples.at(-1)?.set(name, line);
  }
  return samples;
}

// Every core present in both samples, by core number; a core that went offline between them is skipped.
function core_pcts(first: Map<string, string>, second: Map<string, string>): Map<number, number> {
  const cores = new Map<number, number>();
  for (const [name, line] of second) {
    const index = name.slice(3);
    if (!/^\d+$/.test(index) || !first.has(name)) continue;
    try {
      cores.set(Number(index), cpu_pct(first.get(name)!, line));
    } catch {
      continue;
    }
  }
  return new Map([...cores].sort(([a], [b]) => a - b));
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// CPU utilization from two /proc/stat samples a second apart, taken on the target so the sleep costs one round trip;
// the same samples give every core's utilization, and per-core history metrics are opt-in.
export class Cpu extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly per_core_metrics: boolean;
  readonly core_warning: number | null;
  readonly core_threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 70);
    this.threshold = limit_from(config, "threshold", 85);
    this.per_core_metrics = Boolean(config.per_core_metrics ?? false);
    this.core_warning = limit_from(config, "core_warning");
    this.core_threshold = limit_from(config, "core_threshold");
  }

  // Whether either per-core limit is set, so the busiest core is ranked on its own.
  private core_rule_enabled(): boolean {
    return this.core_warning !== null || this.core_threshold !== null;
  }

  // One core's bar, by the per-core limits when set, else the overall ones.
  core_level(item: Record<string, unknown>): "online" | "warning" | "failed" {
    const value = Number(item.value) || 0;
    if (this.core_rule_enabled()) return level_for(value, this.core_warning, this.core_threshold);
    return level_for(value, this.warning, this.threshold);
  }

  override commands(): Command[] {
    return [command("{ grep '^cpu' /proc/stat; sleep 1; grep '^cpu' /proc/stat; }")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`CPU collection failed: ${stderr}`);

    const samples = split_samples(stdout);
    if (samples.length < 2) return CollectResult.unavailable(`Incomplete CPU output: ${JSON.stringify(stdout)}`);

    let total: number;
    try {
      total = cpu_pct(samples[0].get("cpu")!, samples[1].get("cpu")!);
    } catch (error) {
      return CollectResult.unavailable(`Failed to parse CPU output: ${(error as Error).message}`);
    }

    const cores = core_pcts(samples[0], samples[1]);
    const metrics: Record<string, number> = { cpu_pct: total };
    const levels: string[] = [level_for(total, this.warning, this.threshold)];
    let busiest = "";
    if (cores.size > 0) {
      const [busiest_core, core_max] = [...cores].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
      metrics.cpu_core_max_pct = core_max;
      busiest = `, busiest core ${busiest_core} at ${format_fixed(core_max, 0)}%`;
      if (this.core_rule_enabled()) levels.push(level_for(core_max, this.core_warning, this.core_threshold));
      if (this.per_core_metrics) for (const [index, pct] of cores) metrics[`cpu${index}_pct`] = pct;
    }

    const status = worst_status(levels);
    return new CollectResult({
      metrics,
      logs: [[`CPU ${format_fixed(total, 1)}% (${limits_text(this.warning, this.threshold, "%")})${busiest}`, log_level_of(status)]],
      status,
      snapshot: [...cores].map(([index, pct]) => ({ label: String(index), value: pct })),
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    const core_marker = this.core_rule_enabled() ? this.core_warning : this.warning;
    return {
      cpu_card: { kind: "gauge", metric: "cpu_pct", title: "CPU", format: "percent1", color: { warning: this.warning, threshold: this.threshold } },
      cores: {
        title: "CORES",
        repeat: {
          source: "snapshot",
          container: "bars",
          bar_marker: core_marker ?? undefined,
          item_format: "percent0",
          item_color_by: (item) => this.core_level(item),
          empty_text: "No per-core data yet",
        },
      },
    };
  }

  override card_row(): string[] {
    return ["cpu_card"];
  }

  override rows(): LayoutRow[] {
    return [["cores"]];
  }

  override charts(): Record<string, ChartSpec> {
    return { cpu_chart: { metric: "cpu_pct", title: "CPU USAGE (%)" } };
  }
}
