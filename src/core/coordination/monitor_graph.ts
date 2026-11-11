// The monitor graph: monitors and groups form a DAG rather than a strict tree. A monitor is defined once, under the
// group its config nests it in, and any other group can also hold it through a link, a `ref:` entry naming its id, so
// one monitor can sit at several points of the tree. A link may carry its own `name`, which labels that edge only.

import { python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { create_logger_for } from "../logging.ts";

const log = create_logger_for("x_monitor.core.coordination.monitor_graph");

// ── Graph pieces ─────────────────────────────────────────────────────────────

// What the graph needs of a monitor.
export interface GraphNode {
  readonly id: string;
  readonly name: string;
  children: GraphNode[];
  links: Map<string, string | null>;
  readonly restates_children?: boolean;
}

// What walking and labelling read of a monitor: a GraphNode, or any stand-in with the same few fields, its links as a
// Map or a plain object.
export interface GraphView {
  readonly id: string;
  readonly name: string;
  readonly children: readonly GraphView[];
  readonly links?: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>;
  readonly restates_children?: boolean;
}

// The label a link gives this child under the parent: undefined when the child is not linked there.
function link_label(parent: GraphView, child_id: string): string | null | undefined {
  const links = parent.links;
  if (links === undefined) return undefined;
  if (links instanceof Map) return links.has(child_id) ? (links.get(child_id) ?? null) : undefined;
  const record = links as Readonly<Record<string, string | null>>;
  return Object.hasOwn(record, child_id) ? (record[child_id] ?? null) : undefined;
}

// A placeholder for a `ref:` entry, replaced by the monitor it names once every view has loaded.
export class Link {
  readonly ref: string;
  readonly label: string | null;
  readonly children: never[] = [];

  constructor(ref: string, label: string | null = null) {
    this.ref = ref;
    this.label = label;
  }
}

// The name a child shows under this parent: the link's own label, or the monitor's name.
export function child_label(parent: GraphView | null, child: GraphView): string {
  return (parent === null ? undefined : link_label(parent, child.id)) || child.name;
}

// Whether a monitor's status only repeats its children's, as a plain group's does.
export function restates_children(monitor: { readonly restates_children?: boolean }): boolean {
  return monitor.restates_children === true;
}

// Whether the child sits under this parent through a link rather than its own definition.
export function is_link(parent: GraphView, child: GraphView): boolean {
  return link_label(parent, child.id) !== undefined;
}

// ── Walking ──────────────────────────────────────────────────────────────────

// Every monitor reachable from these roots once each, parents before children, in config order.
export function* iter_monitors<Node extends GraphView>(roots: Iterable<Node>): Generator<Node> {
  const seen = new Set<Node>();
  function* walk(plugins: Iterable<Node>): Generator<Node> {
    for (const plugin of plugins) {
      if (seen.has(plugin)) continue;
      seen.add(plugin);
      yield plugin;
      yield* walk(plugin.children as Node[]);
    }
  }
  yield* walk(roots);
}

export function all_monitors<Node extends GraphView>(engine: { plugins: readonly Node[] }): Node[] {
  return [...iter_monitors(engine.plugins)];
}

// The monitor with this id anywhere in the tree, or null.
export function find_monitor<Node extends GraphView>(engine: { plugins: readonly Node[] }, monitor_id: string | null | undefined): Node | null {
  for (const plugin of iter_monitors(engine.plugins)) if (plugin.id === monitor_id) return plugin;
  return null;
}

// Each monitor's id mapped to the ids of every group it sits directly under, through a definition or a link.
export function parent_ids(roots: Iterable<GraphView>): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const plugin of iter_monitors(roots)) {
    for (const child of plugin.children) {
      const set = parents.get(child.id) ?? new Set<string>();
      set.add(plugin.id);
      parents.set(child.id, set);
    }
  }
  return parents;
}

// ── Resolving links ──────────────────────────────────────────────────────────

type Entry = GraphNode | Link;

// Every monitor defined in the tree, reached through definitions only, once each.
function definitions(roots: Entry[]): GraphNode[] {
  const found: GraphNode[] = [];
  const seen = new Set<GraphNode>();
  const stack: Entry[] = [...roots].reverse();
  while (stack.length > 0) {
    const plugin = stack.pop()!;
    if (plugin instanceof Link || seen.has(plugin)) continue;
    seen.add(plugin);
    found.push(plugin);
    stack.push(...[...(plugin.children as Entry[])].reverse());
  }
  return found;
}

// Whether goal is start itself or sits anywhere beneath it.
function reaches(start: GraphNode, goal: GraphNode): boolean {
  const stack: GraphNode[] = [start];
  const seen = new Set<GraphNode>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === goal) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(node.children as Entry[]).filter((child): child is GraphNode => !(child instanceof Link)));
  }
  return false;
}

// Swaps each link under this owner for the monitor it names, dropping a link to an unknown id or one making a cycle.
function resolve_owner(owner: GraphNode, registry: Map<string, GraphNode>, where: string): void {
  const resolved: GraphNode[] = [];
  const children = [...(owner.children as Entry[])];
  children.forEach((child, position) => {
    if (!(child instanceof Link)) {
      resolved.push(child);
    } else {
      const target = registry.get(child.ref);
      if (target === undefined) {
        log.error(`${where}: link to unknown monitor id ${python_repr(child.ref)} ignored`);
      } else if (reaches(target, owner)) {
        log.error(`${where}: link to ${python_repr(child.ref)} would make a cycle and is ignored`);
      } else {
        resolved.push(target);
        owner.links.set(target.id, child.label);
      }
    }
    // Later links' cycle checks must see the links accepted so far.
    owner.children = [...resolved, ...(children.slice(position + 1) as GraphNode[])];
  });
  owner.children = resolved;
}

// Replaces every link in the tree with the monitor it names, keeping it acyclic; a top-level link has no group to sit
// in, so it is dropped.
export function resolve_links<Node extends GraphNode>(roots: (Node | Link)[]): Node[] {
  for (const link of roots.filter((root): root is Link => root instanceof Link)) {
    log.error(`top-level link to ${python_repr(link.ref)} ignored: a link must sit inside a group`);
  }
  const kept = roots.filter((root): root is Node => !(root instanceof Link));
  const defined = definitions(kept);
  const registry = new Map<string, GraphNode>();
  for (const plugin of defined) if (!registry.has(plugin.id)) registry.set(plugin.id, plugin);
  for (const owner of defined) {
    if ((owner.children as Entry[]).some((child) => child instanceof Link)) resolve_owner(owner, registry, `group ${python_repr(owner.id)}`);
  }
  return kept;
}
