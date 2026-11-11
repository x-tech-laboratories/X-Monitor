// The overview: the fleet sections, the status donut and type treemap, the filterable monitor table and recent
// activity.

import type { DatabaseManager, EventModelDict, MetricModelDict } from "../../core/database/database.ts";
import { STATUS_BADGES, type BadgeTone } from "../../shared/page_view.ts";
import { iso_local } from "../../shared/time.ts";
import { iter_monitors, restates_children } from "../../core/coordination/monitor_graph.ts";
import { fleet_view, type FleetMonitor, type FleetView } from "./fleet.ts";

export const OVERVIEW_STATUS_ORDER = ["online", "info", "failed", "warning", "unavailable"] as const;

// Worst first: a type's tile takes the most severe status among its monitors, so one failed service shows inside a
// type that is otherwise healthy.
export const TYPE_SEVERITY = ["failed", "warning", "unavailable", "info", "online"] as const;

export interface OverviewMonitor extends FleetMonitor {
  target: string;
}

// ── Tallies ──────────────────────────────────────────────────────────────────

// The monitor hierarchy as its monitors, each once however many groups hold it, leaving out plain groups.
export function collect_leaf_monitors<Monitor extends FleetMonitor>(plugins: readonly Monitor[]): Monitor[] {
  return [...iter_monitors(plugins)].filter((plugin) => !restates_children(plugin));
}

// Monitors by status, and per type by status, for the two charts.
export function build_chart_counts(monitors: readonly FleetMonitor[], statuses: Record<string, string>): [Record<string, number>, Record<string, Record<string, number>>] {
  const status_counts: Record<string, number> = { online: 0, info: 0, failed: 0, warning: 0, unavailable: 0 };
  const type_counts: Record<string, Record<string, number>> = {};
  for (const monitor of monitors) {
    const state = statuses[monitor.id] ?? "unavailable";
    status_counts[state] = (status_counts[state] ?? 0) + 1;
    const by_status = (type_counts[String(monitor.config.type ?? "unknown")] ??= {});
    by_status[state] = (by_status[state] ?? 0) + 1;
  }
  return [status_counts, type_counts];
}

// The most severe status present among one type's monitors.
export function type_worst_status(by_status: Record<string, number>): string {
  return TYPE_SEVERITY.find((name) => by_status[name]) ?? "unavailable";
}

export interface TreemapTile {
  name: string;
  value: number;
  status: string;
  breakdown: string;
}

// The treemap's tiles, largest type first so the layout is stable.
export function treemap_tiles(type_counts: Record<string, Record<string, number>>): TreemapTile[] {
  const tiles = Object.entries(type_counts).map(([type, by_status]) => ({
    name: type.toUpperCase(),
    value: Object.values(by_status).reduce((sum, count) => sum + count, 0),
    status: type_worst_status(by_status),
    breakdown: OVERVIEW_STATUS_ORDER.filter((name) => by_status[name]).map((name) => `${by_status[name]} ${name}`).join(", "),
  }));
  return tiles.sort((left, right) => right.value - left.value || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

// ── The monitor table ────────────────────────────────────────────────────────

export interface ChartFilter {
  field: "status" | "type" | null;
  value: string | null;
}

export interface MonitorRow {
  id: string;
  name: string;
  type: string;
  host: string;
  status: string;
  status_key: string;
  status_badge: BadgeTone | "";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// The monitor-table rows, honouring the chart filter.
export function build_table_rows(monitors: readonly OverviewMonitor[], statuses: Record<string, string>, filter: ChartFilter = { field: null, value: null }): MonitorRow[] {
  const rows: MonitorRow[] = [];
  for (const monitor of monitors) {
    const state = statuses[monitor.id] ?? "unavailable";
    const type = String(monitor.config.type ?? "unknown");
    if (filter.field === "status" && state !== filter.value) continue;
    if (filter.field === "type" && type !== filter.value) continue;
    rows.push({ id: monitor.id, name: monitor.name, type: type.toUpperCase(), host: monitor.target, status: capitalize(state), status_key: state, status_badge: STATUS_BADGES[state] ?? "" });
  }
  return rows;
}

// The chart filter after a click on a slice or tile: the same one again clears it.
export function next_chart_filter(filter: ChartFilter, field: "status" | "type", raw_value: string): ChartFilter {
  const value = raw_value.toLowerCase();
  return filter.field === field && filter.value === value ? { field: null, value: null } : { field, value };
}

// ── Recent activity ──────────────────────────────────────────────────────────

function short_time(value: unknown): string {
  if (value instanceof Date) return iso_local(value);
  return String(value ?? "").slice(0, 19).replace("T", " ");
}

// A metric value cut to two decimals, with no trailing zeros, so the column stays narrow.
export function short_value(value: unknown): unknown {
  if (typeof value !== "number") return value ?? null;
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// The raw metric rows with short timestamps and values, as the recent metrics table shows them.
export function metric_rows(rows: readonly (Partial<MetricModelDict> | Record<string, unknown>)[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, timestamp: short_time((row as Record<string, unknown>).timestamp), value: short_value((row as Record<string, unknown>).value) }));
}

// The raw event rows with their timestamps cut to the second.
export function event_rows(rows: readonly (EventModelDict | Record<string, unknown>)[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, timestamp: short_time((row as Record<string, unknown>).timestamp), target: (row as Record<string, unknown>).target ?? "" }));
}

// The recent events table's columns: the message truncates so the table fits its half-width column.
export const RECENT_EVENT_COLUMNS = [
  { name: "timestamp", label: "Time", field: "timestamp", align: "left", sortable: false },
  { name: "level", label: "Level", field: "level", align: "left", sortable: false },
  { name: "target", label: "Host", field: "target", align: "left", sortable: false },
  { name: "message", label: "Message", field: "message", align: "left", classes: "halon-cell-truncate" },
];

// ── The view ─────────────────────────────────────────────────────────────────

export interface OverviewView {
  monitor_count: number;
  lede: string;
  fleet: FleetView | null;
  status_counts: Record<string, number>;
  type_tiles: TreemapTile[];
  monitors: MonitorRow[];
  recent_metrics: Record<string, unknown>[];
  recent_events: Record<string, unknown>[];
}

export function overview_view(engine: { plugins: readonly OverviewMonitor[]; db: DatabaseManager }, now: number = Date.now() / 1000): OverviewView {
  const monitors = collect_leaf_monitors(engine.plugins);
  const statuses = engine.db.latest_statuses();
  const [status_counts, type_counts] = build_chart_counts(monitors, statuses);
  return {
    monitor_count: monitors.length,
    lede: `${monitors.length} monitor${monitors.length === 1 ? "" : "s"}`,
    fleet: fleet_view(engine, now),
    status_counts,
    type_tiles: treemap_tiles(type_counts),
    monitors: build_table_rows(monitors, statuses),
    recent_metrics: metric_rows(engine.db.recent_metrics_raw(20)),
    recent_events: event_rows(engine.db.recent_events_raw(20)),
  };
}
