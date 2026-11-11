// Walking the monitor graph the way the server needs it: every monitor once, parents before children, the groups each
// sits under, and whether a child sits under a parent through a link. These mirror core/coordination/monitor_graph's
// walking helpers over the few fields they read, so the server and its tests need no engine.

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface TreeMonitor {
  id: string;
  name: string;
  children: readonly TreeMonitor[];
  links?: ReadonlyMap<string, string | null> | Record<string, string | null>;
  restates_children?: boolean;
  config?: Record<string, unknown>;
  target?: string;
}

// ── Questions ────────────────────────────────────────────────────────────────

// Whether a monitor's status only repeats its children's, as a plain group's does.
export function restates_children(monitor: { restates_children?: boolean }): boolean {
  return monitor.restates_children === true;
}

function link_label(parent: TreeMonitor, child_id: string): string | null | undefined {
  const links = parent.links;
  if (links === undefined) return undefined;
  if (links instanceof Map) return links.has(child_id) ? (links.get(child_id) ?? null) : undefined;
  return Object.hasOwn(links, child_id) ? ((links as Record<string, string | null>)[child_id] ?? null) : undefined;
}

// Whether the child sits under this parent through a link rather than its own definition.
export function is_link(parent: TreeMonitor, child: TreeMonitor): boolean {
  return link_label(parent, child.id) !== undefined;
}

// The name a child shows under this parent: the link's own label, or the monitor's name.
export function child_label(parent: TreeMonitor, child: TreeMonitor): string {
  return link_label(parent, child.id) || child.name;
}

// ── Walking ──────────────────────────────────────────────────────────────────

// Every monitor reachable from these roots once each, parents before children, in config order.
export function iter_monitors<Monitor extends TreeMonitor>(roots: Iterable<Monitor>): Monitor[] {
  const seen = new Set<TreeMonitor>();
  const found: Monitor[] = [];
  const walk = (monitors: Iterable<TreeMonitor>) => {
    for (const monitor of monitors) {
      if (seen.has(monitor)) continue;
      seen.add(monitor);
      found.push(monitor as Monitor);
      walk(monitor.children);
    }
  };
  walk(roots);
  return found;
}

// The monitor with this id anywhere in the tree, or null.
export function find_monitor<Monitor extends TreeMonitor>(roots: Iterable<Monitor>, monitor_id: string): Monitor | null {
  return iter_monitors(roots).find((monitor) => monitor.id === monitor_id) ?? null;
}

// Each monitor's id mapped to the ids of every group it sits directly under, through a definition or a link.
export function parent_ids(roots: Iterable<TreeMonitor>): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const monitor of iter_monitors(roots)) {
    for (const child of monitor.children) {
      if (!parents.has(child.id)) parents.set(child.id, new Set());
      parents.get(child.id)!.add(monitor.id);
    }
  }
  return parents;
}
