// The slice of XMonitorEngine the page-view builders read, with the Python engine's names, plus the monitor-graph walks
// they share. A builder takes this rather than the engine class so a test can hand it a stand-in.

import type { DispatchResult } from "../../core/connectors/types.ts";
import type { DatabaseManager } from "../../core/database/database.ts";
import type { Plugin } from "../../monitors/base/plugin_base.ts";

// ── Notifications ────────────────────────────────────────────────────────────

export interface MaintenanceWindowLike {
  name: string;
  describe(): string;
}

// The notification manager the mute toggle and the notifications dialog use.
export interface NotificationsLike {
  readonly channels: Record<string, { TYPE: string }> | Map<string, { TYPE: string }>;
  readonly windows: readonly MaintenanceWindowLike[];
  maintenance_for(plugin_id: string): string | null;
  muted_by(plugin_id: string): string | null;
  monitor_name(plugin_id: string): string;
  set_muted(plugin_id: string, muted: boolean): void;
  muted_monitors(): Plugin[];
  active_windows(): readonly MaintenanceWindowLike[];
  send_test(channel_id: string): Promise<void>;
}

// ── Runtime controls ─────────────────────────────────────────────────────────

export interface ReloadResultLike {
  ok: boolean;
  restart_required: boolean;
  summary(): string;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface ViewEngine {
  readonly db: DatabaseManager;
  readonly plugins: readonly Plugin[];
  readonly monitors_version?: number;
  readonly notifications?: NotificationsLike | null;
  dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<DispatchResult>;
  set_setting(key: string, value: string): void;
  log_levels?(): Record<string, string>;
  known_loggers?(): string[];
  set_log_level?(logger: string, level: string | null, source?: string): void;
  reload_config?(source: string): Promise<ReloadResultLike>;
}

// ── The monitor graph ────────────────────────────────────────────────────────

// The parts of a monitor the graph walks read.
export interface GraphNode {
  id: string;
  name: string;
  children: readonly GraphNode[];
  links?: Map<string, string | null> | Record<string, string | null>;
  restates_children?: boolean;
}

// Every monitor reachable from these roots once each, parents before children, in config order.
export function iter_monitors<Node extends GraphNode>(roots: Iterable<Node>): Node[] {
  const seen = new Set<Node>();
  const found: Node[] = [];
  const walk = (nodes: Iterable<Node>): void => {
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      found.push(node);
      walk(node.children as Iterable<Node>);
    }
  };
  walk(roots);
  return found;
}

// The monitor with this id anywhere in the tree, or null.
export function find_monitor<Node extends GraphNode>(engine: { plugins: readonly Node[] }, monitor_id: string | null | undefined): Node | null {
  return iter_monitors(engine.plugins).find((node) => node.id === monitor_id) ?? null;
}

// The name a child shows under this parent: the link's own label, or the monitor's name.
export function child_label(parent: GraphNode | null, child: GraphNode): string {
  const links = parent?.links;
  const label = links instanceof Map ? links.get(child.id) : links?.[child.id];
  return label || child.name;
}

// True when a monitor's status only repeats its children's, as a plain group's does, so it is no monitor of its own.
export function restates_children(monitor: GraphNode): boolean {
  return monitor.restates_children === true;
}

// ── Plugin attributes ────────────────────────────────────────────────────────

// A plugin attribute a spec names, such as `value_attr`; a method is called, a missing one reads as undefined.
export function plugin_attr(plugin: unknown, name: string): unknown {
  const value = (plugin as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as () => unknown).call(plugin) : value;
}
