// Kernel OOM kills, counted from /proc/vmstat and followed in the journal. A new kill is failed (warning when
// is_warning); an unreadable /proc/vmstat or a kernel without the counter is unavailable.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { StreamSpec } from "../shared/agent_protocol.ts";
import type { Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { int_or_null, parse_int, split_lines, split_words } from "./base/text_parsing.ts";

// ── Parsing ──────────────────────────────────────────────────────────────────

function extract_counter(block: string, key: string): number | null {
  for (const line of split_lines(block)) {
    const fields = split_words(line);
    if (fields.length >= 2 && fields[0] === key) return int_or_null(fields[1]);
  }
  return null;
}

// ── Results ──────────────────────────────────────────────────────────────────

// The first sample, which only records the boot-time counter.
function baseline_result(metrics: Record<string, number>, total: number): CollectResult {
  return new CollectResult({ metrics, logs: [[`Baseline established: ${total} OOM kill(s) since boot`, "INFO"]], status: "online" });
}

// A counter that went backwards, which means the host rebooted.
function reset_result(metrics: Record<string, number>, previous: number, total: number): CollectResult {
  return new CollectResult({ metrics, logs: [[`OOM counter reset (${previous} -> ${total}); host likely rebooted`, "INFO"]], status: "online" });
}

// New kills since the last sample.
function kill_result(metrics: Record<string, number>, delta: number, total: number, is_warning: boolean, kill_status: Status): CollectResult {
  return new CollectResult({
    metrics,
    logs: [[`${delta} OOM kill(s) since last check — the kernel terminated process(es) to reclaim memory (${total} total since boot)`, is_warning ? "WARNING" : "ERROR"]],
    status: kill_status,
  });
}

// The lingering warning held for alert_for collections after the last kill.
function cooldown_result(metrics: Record<string, number>, since_kill: number, alert_for: number): CollectResult {
  return new CollectResult({ metrics, logs: [[`No new OOM kills (${since_kill}/${alert_for} collections since the last one)`, "WARNING"]], status: "warning" });
}

// The all-clear once the cooldown has fully elapsed.
function clear_result(metrics: Record<string, number>, total: number): CollectResult {
  return new CollectResult({ metrics, logs: [[`No OOM kills (${total} total since boot)`, "INFO"]], status: "online" });
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Kills from /proc/vmstat's oom_kill counter plus, on an agent-backed host, the kernel journal line the OOM killer
// emits; the counter stays the authority on totals, and the journal makes a kill visible at once with its process name.
export class Oom extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly alert_for: number;
  readonly is_warning: boolean;
  private last_total: number | null = null;
  private since_kill: number | null = null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.alert_for = parse_int(config.alert_for ?? 3);
    this.is_warning = Boolean(config.is_warning ?? false);
  }

  // The recent-kills card: none is fine, and any kill takes this plugin's configured severity.
  readonly recent_color = (value: number | null): Status | null => {
    if (value === null) return null;
    return value === 0 ? "online" : this.is_warning ? "warning" : "failed";
  };

  get kill_status(): Status {
    return this.is_warning ? "warning" : "failed";
  }

  // The counter sample alongside the kernel journal: the sample carries the vmstat total, the journal names the process.
  override subscriptions(): StreamSpec[] {
    return [...super.subscriptions(), { id: `${this.id}:journal`, kind: "journal", params: { kernel: true, grep: "Out of memory" } }];
  }

  override parse_event(stream_id: string, payload: Record<string, unknown>, timestamp: number): CollectResult | null {
    if (!stream_id.endsWith(":journal")) return super.parse_event(stream_id, payload, timestamp);
    const message = String(payload.message ?? "").trim();
    if (!message) return null;
    this.since_kill = 0;
    return new CollectResult({ logs: [[`OOM killer fired: ${message}`, "ERROR"]], status: this.kill_status });
  }

  override commands(): Command[] {
    return [command("cat /proc/vmstat")];
  }

  // The total and delta kill counts: new kills report failed (warning when is_warning), the warning lingers for
  // alert_for collections afterwards, and a dump that could not be read or lacks the counter is unavailable.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to read /proc/vmstat: ${stderr}`);

    const total = extract_counter(stdout, "oom_kill");
    if (total === null) return CollectResult.unavailable("No 'oom_kill' counter in /proc/vmstat (kernel too old?)");

    const metrics: Record<string, number> = { oom_kills_total: total };
    const previous = this.last_total;
    this.last_total = total;

    if (previous === null) return baseline_result(metrics, total);
    if (total < previous) return reset_result(metrics, previous, total);

    const delta = total - previous;
    metrics.oom_kills_new = delta;
    if (delta > 0) {
      this.since_kill = 0;
      return kill_result(metrics, delta, total, this.is_warning, this.kill_status);
    }

    if (this.since_kill !== null) {
      this.since_kill += 1;
      if (this.since_kill < this.alert_for) return cooldown_result(metrics, this.since_kill, this.alert_for);
      this.since_kill = null;
    }
    return clear_result(metrics, total);
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      oom_total_card: { metric: "oom_kills_total", title: "OOM KILLS (BOOT)", format: "count_comma_rounded" },
      oom_recent_card: { metric: "oom_kills_new", title: "OOM SINCE LAST CHECK", format: "count_comma_rounded", color: this.recent_color },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return { oom_chart: { metric: "oom_kills_total", title: "OOM KILLS SINCE BOOT" } };
  }
}
