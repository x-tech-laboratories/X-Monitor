// Memory and swap use, read from /proc/meminfo; a sample that could not be read or parsed is unavailable.

import { format_fixed, parse_int, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of } from "../shared/status.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import { format_bytes, level_for, limit_from, limits_text, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

// ── Page text ────────────────────────────────────────────────────────────────

export function format_memory_used(values: Record<string, unknown>): string {
  const used = values.memory_used_gb;
  const total = values.memory_total_gb;
  if (used === null || used === undefined || total === null || total === undefined) return "--";
  return `${format_bytes(Number(used))} / ${format_bytes(Number(total))}`;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// RAM usage, counting MemAvailable as free so the filesystem cache is not reported as used.
export class Memory extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 75);
    this.threshold = limit_from(config, "threshold", 90);
  }

  override commands(): Command[] {
    return [command("grep -E 'MemTotal:|MemAvailable:' /proc/meminfo")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Memory collection failed: ${stderr}`);

    const lines = split_lines(stdout);
    const total_line = lines.find((line) => line.startsWith("MemTotal:"));
    const avail_line = lines.find((line) => line.startsWith("MemAvailable:"));
    if (!total_line || !avail_line) return CollectResult.unavailable(`Incomplete memory output: ${JSON.stringify(stdout)}`);

    let memory_pct: number;
    let memory_total_gb: number;
    let memory_used_gb: number;
    try {
      const total_kb = parse_int(split_words(total_line)[1]);
      const avail_kb = parse_int(split_words(avail_line)[1]);
      const used_kb = total_kb - avail_kb;
      memory_pct = total_kb > 0 ? (100 * used_kb) / total_kb : 0;
      memory_total_gb = total_kb / 1024 ** 2;
      memory_used_gb = used_kb / 1024 ** 2;
    } catch (error) {
      return CollectResult.unavailable(`Failed to parse memory output: ${(error as Error).message}`);
    }

    const status = level_for(memory_pct, this.warning, this.threshold);
    return new CollectResult({
      metrics: { memory_pct, memory_used_gb, memory_total_gb },
      logs: [[`MEM ${format_fixed(memory_pct, 1)}% (${format_bytes(memory_used_gb)} / ${format_bytes(memory_total_gb)}, ${limits_text(this.warning, this.threshold, "%")})`, log_level_of(status)]],
      status,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      mem_pct_card: { kind: "gauge", metric: "memory_pct", title: "MEMORY", format: "percent1_plain_dash", color: { warning: this.warning, threshold: this.threshold } },
      mem_used_card: { title: "MEM USED", metrics: ["memory_used_gb", "memory_total_gb"], format_fn: format_memory_used },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return { memory_chart: { metric: "memory_pct", title: "MEMORY USAGE (%)" } };
  }
}
