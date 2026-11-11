// The log search: journal entries from one or many hosts, read live from each host's journal monitor, as rows the page
// sorts, filters and groups.

import type { DispatchResult } from "../../core/connectors/types.ts";
import { iso_local } from "../../shared/time.ts";
import { iter_monitors, type GraphView as GraphNode } from "../../core/coordination/monitor_graph.ts";

// ── Choices ──────────────────────────────────────────────────────────────────

// The syslog priority names, most severe first, as journalctl numbers them.
export const PRIORITY_NAMES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"] as const;

export const SINCE_OPTIONS: [string, string][] = [
  ["15m", "Last 15 minutes"], ["1h", "Last hour"], ["6h", "Last 6 hours"], ["24h", "Last day"], ["7d", "Last week"], ["boot", "This boot"], ["", "Everything kept"],
];

export const PRIORITY_OPTIONS: [number, string][] = [
  [3, "Errors and worse"], [4, "Warnings and worse"], [5, "Notices and worse"], [6, "Info and worse"], [7, "Everything"],
];

export const LIMIT_OPTIONS: [number, string][] = [[100, "100 per host"], [500, "500 per host"], [1000, "1000 per host"], [5000, "5000 per host"]];

export const GROUP_OPTIONS: [string, string][] = [["", "No grouping"], ["host", "Group by host"], ["unit", "Group by unit"], ["priority", "Group by priority"]];

// The badge tone each priority is drawn with; notices and below that are not info stay neutral.
export const PRIORITY_BADGES: Record<number, "bad" | "warn" | "info"> = { 0: "bad", 1: "bad", 2: "bad", 3: "bad", 4: "warn", 5: "info" };

export const FILTER_FIELDS = ["time", "host", "unit", "priority_name", "message"];

// ── Monitors ─────────────────────────────────────────────────────────────────

export interface JournalLike extends GraphNode {
  target: string;
  config: Record<string, unknown>;
  max_entries?: number;
}

// Whether a monitor is a journal monitor.
export function is_journal(plugin: { config?: Record<string, unknown>; constructor?: { name?: string } }): boolean {
  return plugin.config?.type === "journal" || plugin.constructor?.name === "Journal";
}

// Every journal monitor under the roots, once each, in config order.
export function journal_monitors<Monitor extends JournalLike>(roots: readonly Monitor[]): Monitor[] {
  return [...iter_monitors(roots)].filter(is_journal);
}

// ── Rows ─────────────────────────────────────────────────────────────────────

// An entry's time as the dashboard shows it, in the server's local time.
export function entry_time(epoch: number): string {
  return epoch ? iso_local(new Date(epoch * 1000)) : "";
}

export interface EntryRow {
  key: string;
  monitor_id: string;
  epoch: number;
  time: string;
  host: string;
  unit: string;
  priority: number;
  priority_name: string;
  priority_badge: string;
  message: string;
  parent?: string | null;
  group?: string;
}

// One row per entry from every monitor's search, newest first.
export function entry_rows(results: readonly [JournalLike, Record<string, unknown>[]][]): EntryRow[] {
  const rows: EntryRow[] = [];
  for (const [plugin, entries] of results) {
    entries.forEach((entry, index) => {
      const priority = Math.trunc(Number(entry.priority ?? 6));
      const epoch = Number(entry.epoch || 0);
      rows.push({
        key: `${plugin.id}:${String(entry.cursor || index)}`,
        monitor_id: plugin.id,
        epoch,
        time: entry_time(epoch),
        host: plugin.target,
        unit: String(entry.unit || entry.identifier || ""),
        priority,
        priority_name: PRIORITY_NAMES[Math.min(Math.max(priority, 0), 7)],
        priority_badge: PRIORITY_BADGES[priority] ?? "",
        message: String(entry.message ?? ""),
      });
    });
  }
  return rows.sort((left, right) => right.epoch - left.epoch);
}

function group_value(row: EntryRow, group_by: string): string {
  if (group_by === "priority") return row.priority_name;
  return String((row as unknown as Record<string, unknown>)[group_by] || "(none)");
}

// The rows under one parent row per value of the grouping field, the most recently active group first.
export function grouped_rows(rows: EntryRow[], group_by: string): EntryRow[] {
  if (!group_by) return rows;
  const groups = new Map<string, EntryRow[]>();
  for (const row of rows) {
    const value = group_value(row, group_by);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  let order = [...groups.keys()];
  if (group_by === "priority") order = order.sort((left, right) => PRIORITY_NAMES.indexOf(left as never) - PRIORITY_NAMES.indexOf(right as never));
  const flat: EntryRow[] = [];
  for (const value of order) {
    const members = groups.get(value)!;
    const worst = Math.min(...members.map((member) => member.priority));
    const parent = `group:${value}`;
    flat.push({ key: parent, monitor_id: "", parent: null, group: `${value} (${members.length})`, epoch: members[0].epoch, time: members[0].time, host: "", unit: "", priority: worst, priority_name: "", priority_badge: "", message: "" });
    flat.push(...members.map((member) => ({ ...member, parent, group: "" })));
  }
  return flat;
}

// One line saying how many entries came from how many hosts, and which hosts could not be searched.
export function summary_text(entry_count: number, host_count: number, failures: readonly [string, string][]): string {
  let text = `${entry_count} entr${entry_count === 1 ? "y" : "ies"} from ${host_count} host${host_count === 1 ? "" : "s"}`;
  if (failures.length > 0) text += `. Not searched: ${failures.map(([host, error]) => `${host} (${error})`).join("; ")}`;
  return text;
}

export interface SearchArgs {
  since: string;
  priority: number;
  unit: string;
  text: string;
  limit: number;
}

// The Query Logs action's arguments from the search bar's values.
export function search_kwargs(since: unknown, priority: unknown, unit: unknown, text: unknown, limit: unknown): SearchArgs {
  return {
    since: since ? String(since) : "",
    priority: priority !== null && priority !== undefined ? Number(priority) : 7,
    unit: String(unit || "").trim(),
    text: String(text || "").trim(),
    limit: Math.trunc(Number(limit || 500)),
  };
}

// ── Searching ────────────────────────────────────────────────────────────────

// Every monitor's search at once, as the entries each returned and the hosts that failed with why.
export async function run_search<Monitor extends JournalLike>(engine: { dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<DispatchResult> }, monitors: readonly Monitor[], args: SearchArgs): Promise<[[Monitor, Record<string, unknown>[]][], [string, string][]]> {
  const outcomes = await Promise.allSettled(monitors.map((plugin) => engine.dispatch_action(plugin, "query_logs", { ...args })));
  const results: [Monitor, Record<string, unknown>[]][] = [];
  const failures: [string, string][] = [];
  outcomes.forEach((outcome, index) => {
    const plugin = monitors[index];
    if (outcome.status === "rejected") {
      const error = outcome.reason as Error;
      failures.push([plugin.target, (error?.message || error?.name || String(error)) || "Error"]);
      return;
    }
    const [success, raw_metadata] = outcome.value;
    const metadata = raw_metadata ?? {};
    if (!success) {
      failures.push([plugin.target, String(metadata.content || "the search failed").trim()]);
      return;
    }
    try {
      results.push([plugin, JSON.parse(metadata.entries || "[]") as Record<string, unknown>[]]);
    } catch {
      failures.push([plugin.target, "the reply could not be read"]);
    }
  });
  return [results, failures];
}

export interface LogSearchResult {
  rows: EntryRow[];
  summary: string;
}

// Searches the chosen journal monitors and returns the rows and the summary line.
export async function search_logs<Monitor extends JournalLike>(engine: { plugins: readonly Monitor[]; dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<DispatchResult> }, monitor_ids: readonly string[] | null, args: SearchArgs): Promise<LogSearchResult> {
  const monitors = journal_monitors(engine.plugins).filter((plugin) => monitor_ids === null || monitor_ids.includes(plugin.id));
  if (monitors.length === 0) return { rows: [], summary: "Pick at least one host" };
  const [found, failures] = await run_search(engine, monitors, args);
  const rows = entry_rows(found);
  return { rows, summary: summary_text(rows.length, found.length, failures) };
}

export interface LogsView {
  monitors: { id: string; target: string }[];
  default_limit: number;
}

// What the Logs page searches over: every journal monitor and the default per-host limit.
export function logs_view(engine: { plugins: readonly JournalLike[] }): LogsView {
  const monitors = journal_monitors(engine.plugins);
  return {
    monitors: monitors.map((plugin) => ({ id: plugin.id, target: plugin.target })),
    default_limit: monitors.length === 1 ? Number(monitors[0].max_entries ?? 500) : 500,
  };
}
