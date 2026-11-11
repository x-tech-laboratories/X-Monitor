// A user-defined shell command as a monitor. The single command runs over the monitor's transport; on an agent-backed
// host the agent samples it locally at the monitor's interval and pushes the results instead. Config: command, timeout,
// pattern, warning, threshold, invert, nonzero_is_warning, value_label, value_unit. Without a pattern, exit 0 is online
// and non-zero is failed (or warning when nonzero_is_warning is set); with one, the first captured number is ranked
// against warning and threshold, each optional (reversed when invert is set), and a timeout or a non-matching output is
// failed. A command that never ran because the host was unreachable is unavailable.

import { parse_float, parse_int, python_float_repr, python_regex } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { floor_level_for, level_for, limit_from, python_g, type PluginConfig } from "./base/plugin_helpers.ts";

const default_layout_metric: LayoutRow[] = [["host_card", "exit_card", "value_card"], ["chart"], ["events"]];
const default_layout_plain: LayoutRow[] = [["host_card", "exit_card"], ["events"]];

// Single-quotes a command for sh -c, closing and reopening the quote around each embedded quote.
function shell_single_quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class CommandPlugin extends Plugin {
  override readonly SAMPLED = true;
  readonly command: string | null;
  readonly command_timeout: number;
  readonly pattern: RegExp | null;
  readonly pattern_source: string | null;
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly invert: boolean;
  readonly nonzero_is_warning: boolean;
  readonly value_label: string;
  readonly value_unit: string;
  readonly has_value: boolean;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.command = (config.command as string | null | undefined) ?? null;
    this.command_timeout = parse_int(config.timeout ?? 30);
    const pattern = config.pattern as string | null | undefined;
    this.pattern_source = pattern || null;
    this.pattern = pattern ? python_regex(pattern) : null;
    this.warning = limit_from(config, "warning");
    this.threshold = limit_from(config, "threshold");
    this.invert = Boolean(config.invert ?? false);
    this.nonzero_is_warning = Boolean(config.nonzero_is_warning ?? false);
    this.value_label = String(config.value_label ?? "VALUE");
    this.value_unit = String(config.value_unit ?? "");
    this.has_value = this.pattern !== null;
  }

  // The extracted value with this command's configured unit.
  readonly value_text = (value: number | null): string => (value === null ? "--" : `${python_g(value)}${this.value_unit}`);

  private level_for_value(value: number): Status {
    if (this.invert) return floor_level_for(value, this.warning, this.threshold);
    return level_for(value, this.warning, this.threshold);
  }

  override commands(): Command[] {
    if (!this.command) return [];
    return [command(`timeout ${this.command_timeout} sh -c ${shell_single_quote(this.command)}`)];
  }

  override parse(results: CmdResult[]): CollectResult {
    if (!this.command) return CollectResult.failed("No 'command' configured");

    const { exit_code, stdout, stderr } = results[0];
    if (exit_code === -1) return CollectResult.unavailable(`Command did not run: ${(stderr || stdout).trim().slice(0, 200)}`);
    if (exit_code === 124) return CollectResult.failed(`Command timed out after ${this.command_timeout}s`);

    const metrics: Record<string, number> = { exit_code };
    const snippet = (stdout || stderr).trim();
    const logs: LogEntry[] = [[snippet ? `exit=${exit_code} ${snippet.slice(0, 200)}` : `exit=${exit_code}`, exit_code === 0 ? "INFO" : "ERROR"]];

    if (this.pattern !== null) {
      const value = this.extract_value(stdout);
      if (value === null) {
        logs.push([`Pattern ${JSON.stringify(this.pattern_source)} did not match a number in output`, "ERROR"]);
        return new CollectResult({ metrics, logs, status: "failed" });
      }
      metrics.value = value;
      const overall = this.level_for_value(value);
      logs.push([`${this.value_label}: ${python_float_repr(value)}${this.value_unit} -> ${overall}`, log_level_of(overall)]);
      return new CollectResult({ metrics, logs, status: overall });
    }

    const status: Status = exit_code === 0 ? "online" : this.nonzero_is_warning ? "warning" : "failed";
    return new CollectResult({ metrics, logs, status });
  }

  private extract_value(stdout: string): number | null {
    const match = this.pattern!.exec(stdout || "");
    if (!match) return null;
    const raw = match.length > 1 ? match[1] : match[0];
    if (raw === undefined) return null;
    try {
      return parse_float(raw);
    } catch {
      return null;
    }
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  readonly value_color = (value: number | null): Status | null => (value === null ? null : this.level_for_value(value));

  override get UI_SPEC(): UISpec {
    const cards: Record<string, CardSpec> = { exit_card: { metric: "exit_code", title: "EXIT CODE", format: "int", color: "nonzero_failed" } };
    const spec: UISpec = { layout: this.has_value ? default_layout_metric : default_layout_plain, cards, events: true };
    if (this.has_value) {
      cards.value_card = { metric: "value", title: this.value_label, format: this.value_text, color: this.value_color };
      spec.chart = { metric: "value", title: this.value_label };
    }
    return spec;
  }
}
