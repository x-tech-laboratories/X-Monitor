// The sidebar's monitor tree and the settings it keeps: its width, which branches are open, and whether only one
// sibling branch opens at a time. A monitor linked under several groups appears once per place, so each node's key is
// its path of ids from the root, and `monitor` names the monitor it shows.

import { status_of, type Status } from "../../shared/status.ts";
import { child_label, type GraphNode } from "./engine.ts";

export interface TreeNode {
  id: string;
  monitor: string;
  label: string;
  state: Status;
  children?: TreeNode[];
}

// ── Nodes ────────────────────────────────────────────────────────────────────

// The tree's nodes for the monitor hierarchy, each with its monitor's status.
export function build_tree_nodes(plugins: readonly GraphNode[], statuses: Record<string, string>, parent: GraphNode | null = null, path = ""): TreeNode[] {
  return plugins.map((plugin) => {
    const key = path ? `${path}/${plugin.id}` : plugin.id;
    const node: TreeNode = { id: key, monitor: plugin.id, label: child_label(parent, plugin), state: status_of(statuses[plugin.id] ?? "unavailable") };
    if (plugin.children.length > 0) node.children = build_tree_nodes(plugin.children, statuses, plugin, key);
    return node;
  });
}

// The ids of every node that has children, depth first.
export function branch_ids(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => (node.children?.length ? [node.id, ...branch_ids(node.children)] : []));
}

// The ids of every branch that holds a failed monitor somewhere beneath it.
export function failed_branch_ids(nodes: readonly TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    const children = node.children ?? [];
    if (children.length === 0) continue;
    const below = failed_branch_ids(children);
    if (below.length > 0 || children.some((child) => child.state === "failed")) ids.push(node.id, ...below);
  }
  return ids;
}

// The monitor id a tree node key points at, or null.
export function monitor_for_key(nodes: readonly TreeNode[], key: string): string | null {
  for (const node of nodes) {
    if (node.id === key) return node.monitor;
    const found = monitor_for_key(node.children ?? [], key);
    if (found) return found;
  }
  return null;
}

// The key of the first tree node that shows this monitor, depth first, or null.
export function first_key_for(nodes: readonly TreeNode[], monitor_id: string): string | null {
  for (const node of nodes) {
    if (node.monitor === monitor_id) return node.id;
    const found = first_key_for(node.children ?? [], monitor_id);
    if (found) return found;
  }
  return null;
}

// The node marked as where the viewer is: the clicked one while it still shows the monitor, else the first place it
// appears; none when a fixed view is shown.
export function selected_key(nodes: readonly TreeNode[], current_view: string, monitor_id: string | null, clicked: string | null): string | null {
  if (current_view !== "plugin" || monitor_id === null) return null;
  if (clicked && monitor_for_key(nodes, clicked) === monitor_id) return clicked;
  return first_key_for(nodes, monitor_id);
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface SidebarSettings {
  drawer_width: number;
  expanded: string[];
  accordion: boolean;
}

interface SettingsStore {
  get_setting(key: string, fallback?: string | null): string | null;
}

// The persisted drawer width, expanded keys and accordion mode, each falling back to its default.
export function sidebar_settings(db: SettingsStore): SidebarSettings {
  const width = Number.parseInt(db.get_setting("drawer_width") || "248", 10);
  let expanded: string[] = [];
  try {
    const parsed: unknown = JSON.parse(db.get_setting("tree_expanded") || "[]");
    if (Array.isArray(parsed)) expanded = parsed.map(String);
  } catch {
    expanded = [];
  }
  return { drawer_width: Number.isNaN(width) ? 248 : width, expanded, accordion: db.get_setting("tree_accordion") === "1" };
}

// Keeps whichever of the sidebar settings the page changed.
export function save_sidebar_settings(engine: { set_setting(key: string, value: string): void }, changes: Partial<SidebarSettings>): void {
  if (changes.drawer_width !== undefined) engine.set_setting("drawer_width", String(Math.trunc(changes.drawer_width)));
  if (changes.expanded !== undefined) engine.set_setting("tree_expanded", JSON.stringify(changes.expanded));
  if (changes.accordion !== undefined) engine.set_setting("tree_accordion", changes.accordion ? "1" : "");
}

export interface SidebarView {
  nodes: TreeNode[];
  settings: SidebarSettings;
}

export function sidebar_view(engine: { plugins: readonly GraphNode[]; db: SettingsStore & { latest_statuses(): Record<string, string> } }): SidebarView {
  return { nodes: build_tree_nodes(engine.plugins, engine.db.latest_statuses()), settings: sidebar_settings(engine.db) };
}
