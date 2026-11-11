// The data behind each of the dashboard's views, built by pure functions over the monitors and their readings so the
// page only draws: the sidebar's tree, the overview's tallies and table, the fleet sections and the schedules table.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DatabaseManager } from "../core/database/database.ts";
import { format_age } from "../monitors/base/plugin_helpers.ts";
import { child_label, iter_monitors, restates_children } from "./monitor_tree.ts";
import type { ServerPlugin } from "./engine_api.ts";

// ── Statuses ─────────────────────────────────────────────────────────────────

export const STATUS_ORDER = ["online", "info", "warning", "failed", "unavailable"] as const;
// Worst first, so a host takes the most severe state among its monitors.
export const STATUS_SEVERITY = ["failed", "warning", "unavailable", "info", "online"] as const;

// The most severe of these states, or unavailable when there are none.
export function worst_status(states: string[]): string {
  return STATUS_SEVERITY.find((name) => states.includes(name)) ?? "unavailable";
}

export function monitor_type(monitor: ServerPlugin): string {
  return String(monitor.config?.type ?? "unknown");
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

export interface TreeNode {
  // The path of ids from the root, since a linked monitor appears once per place.
  id: string;
  monitor: string;
  label: string;
  status: string;
  children?: TreeNode[];
}

export function build_tree_nodes(plugins: readonly ServerPlugin[], statuses: Record<string, string>, parent: ServerPlugin | null = null, path = ""): TreeNode[] {
  return plugins.map((plugin) => {
    const key = path ? `${path}/${plugin.id}` : plugin.id;
    const node: TreeNode = { id: key, monitor: plugin.id, label: parent === null ? plugin.name : child_label(parent, plugin), status: statuses[plugin.id] ?? "unavailable" };
    if (plugin.children.length > 0) node.children = build_tree_nodes(plugin.children, statuses, plugin, key);
    return node;
  });
}

// The ids of every branch that holds a failed monitor somewhere beneath it.
export function failed_branch_ids(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    const children = node.children ?? [];
    if (children.length === 0) continue;
    const below = failed_branch_ids(children);
    if (below.length > 0 || children.some((child) => child.status === "failed")) ids.push(node.id, ...below);
  }
  return ids;
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface MonitorRow {
  id: string;
  name: string;
  type: string;
  host: string;
  status: string;
}

export interface TypeTile {
  name: string;
  value: number;
  status: string;
  breakdown: string;
}

// The monitors, each once, leaving out plain groups, with the tallies the two charts draw.
export function build_overview(plugins: readonly ServerPlugin[], statuses: Record<string, string>): { monitors: MonitorRow[]; status_counts: Record<string, number>; type_tiles: TypeTile[] } {
  const monitors = iter_monitors(plugins).filter((plugin) => !restates_children(plugin));
  const status_counts: Record<string, number> = { online: 0, info: 0, failed: 0, warning: 0, unavailable: 0 };
  const type_counts = new Map<string, Record<string, number>>();
  const rows = monitors.map((monitor) => {
    const status = statuses[monitor.id] ?? "unavailable";
    status_counts[status] = (status_counts[status] ?? 0) + 1;
    const type = monitor_type(monitor);
    const by_status = type_counts.get(type) ?? {};
    type_counts.set(type, by_status);
    by_status[status] = (by_status[status] ?? 0) + 1;
    return { id: monitor.id, name: monitor.name, type, host: monitor.target, status };
  });
  const type_tiles = [...type_counts].map(([type, by_status]) => ({
    name: type.toUpperCase(),
    value: Object.values(by_status).reduce((sum, count) => sum + count, 0),
    status: STATUS_SEVERITY.find((name) => by_status[name]) ?? "unavailable",
    breakdown: STATUS_ORDER.filter((name) => by_status[name]).map((name) => `${by_status[name]} ${name}`).join(", "),
  }));
  type_tiles.sort((first, second) => second.value - first.value || (first.name < second.name ? -1 : first.name > second.name ? 1 : 0));
  return { monitors: rows, status_counts, type_tiles };
}

// ── Fleet ────────────────────────────────────────────────────────────────────

// The 0/1 metric each reachability monitor type records, which its strip draws.
export const UP_METRICS: Record<string, string> = { uptime: "up", http: "probe_ok", mosquitto: "roundtrip_ok", dns_record: "resolved", push: "reported_up" };

// A backup meter is full at twice its monitor's max age, so the max age sits at its middle.
export const BACKUP_SCALE = 2.0;
// How many readings a reachability strip shows.
export const STRIP_CELLS = 60;

type LatestMetric = (monitor_id: string, name: string) => number | null;

// Every monitor under a root once each, leaving out plain groups, with the names of the parents between them.
export function leaves_with_paths(root: ServerPlugin): [ServerPlugin, string[]][] {
  const found: [ServerPlugin, string[]][] = [];
  const seen = new Set<ServerPlugin>();
  const walk = (node: ServerPlugin, path: string[]) => {
    for (const child of node.children) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (!restates_children(child)) found.push([child, path]);
      walk(child, [...path, child.name]);
    }
  };
  if (!restates_children(root)) found.push([root, []]);
  walk(root, []);
  return found;
}

export interface HostTile {
  id: string;
  name: string;
  state: string;
  caption: string;
  counts: Record<string, number>;
}

// One tile per top-level group: its worst state, how many monitors it holds and how many of them are failing or warning.
export function build_host_tiles(roots: readonly ServerPlugin[], statuses: Record<string, string>): HostTile[] {
  return roots.map((root) => {
    const states = leaves_with_paths(root).map(([leaf]) => statuses[leaf.id] ?? "unavailable");
    const counts = Object.fromEntries(STATUS_ORDER.map((name) => [name, states.filter((state) => state === name).length]));
    const total = states.length;
    const trouble = (["failed", "warning"] as const).filter((name) => counts[name]).map((name) => `${counts[name]} ${name}`);
    return { id: root.id, name: root.name, state: worst_status(states), caption: [`${total} monitor${total === 1 ? "" : "s"}`, ...trouble].join(" · "), counts };
  });
}

export interface StripRow {
  id: string;
  host: string;
  name: string;
  metric: string;
}

// One strip per reachability monitor, in host order, each named by the monitor.
export function build_strip_rows(roots: readonly ServerPlugin[]): StripRow[] {
  const rows: StripRow[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const [leaf] of leaves_with_paths(root)) {
      const metric = UP_METRICS[monitor_type(leaf)];
      if (metric && !seen.has(leaf.id)) {
        seen.add(leaf.id);
        rows.push({ id: leaf.id, host: root.name, name: leaf.name, metric });
      }
    }
  }
  return rows;
}

// How full a bar or gauge is, as a percentage clamped to 0-100; no reading is empty.
export function fill_percent(value: number | null, maximum = 100.0): number {
  if (value === null || !maximum) return 0.0;
  return Math.max(0.0, Math.min(100.0, (value / maximum) * 100.0));
}

export interface BackupRow {
  id: string;
  label: string;
  value_text: string;
  percent: number;
  state: string;
}

// One meter per borg repository of the time since its newest archive, full at twice the monitor's max age.
export function build_backup_rows(roots: readonly ServerPlugin[], statuses: Record<string, string>, latest: LatestMetric, now: number): BackupRow[] {
  const rows: BackupRow[] = [];
  for (const root of roots) {
    for (const [leaf, path] of leaves_with_paths(root)) {
      if (monitor_type(leaf) !== "borg") continue;
      const label = [...path.slice(-1), leaf.name].join(" › ");
      const newest = latest(leaf.id, "last_backup_epoch");
      const max_age = Number(leaf.max_age ?? 86400) || 86400;
      const state = statuses[leaf.id] ?? "unavailable";
      if (newest === null) {
        rows.push({ id: leaf.id, label: `${root.name} · ${label}`, value_text: "No archive yet", percent: 0.0, state });
        continue;
      }
      const age = Math.max(0.0, now - newest);
      rows.push({ id: leaf.id, label: `${root.name} · ${label}`, value_text: format_age(Math.trunc(age)), percent: fill_percent(age, max_age * BACKUP_SCALE), state });
    }
  }
  return rows;
}

export interface DeployTile {
  id: string;
  name: string;
  state: string;
  caption: string;
}

// One tile per NixOS deployment: its generation and whether it is in sync, drifting or waiting on a reboot.
export function build_deploy_tiles(roots: readonly ServerPlugin[], statuses: Record<string, string>, latest: LatestMetric): DeployTile[] {
  const tiles: DeployTile[] = [];
  for (const root of roots) {
    for (const [leaf] of leaves_with_paths(root)) {
      if (monitor_type(leaf) !== "nixos_upgrade") continue;
      const generation = latest(leaf.id, "generation");
      const parts = generation !== null ? [`gen ${Math.trunc(generation)}`] : [];
      if (latest(leaf.id, "reboot_required")) parts.push("reboot pending");
      const up_to_date = latest(leaf.id, "up_to_date");
      if (up_to_date !== null) parts.push(up_to_date ? "in sync" : "drift");
      tiles.push({ id: leaf.id, name: leaf.name, state: statuses[leaf.id] ?? "unavailable", caption: parts.join(" · ") || "not checked yet" });
    }
  }
  return tiles;
}

export interface FindingRow {
  id: string;
  name: string;
  vulnerable: number;
  suspected: number;
  noted: number;
  text: string;
}

// One bar per vulnerability scan, split into vulnerable, likely and noted findings.
export function build_finding_rows(roots: readonly ServerPlugin[], latest: LatestMetric): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const root of roots) {
    for (const [leaf] of leaves_with_paths(root)) {
      if (monitor_type(leaf) !== "vuln_scan") continue;
      const [vulnerable, suspected, noted] = ["vulnerable", "suspected", "noted"].map((name) => latest(leaf.id, name) || 0.0) as [number, number, number];
      const ports = latest(leaf.id, "open_ports");
      let text = [vulnerable, suspected, noted].map((count) => String(Math.trunc(count))).join(" · ");
      if (ports !== null) text += ` · ${Math.trunc(ports)} open ports`;
      rows.push({ id: leaf.id, name: root.name, vulnerable, suspected, noted, text });
    }
  }
  return rows;
}

export interface Fleet {
  // The sections the fleet has monitors for.
  sections: string[];
  hosts: HostTile[];
  strips: (StripRow & { history: (number | null)[] })[];
  backups: BackupRow[];
  deploys: DeployTile[];
  findings: FindingRow[];
}

// Every fleet section from the latest readings, with each reachability strip's recent history.
export function read_fleet(roots: readonly ServerPlugin[], db: DatabaseManager, now: number = Date.now() / 1000): Fleet {
  const statuses = db.latest_statuses();
  const latest: LatestMetric = (monitor_id, name) => db.latest_metric(monitor_id, name)?.value ?? null;
  const types = new Set(roots.flatMap((root) => leaves_with_paths(root).map(([leaf]) => monitor_type(leaf))));
  const strip_rows = build_strip_rows(roots);
  const sections = ["hosts"];
  if (strip_rows.length > 0) sections.push("strips");
  if (types.has("borg")) sections.push("backups");
  if (types.has("nixos_upgrade")) sections.push("deploys");
  if (types.has("vuln_scan")) sections.push("findings");
  return {
    sections,
    hosts: build_host_tiles(roots, statuses),
    strips: strip_rows.map((row) => ({ ...row, history: db.metric_history(row.id, row.metric, STRIP_CELLS).map((record) => record.value) })),
    backups: types.has("borg") ? build_backup_rows(roots, statuses, latest, now) : [],
    deploys: types.has("nixos_upgrade") ? build_deploy_tiles(roots, statuses, latest) : [],
    findings: types.has("vuln_scan") ? build_finding_rows(roots, latest) : [],
  };
}

// ── Schedules ────────────────────────────────────────────────────────────────

interface ScheduleEntry {
  action: string;
  args: Record<string, unknown>;
  result_key(plugin_id: string): string;
}

interface CronEntry extends ScheduleEntry {
  cron: { expression: string; next_after(moment: Date): Date | null };
}

interface TriggerEntry extends ScheduleEntry {
  describe(): string;
}

interface ActionSpecLike {
  action_id: string;
  name?: string;
  kind?: string;
  on_action_id?: string;
  off_action_id?: string;
}

// Each action id mapped to the label a person sees for it; a toggle's two ids get its name plus on or off.
export function action_names(actions: readonly ActionSpecLike[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const action of actions) {
    if (action.kind === "toggle") {
      names[action.on_action_id!] = `${action.name}: on`;
      names[action.off_action_id!] = `${action.name}: off`;
    } else {
      names[action.action_id] = action.name ?? action.action_id;
    }
  }
  return names;
}

// The action as its button names it, or its id in words, followed by any arguments the schedule passes.
function action_label(names: Record<string, string>, action: string, args: Record<string, unknown>): string {
  let label = names[action] || (action.replaceAll("_", " ").charAt(0).toUpperCase() + action.replaceAll("_", " ").slice(1).toLowerCase());
  const keys = Object.keys(args).sort();
  if (keys.length > 0) label += ` (${keys.map((key) => `${key}: ${python_text(args[key])}`).join(", ")})`;
  return label;
}

function python_text(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

const day_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");

// A time as "Wed 21 Oct 02:30".
export function when_text(moment: Date): string {
  return `${day_names[moment.getDay()]} ${two(moment.getDate())} ${month_names[moment.getMonth()]} ${two(moment.getHours())}:${two(moment.getMinutes())}`;
}

function last_run_cells(raw: string | null): { last: string; outcome: string; message: string } {
  let record: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) record = parsed;
  } catch {
    record = {};
  }
  const ran = Number(record.at) || 0;
  return {
    last: ran ? when_text(new Date(ran * 1000)) : "not yet",
    outcome: ran ? (record.ok ? "Started" : "Failed") : "",
    message: String(record.message ?? ""),
  };
}

export interface ScheduleRow {
  id: string;
  monitor_id: string;
  monitor: string;
  action: string;
  cron: string;
  next: string;
  // Null for never or on an event, which sort last.
  next_epoch: number | null;
  last: string;
  outcome: string;
  message: string;
}

// One row per scheduled or triggered action anywhere under the roots, soonest next run first and triggered ones last.
export function schedule_rows(roots: readonly ServerPlugin[], get_setting: (key: string) => string | null, now: Date): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const seen = new Set<ServerPlugin>();
  const walk = (plugins: readonly ServerPlugin[], path: string[]) => {
    for (const plugin of plugins) {
      if (seen.has(plugin)) continue;
      seen.add(plugin);
      const here = [...path, plugin.name];
      add_rows(plugin, here.join(" › "));
      walk(plugin.children ?? [], here);
    }
  };
  const add_rows = (plugin: ServerPlugin, path: string) => {
    const entries = (plugin.scheduled_actions as CronEntry[] | undefined) ?? [];
    const triggered = (plugin.triggered_actions as TriggerEntry[] | undefined) ?? [];
    if (entries.length === 0 && triggered.length === 0) return;
    const names = action_names((plugin.all_actions?.() ?? []) as ActionSpecLike[]);
    entries.forEach((entry, index) => {
      const upcoming = entry.cron.next_after(now);
      rows.push({
        id: `${plugin.id}:${index}`, monitor_id: plugin.id, monitor: path, action: action_label(names, entry.action, entry.args ?? {}),
        cron: entry.cron.expression, next: upcoming ? when_text(upcoming) : "never", next_epoch: upcoming ? upcoming.getTime() / 1000 : null,
        ...last_run_cells(get_setting(entry.result_key(plugin.id))),
      });
    });
    triggered.forEach((entry, index) => {
      const described = entry.describe();
      rows.push({
        id: `${plugin.id}:trigger:${index}`, monitor_id: plugin.id, monitor: path, action: action_label(names, entry.action, entry.args ?? {}),
        cron: described.charAt(0).toUpperCase() + described.slice(1).toLowerCase(), next: "on that event", next_epoch: null,
        ...last_run_cells(get_setting(entry.result_key(plugin.id))),
      });
    });
  };
  walk(roots, []);
  rows.sort((first, second) => {
    const first_next = first.next_epoch ?? Infinity;
    const second_next = second.next_epoch ?? Infinity;
    if (first_next !== second_next) return first_next - second_next;
    const first_monitor = first.monitor.toLowerCase();
    const second_monitor = second.monitor.toLowerCase();
    return first_monitor < second_monitor ? -1 : first_monitor > second_monitor ? 1 : 0;
  });
  return rows;
}
