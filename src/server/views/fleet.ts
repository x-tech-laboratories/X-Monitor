// The fleet sections of the overview: a tile per host, reachability strips, backup ages, deployments and vulnerability
// findings. Each section appears only when the fleet has monitors of its kind, and each is built by a pure function
// over monitors and readings.

import { format_age } from "../../monitors/base/plugin_helpers.ts";
import { fill_percent, strip_states, STRIP_CELLS, up_share_text, type StripState } from "../../shared/charts.ts";
import type { DatabaseManager } from "../../core/database/database.ts";
import { iter_monitors, restates_children, type GraphNode } from "./engine.ts";

// ── Which monitors feed which section ────────────────────────────────────────

// The 0/1 metric each reachability monitor type records, which its strip draws.
export const UP_METRICS: Record<string, string> = {
  uptime: "up",
  http: "probe_ok",
  mosquitto: "roundtrip_ok",
  dns_record: "resolved",
  push: "reported_up",
};

export const STATUS_ORDER = ["online", "info", "warning", "failed", "unavailable"] as const;

// Worst first, so a host takes the most severe state among its monitors.
export const STATUS_SEVERITY = ["failed", "warning", "unavailable", "info", "online"] as const;

// A backup meter is full at twice its monitor's max age, so the max age sits at its middle.
export const BACKUP_SCALE = 2.0;

export type LatestMetric = (monitor_id: string, name: string) => number | null;

// A monitor as the fleet sections read it.
export interface FleetMonitor extends GraphNode {
  config: Record<string, unknown>;
  children: readonly FleetMonitor[];
  max_age?: number | null;
}

// The roots of the monitor tree, one host tile each.
export function primary_roots<Monitor>(engine: { plugins: readonly Monitor[] }): Monitor[] {
  return [...engine.plugins];
}

export function monitor_type(monitor: FleetMonitor): string {
  return String(monitor.config.type ?? "unknown");
}

// Every monitor under a root once each, leaving out plain groups, with the names of the parents between them.
export function leaves_with_paths(root: FleetMonitor): [FleetMonitor, string[]][] {
  const found: [FleetMonitor, string[]][] = [];
  const seen = new Set<FleetMonitor>();
  const walk = (node: FleetMonitor, path: string[]): void => {
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

// The most severe of these states, or unavailable when there are none.
export function worst_status(states: readonly string[]): string {
  return STATUS_SEVERITY.find((name) => states.includes(name)) ?? "unavailable";
}

// ── Sections ─────────────────────────────────────────────────────────────────

export interface HostTile {
  id: string;
  name: string;
  state: string;
  caption: string;
  counts: Record<string, number>;
}

// One tile per top-level group: its worst state, how many monitors it holds and how many of them fail or warn.
export function build_host_tiles(roots: readonly FleetMonitor[], statuses: Record<string, string>): HostTile[] {
  return roots.map((root) => {
    const leaf_states = leaves_with_paths(root).map(([leaf]) => statuses[leaf.id] ?? "unavailable");
    const counts = Object.fromEntries(STATUS_ORDER.map((name) => [name, leaf_states.filter((state) => state === name).length]));
    const total = leaf_states.length;
    const trouble = (["failed", "warning"] as const).filter((name) => counts[name]).map((name) => `${counts[name]} ${name}`);
    const caption = [`${total} monitor${total === 1 ? "" : "s"}`, ...trouble].join(" · ");
    return { id: root.id, name: root.name, state: worst_status(leaf_states), caption, counts };
  });
}

export interface StripRow {
  id: string;
  host: string;
  name: string;
  metric: string;
}

// One strip per reachability monitor, in host order, each named by the monitor.
export function build_strip_rows(roots: readonly FleetMonitor[]): StripRow[] {
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

export interface BackupRow {
  id: string;
  label: string;
  value_text: string;
  percent: number;
  state: string;
}

// One meter per borg repository of the time since its newest archive, full at twice the monitor's max age, labelled
// by host and the groups that name the repository.
export function build_backup_rows(roots: readonly FleetMonitor[], statuses: Record<string, string>, latest: LatestMetric, now: number): BackupRow[] {
  const rows: BackupRow[] = [];
  for (const root of roots) {
    for (const [leaf, path] of leaves_with_paths(root)) {
      if (monitor_type(leaf) !== "borg") continue;
      const label = [...path.slice(-1), leaf.name].join(" › ");
      const newest = latest(leaf.id, "last_backup_epoch");
      const max_age = Number(leaf.max_age ?? 86400) || 86400;
      const state = statuses[leaf.id] ?? "unavailable";
      if (newest === null) {
        rows.push({ id: leaf.id, label: `${root.name} · ${label}`, value_text: "No archive yet", percent: 0, state });
        continue;
      }
      const age = Math.max(0, now - newest);
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
export function build_deploy_tiles(roots: readonly FleetMonitor[], statuses: Record<string, string>, latest: LatestMetric): DeployTile[] {
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
export function build_finding_rows(roots: readonly FleetMonitor[], latest: LatestMetric): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const root of roots) {
    for (const [leaf] of leaves_with_paths(root)) {
      if (monitor_type(leaf) !== "vuln_scan") continue;
      const [vulnerable, suspected, noted] = (["vulnerable", "suspected", "noted"] as const).map((name) => latest(leaf.id, name) || 0);
      const ports = latest(leaf.id, "open_ports");
      let text = [vulnerable, suspected, noted].map((count) => String(Math.trunc(count))).join(" · ");
      if (ports !== null) text += ` · ${Math.trunc(ports)} open ports`;
      rows.push({ id: leaf.id, name: root.name, vulnerable, suspected, noted, text });
    }
  }
  return rows;
}

// ── Reading the fleet ────────────────────────────────────────────────────────

export type SectionName = "hosts" | "backups" | "deploys" | "findings";

export interface FleetModel {
  hosts?: HostTile[];
  backups?: BackupRow[];
  deploys?: DeployTile[];
  findings?: FindingRow[];
}

// Every asked section's rows from the latest readings, plus each strip's recent history.
export function read_fleet(engine: { db: Pick<DatabaseManager, "latest_statuses" | "latest_metric" | "metric_history"> }, roots: readonly FleetMonitor[], sections: ReadonlySet<SectionName>, strip_rows: readonly StripRow[], now: number = Date.now() / 1000): [FleetModel, (number | null)[][]] {
  const db = engine.db;
  const statuses = db.latest_statuses();
  const latest: LatestMetric = (monitor_id, name) => db.latest_metric(monitor_id, name)?.value ?? null;
  const builders: Record<SectionName, () => unknown> = {
    hosts: () => build_host_tiles(roots, statuses),
    backups: () => build_backup_rows(roots, statuses, latest, now),
    deploys: () => build_deploy_tiles(roots, statuses, latest),
    findings: () => build_finding_rows(roots, latest),
  };
  const model = Object.fromEntries((Object.keys(builders) as SectionName[]).filter((name) => sections.has(name)).map((name) => [name, builders[name]()])) as FleetModel;
  const histories = strip_rows.map((row) => db.metric_history(row.id, row.metric, STRIP_CELLS).map((record) => record.value));
  return [model, histories];
}

// ── The view ─────────────────────────────────────────────────────────────────

export interface ReachabilityRow extends StripRow {
  states: StripState[];
  share_text: string;
}

export interface FleetView {
  hosts: HostTile[];
  reachability: ReachabilityRow[];
  backups: BackupRow[] | null;
  deploys: DeployTile[] | null;
  findings: FindingRow[] | null;
}

// The fleet sections the overview shows, each null when the fleet has no monitors of its kind.
export function fleet_view(engine: { plugins: readonly FleetMonitor[]; db: Pick<DatabaseManager, "latest_statuses" | "latest_metric" | "metric_history"> }, now: number = Date.now() / 1000): FleetView | null {
  const roots = primary_roots(engine);
  if (roots.length === 0) return null;
  const types = new Set(iter_monitors(roots).map(monitor_type));
  const sections = new Set<SectionName>(["hosts"]);
  if (types.has("borg")) sections.add("backups");
  if (types.has("nixos_upgrade")) sections.add("deploys");
  if (types.has("vuln_scan")) sections.add("findings");
  const strips = build_strip_rows(roots);
  const [model, histories] = read_fleet(engine, roots, sections, strips, now);
  return {
    hosts: model.hosts ?? [],
    reachability: strips.map((row, index) => {
      const states = strip_states(histories[index]);
      return { ...row, states, share_text: up_share_text(states) };
    }),
    backups: model.backups ?? null,
    deploys: model.deploys ?? null,
    findings: model.findings ?? null,
  };
}
