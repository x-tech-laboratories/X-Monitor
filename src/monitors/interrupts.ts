// Interrupt and context-switch rates, read from /proc/stat; a sample that could not be read or parsed is unavailable.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of } from "../shared/status.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import { level_for, limit_from, limits_text, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { format_fixed, int_or_null, split_lines, split_words } from "./base/text_parsing.ts";

// ── Parsing ──────────────────────────────────────────────────────────────────

// The first line's counter after `key`, or null when absent or not a number.
function extract_counter(block: string, key: string): number | null {
  for (const line of split_lines(block)) {
    const fields = split_words(line);
    if (fields.length >= 2 && fields[0] === key) return int_or_null(fields[1]);
  }
  return null;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Rates from two /proc/stat samples a second apart; takes its own sample rather than sharing the cpu monitor's, so a
// host can run either without the other.
export class Interrupts extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 20000);
    this.threshold = limit_from(config, "threshold", 50000);
  }

  override commands(): Command[] {
    return [command("cat /proc/stat && sleep 1 && echo '---SNAP---' && cat /proc/stat")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to read /proc/stat: ${stderr}`);

    const halves = stdout.split("---SNAP---");
    if (halves.length < 2) return CollectResult.unavailable("Unexpected /proc/stat output format");

    const intr1 = extract_counter(halves[0], "intr");
    const intr2 = extract_counter(halves[1], "intr");
    const ctxt1 = extract_counter(halves[0], "ctxt");
    const ctxt2 = extract_counter(halves[1], "ctxt");
    if (intr1 === null || intr2 === null) return CollectResult.unavailable("Could not read 'intr' from /proc/stat");

    const irq_rate = Math.max(0, intr2 - intr1);
    const metrics: Record<string, number> = { irq_per_sec: irq_rate };
    if (ctxt1 !== null && ctxt2 !== null) metrics.ctxt_per_sec = Math.max(0, ctxt2 - ctxt1);

    const status = level_for(irq_rate, this.warning, this.threshold);
    return new CollectResult({
      metrics,
      logs: [[`${format_fixed(irq_rate, 0)} interrupts/sec (${limits_text(this.warning, this.threshold)})`, log_level_of(status)]],
      status,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      irq_card: { metric: "irq_per_sec", title: "INTERRUPTS/S", format: "count_comma_rounded", color: { warning: this.warning, threshold: this.threshold } },
      ctxt_card: { metric: "ctxt_per_sec", title: "CTX SWITCH/S", format: "count_comma_rounded" },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return {
      irq_chart: { metric: "irq_per_sec", title: "INTERRUPTS / SEC" },
      ctxt_chart: { metric: "ctxt_per_sec", title: "CONTEXT SWITCHES / SEC" },
    };
  }
}
