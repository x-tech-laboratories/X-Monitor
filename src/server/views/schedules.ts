// The schedules view: every monitor's scheduled and triggered actions in one table, with each one's next run and how
// its last run went.

import type { BadgeTone } from "../../shared/page_view.ts";
import { STATUS_BADGES } from "../../shared/page_view.ts";
import type { ActionButtonSpec } from "../../shared/ui_spec.ts";
import { action_names } from "./monitor.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A time as "Thu 22 Oct 21:00", in local time.
export function format_when(moment: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[moment.getDay()]} ${two(moment.getDate())} ${MONTHS[moment.getMonth()]} ${two(moment.getHours())}:${two(moment.getMinutes())}`;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

// The parts of a monitor this view reads.
export interface ScheduledMonitor {
  id: string;
  name: string;
  children?: readonly ScheduledMonitor[];
  scheduled_actions?: readonly { action: string; args: Record<string, unknown>; cron: { expression: string; next_after(moment: Date): Date | null }; result_key(plugin_id: string): string }[];
  triggered_actions?: readonly { action: string; args: Record<string, unknown>; describe(): string; result_key(plugin_id: string): string }[];
  all_actions(): ActionButtonSpec[];
}

export interface ScheduleRow {
  id: string;
  monitor_id: string;
  monitor: string;
  action: string;
  cron: string;
  next: string;
  next_epoch: number | null;
  last: string;
  outcome: string;
  outcome_badge: BadgeTone | "";
  message: string;
}

// The action as its button names it, or its id in words when it has no button of its own, then any arguments the
// schedule passes.
function action_label(names: Record<string, string>, action: string, args: Record<string, unknown>): string {
  let label = names[action] || capitalize(action.replaceAll("_", " "));
  const keys = Object.keys(args).sort();
  if (keys.length > 0) label += ` (${keys.map((key) => `${key}: ${String(args[key])}`).join(", ")})`;
  return label;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// The stored record of an entry's last run, or an empty one when it has not run or the record is unreadable.
function last_run(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const record: unknown = JSON.parse(raw);
    return typeof record === "object" && record !== null && !Array.isArray(record) ? (record as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// The last run, outcome and badge cells of a row, from an entry's stored record.
function last_run_cells(raw: string | null): Pick<ScheduleRow, "last" | "outcome" | "outcome_badge" | "message"> {
  const last = last_run(raw);
  const ran = last.at as number | undefined;
  return {
    last: ran ? format_when(new Date(ran * 1000)) : "not yet",
    outcome: ran ? (last.ok ? "Started" : "Failed") : "",
    outcome_badge: ran ? STATUS_BADGES[last.ok ? "online" : "failed"] : "",
    message: String(last.message ?? ""),
  };
}

// Every monitor under the roots once, with the names of the groups above it and its own, since names repeat.
function with_paths(roots: readonly ScheduledMonitor[]): [ScheduledMonitor, string][] {
  const seen = new Set<ScheduledMonitor>();
  const found: [ScheduledMonitor, string][] = [];
  const walk = (plugins: readonly ScheduledMonitor[], path: string[]): void => {
    for (const plugin of plugins) {
      if (seen.has(plugin)) continue;
      seen.add(plugin);
      const here = [...path, plugin.name];
      found.push([plugin, here.join(" › ")]);
      walk(plugin.children ?? [], here);
    }
  };
  walk(roots, []);
  return found;
}

// One row per scheduled or triggered action anywhere under the roots, soonest next run first and triggered ones last.
export function schedule_rows(roots: readonly ScheduledMonitor[], get_setting: (key: string) => string | null | undefined, now: Date): ScheduleRow[] {
  const rows: (ScheduleRow & { sort_epoch: number })[] = [];
  for (const [plugin, path] of with_paths(roots)) {
    const entries = plugin.scheduled_actions ?? [];
    const triggered = plugin.triggered_actions ?? [];
    if (entries.length === 0 && triggered.length === 0) continue;
    const names = action_names(plugin.all_actions());
    entries.forEach((entry, index) => {
      const upcoming = entry.cron.next_after(now);
      rows.push({
        id: `${plugin.id}:${index}`,
        monitor_id: plugin.id,
        monitor: path,
        action: action_label(names, entry.action, entry.args),
        cron: entry.cron.expression,
        next: upcoming ? format_when(upcoming) : "never",
        next_epoch: upcoming ? upcoming.getTime() / 1000 : null,
        sort_epoch: upcoming ? upcoming.getTime() / 1000 : Infinity,
        ...last_run_cells(get_setting(entry.result_key(plugin.id)) ?? null),
      });
    });
    triggered.forEach((entry, index) => {
      rows.push({
        id: `${plugin.id}:trigger:${index}`,
        monitor_id: plugin.id,
        monitor: path,
        action: action_label(names, entry.action, entry.args),
        cron: capitalize(entry.describe()),
        next: "on that event",
        next_epoch: null,
        sort_epoch: Infinity,
        ...last_run_cells(get_setting(entry.result_key(plugin.id)) ?? null),
      });
    });
  }
  rows.sort((left, right) => left.sort_epoch - right.sort_epoch || (left.monitor.toLowerCase() < right.monitor.toLowerCase() ? -1 : left.monitor.toLowerCase() > right.monitor.toLowerCase() ? 1 : 0));
  return rows.map(({ sort_epoch: _sort_epoch, ...row }) => row);
}
