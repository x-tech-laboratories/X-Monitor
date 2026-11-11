// Load average, read from /proc/loadavg and scaled by core count; a sample that could not be read or parsed is
// unavailable.

import { format_fixed, parse_float, parse_int, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of } from "../shared/status.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import { level_for, limit_from, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

// ── Monitor ──────────────────────────────────────────────────────────────────

// Load average normalized by core count, so 100% means the host is exactly at capacity; each limit is optional and
// applies on its own, and with neither, load is charted but never changes the status.
export class Load extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning");
    this.threshold = limit_from(config, "threshold");
  }

  override commands(): Command[] {
    return [command('echo "LOAD:$(cat /proc/loadavg)"; echo "CPUS:$(nproc)"')];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Load collection failed: ${stderr}`);

    const lines = split_lines(stdout);
    const load_line = lines.find((line) => line.startsWith("LOAD:"));
    const cpus_line = lines.find((line) => line.startsWith("CPUS:"));
    if (!load_line) return CollectResult.unavailable(`Incomplete load output: ${JSON.stringify(stdout)}`);

    let cpu_count: number;
    let load_pct_1m: number;
    let load_pct_5m: number;
    let load_pct_15m: number;
    try {
      cpu_count = cpus_line ? Math.max(1, parse_int(cpus_line.slice("CPUS:".length).trim())) : 1;
      const parts = split_words(load_line.slice("LOAD:".length));
      if (parts.length < 3) throw new Error("list index out of range");
      load_pct_1m = (parse_float(parts[0]) / cpu_count) * 100;
      load_pct_5m = (parse_float(parts[1]) / cpu_count) * 100;
      load_pct_15m = (parse_float(parts[2]) / cpu_count) * 100;
    } catch (error) {
      return CollectResult.unavailable(`Failed to parse load output: ${(error as Error).message}`);
    }

    const status = level_for(load_pct_1m, this.warning, this.threshold);
    return new CollectResult({
      metrics: { load_pct_1m, load_pct_5m, load_pct_15m },
      logs: [[`LOAD ${format_fixed(load_pct_1m, 0)}% / ${format_fixed(load_pct_5m, 0)}% / ${format_fixed(load_pct_15m, 0)}% (1m/5m/15m, ${cpu_count} cores)`, log_level_of(status)]],
      status,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    const load_1m_card: CardSpec = { kind: "gauge", metric: "load_pct_1m", title: "LOAD 1M", format: "percent0_plain_dash" };
    if (this.warning !== null || this.threshold !== null) load_1m_card.color = { warning: this.warning, threshold: this.threshold };
    return { load_1m_card };
  }

  override charts(): Record<string, ChartSpec> {
    return {
      load_chart: {
        title: "LOAD AVERAGE (%)",
        style: "lines",
        series: [
          { metric: "load_pct_1m", label: "1m" },
          { metric: "load_pct_5m", label: "5m" },
          { metric: "load_pct_15m", label: "15m" },
        ],
      },
    };
  }
}
