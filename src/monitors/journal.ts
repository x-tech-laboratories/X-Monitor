// A host's systemd journal: each poll counts the error and warning entries written since the last one, logging an event
// when the errors pass a limit, and the Query Logs action searches the whole journal on demand by time, priority, unit
// and text. Nothing is copied into X-Monitor; a search reads whatever journald still keeps on the host. Status is
// online unless warning/threshold (new error entries per poll) are set, warning when the account can only read its own
// journal, and unavailable when journalctl cannot be run. Config: warning, threshold, max_entries.

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import type { Status } from "../shared/status.ts";
import { iso_local } from "../shared/time.ts";
import type { CardSpec, ChartSpec, LayoutRow } from "../shared/ui_spec.ts";
import { make_inline_layout } from "./base/child_cards.ts";
import type { CustomView } from "./base/plugin_base.ts";
import { level_for, limit_from, parse_duration, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { int_or_null, parse_int, split_lines } from "./base/text_parsing.ts";

// ── Journal entries ──────────────────────────────────────────────────────────

export const PRIORITY_NAMES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

export const ERROR_PRIORITY = 3;
export const WARNING_PRIORITY = 4;

// The fields a search asks journalctl for; the timestamp and cursor always come along.
const fields = ["MESSAGE", "PRIORITY", "_SYSTEMD_UNIT", "SYSLOG_IDENTIFIER", "_COMM", "_PID"];

// The most entries one poll reads, so a host flooding its journal cannot flood X-Monitor.
const poll_cap = 5000;

// The most entries one search returns from one host, which keeps its reply under the agent's 4 MB output limit.
export const MAX_SEARCH_LIMIT = 5000;

const no_system_journal = "not seeing messages";

// One journal entry as a poll or a search reads it.
export interface JournalEntry {
  epoch: number;
  cursor: string;
  priority: number;
  unit: string;
  identifier: string;
  pid: string;
  message: string;
}

// A journal priority from its number or name, such as 3 or "err", or the fallback when it is neither.
export function priority_of(name: unknown, fallback = 7): number {
  if (name === null || name === undefined || name === "") return fallback;
  let text = String(name).trim().toLowerCase();
  if (/^\d+$/.test(text)) return Math.min(Number(text), 7);
  const aliases: Record<string, string> = { error: "err", warn: "warning", critical: "crit", emergency: "emerg" };
  text = aliases[text] ?? text;
  return PRIORITY_NAMES.includes(text) ? PRIORITY_NAMES.indexOf(text) : fallback;
}

// The feed level a priority shows as: errors and worse, warnings, and the rest.
export function level_of(priority: number): string {
  if (priority <= ERROR_PRIORITY) return "ERROR";
  if (priority === WARNING_PRIORITY) return "WARNING";
  return priority === 7 ? "DEBUG" : "INFO";
}

// A journal field as text; journalctl writes a field that is not valid UTF-8 as a list of byte values.
function text_of(value: unknown): string {
  if (Array.isArray(value)) {
    if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return "";
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(value as number[]));
  }
  return value === null || value === undefined ? "" : String(value);
}

// One line of `journalctl -o json` as an entry, or null for a line that is not one.
export function parse_entry(line: string): JournalEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const stamp = int_or_null(record.__REALTIME_TIMESTAMP ?? 0);
  return {
    epoch: stamp === null ? 0 : stamp / 1_000_000,
    cursor: text_of(record.__CURSOR),
    priority: priority_of(text_of(record.PRIORITY), 6),
    unit: text_of(record._SYSTEMD_UNIT),
    identifier: text_of(record.SYSLOG_IDENTIFIER) || text_of(record._COMM),
    pid: text_of(record._PID),
    message: text_of(record.MESSAGE),
  };
}

// An entry's time as the dashboard shows it, in the server's local time.
export function entry_time(epoch: number): string {
  return epoch ? iso_local(new Date(epoch * 1000)) : "";
}

// Every entry in `journalctl -o json` output, skipping lines that are not entries.
export function parse_entries(stdout: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of split_lines(stdout)) {
    if (!line.startsWith("{")) continue;
    const entry = parse_entry(line);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

// ── Commands ─────────────────────────────────────────────────────────────────

// The warning-and-worse entries since the cursor, or over the last window when there is no cursor or it is gone.
export function poll_command(cursor: string | null, window_seconds: number): string {
  const read = `journalctl --no-pager -p warning -o json --output-fields=${fields.join(",")} -n ${poll_cap}`;
  const since = `${read} --since=-${Math.trunc(window_seconds)}s`;
  if (!cursor) return since;
  return `${read} --after-cursor=${shell_quote(cursor)} || ${since}`;
}

// The newest entries matching a search, newest first; `since` is a duration such as "1h", "boot", or empty for the
// whole journal.
export function search_command(options: { since?: string | null; priority?: number | null; unit?: string; text?: string; limit?: number } = {}): string {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 500), MAX_SEARCH_LIMIT));
  const unit = options.unit ?? "";
  const text = options.text ?? "";
  const parts = ["journalctl", "--no-pager", "-q", "-r", "-o", "json", `--output-fields=${fields.join(",")}`];
  if (options.since === "boot") parts.push("-b");
  else if (options.since) parts.push(`--since=-${parse_duration(options.since, "since")}s`);
  if (options.priority !== null && options.priority !== undefined && options.priority < 7) parts.push("-p", String(Math.trunc(options.priority)));
  if (unit.trim()) parts.push("-u", shell_quote(unit.trim()));
  if (!text.trim()) return [...parts, "-n", String(limit)].join(" ");
  // grep reads the JSON lines, so a match is checked again against the decoded fields.
  return `${parts.join(" ")} | grep -iF -e ${shell_quote(text.trim())} | head -n ${limit}`;
}

// Whether the entry's message, unit or identifier holds the text, ignoring case.
export function matches_text(entry: Partial<JournalEntry>, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return (["message", "unit", "identifier"] as const).some((field) => String(entry[field] ?? "").toLowerCase().includes(needle));
}

// Why a search failed, or null when it ran.
export function search_failure(result: CmdResult): string | null {
  const error = result.stderr.trim();
  if (result.exit_code !== 0 && !result.stdout.trim()) return error || `journalctl exited with ${result.exit_code}`;
  if (!result.stdout.trim() && error && !error.includes("grep")) return error;
  return null;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// One host's journal: error and warning counts per poll, and a search over all of it.
export class Journal extends SignalPlugin {
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly max_entries: number;
  private cursor: string | null = null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning");
    this.threshold = limit_from(config, "threshold");
    this.max_entries = Math.max(1, Math.min(parse_int(config.max_entries ?? 500), MAX_SEARCH_LIMIT));
  }

  override commands(): Command[] {
    return [command(poll_command(this.cursor, this.interval))];
  }

  override parse(results: CmdResult[]): CollectResult {
    const result = results[0];
    const entries = parse_entries(result.stdout);
    if (result.exit_code !== 0 && entries.length === 0) return CollectResult.unavailable(`Could not read the journal: ${result.stderr.trim() || `exit code ${result.exit_code}`}`);
    if (entries.length > 0 && entries.at(-1)!.cursor) this.cursor = entries.at(-1)!.cursor;

    const errors = entries.filter((entry) => entry.priority <= ERROR_PRIORITY);
    const metrics = { errors_new: errors.length, warnings_new: entries.length - errors.length };
    const logs: LogEntry[] = [];
    let status: Status = level_for(errors.length, this.warning, this.threshold);

    if (result.stderr.includes(no_system_journal) || result.stdout.includes(no_system_journal)) {
      logs.push(["Only this account's own journal is readable; add it to the systemd-journal group to see the system's", "WARNING"]);
      if (status === "online") status = "warning";
    }
    if (errors.length > 0 && status !== "online") {
      const newest = errors.at(-1)!;
      const source = newest.unit || newest.identifier || "journal";
      logs.push([`${errors.length} new error entr${errors.length === 1 ? "y" : "ies"}; newest from ${source}: ${newest.message.slice(0, 200)}`, status === "failed" ? "ERROR" : "WARNING"]);
    }
    if (entries.length >= poll_cap) logs.push([`More than ${poll_cap} warning or error entries since the last poll`, "WARNING"]);
    return new CollectResult({ metrics, logs, status });
  }

  // ── Searching ────────────────────────────────────────────────────────────

  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    if (action_id !== "query_logs") return null;
    return action_plan(
      search_command({
        since: (args.since as string | null | undefined) ?? null,
        priority: priority_of(args.priority),
        unit: String(args.unit || ""),
        text: String(args.text || ""),
        limit: parse_int(args.limit || this.max_entries),
      }),
      { timeout: 60 },
    );
  }

  // The search's entries as JSON in metadata.entries, or why it failed in metadata.content.
  override interpret_action(_action_id: string, result: unknown, args: Record<string, unknown> = {}): ActionOutcome {
    const outcome = result as CmdResult;
    const failure = search_failure(outcome);
    if (failure) return new CollectResult({ success: false, metadata: { content: failure } });
    const text = String(args.text || "");
    const entries = parse_entries(outcome.stdout).filter((entry) => matches_text(entry, text));
    return new CollectResult({ success: true, metadata: { entries: JSON.stringify(entries) } });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  readonly count_color = (value: number | null): Status | null => (value === null ? null : level_for(value, this.warning, this.threshold));

  override cards(): Record<string, CardSpec> {
    return {
      errors_card: { metric: "errors_new", title: "NEW ERRORS", format: "int", color: this.count_color },
      warnings_card: { metric: "warnings_new", title: "NEW WARNINGS", format: "int" },
    };
  }

  override rows(): LayoutRow[] {
    return [["log_search"]];
  }

  override charts(): Record<string, ChartSpec> {
    return { errors_chart: { metric: "errors_new", title: "ERRORS PER POLL" } };
  }

  // The declarative page with the log search in its log_search cell, which only the full page shows.
  override custom_view(): CustomView {
    const layout = this.UI_SPEC.layout ?? [];
    return {
      kind: "journal",
      data: {
        spec_page: true,
        default_layout: layout,
        inline_layout: make_inline_layout(layout),
        log_search: { cell: "log_search", monitor_ids: [this.id], show_host: false, default_limit: this.max_entries, priority_names: PRIORITY_NAMES, page_only: true },
      },
    };
  }
}
