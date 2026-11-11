// TCP connection counts by state, read from /proc/net/tcp. A total at or above `warning` is a warning, never a failure,
// since a burst of short-lived sockets (a port scan, a busy client) is normal; a table that could not be read is
// unavailable.

import { split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of } from "../shared/status.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import { level_for, limit_from, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

const tcp_states: Record<string, string> = {
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
};

// ── Parsing ──────────────────────────────────────────────────────────────────

// The sockets in each TCP state across the /proc/net/tcp tables.
export function parse_states(stdout: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of split_lines(stdout)) {
    const fields = split_words(line);
    if (fields.length < 4) continue;
    if (fields[0].replace(/:+$/, "") === "sl") continue;
    const state = tcp_states[fields[3].toUpperCase()];
    if (state) counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return counts;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// TCP socket counts per state, read straight from /proc/net/tcp{,6} so no tooling is required on the target.
export class Connections extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 500);
  }

  override commands(): Command[] {
    return [command("cat /proc/net/tcp /proc/net/tcp6 2>/dev/null")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to read /proc/net/tcp: ${stderr}`);

    const counts = parse_states(stdout);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const metrics: Record<string, number> = {};
    for (const state of Object.values(tcp_states)) metrics[`conn_${state.toLowerCase()}`] = counts.get(state) ?? 0;
    metrics.conn_total = total;

    const status = level_for(total, this.warning, null);
    const summary = [...counts.keys()].sort().map((state) => `${state}=${counts.get(state)}`).join(", ") || "no connections";
    return new CollectResult({ metrics, logs: [[`${total} TCP connections (${summary})`, log_level_of(status)]], status });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      conn_total_card: { metric: "conn_total", title: "CONNECTIONS", format: "int_rounded", color: { warning: this.warning, threshold: null } },
      conn_states_card: {
        kind: "share", title: "BY STATE", format: "int_rounded",
        parts: [
          { metric: "conn_established", label: "Established", color: "series-1" },
          { metric: "conn_listen", label: "Listening", color: "series-2" },
          { metric: "conn_time_wait", label: "Time wait", color: "series-3" },
        ],
      },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return {
      conn_total_chart: {
        title: "CONNECTIONS BY STATE", style: "stack",
        series: [
          { metric: "conn_established", label: "Established" },
          { metric: "conn_listen", label: "Listening" },
          { metric: "conn_time_wait", label: "Time wait" },
        ],
      },
    };
  }
}
