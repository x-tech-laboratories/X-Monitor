// The sidebar: the fixed views, then the monitor tree with live status dots, its expand, collapse, expand-failed and
// accordion tools, and the open branches kept on the server so they survive a reload.

import { Tree, type TreeItem } from "@x-tech-laboratories/x-libs/web/react/tree";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useState } from "react";

import type { SidebarSettings, TreeNode } from "../api.ts";
import { StatusDot } from "../ui.tsx";

export interface TreeRowItem extends TreeItem {
  monitor: string;
  label: string;
  state: string;
  has_children: boolean;
}

// ── Pure ─────────────────────────────────────────────────────────────────────

// The nested nodes as the flat rows the tree draws, each under its parent's key in config order.
export function tree_items(nodes: readonly TreeNode[], parent_id: string | null = null): TreeRowItem[] {
  return nodes.flatMap((node, position) => [
    { id: node.id, parent_id, position, monitor: node.monitor, label: node.label, state: node.state, has_children: Boolean(node.children?.length) },
    ...tree_items(node.children ?? [], node.id),
  ]);
}

// The ids of every node that has children, depth first.
export function branch_ids(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => (node.children?.length ? [node.id, ...branch_ids(node.children)] : []));
}

// The ids of every branch that holds a failed monitor somewhere beneath it.
export function failed_branch_ids(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => {
    const children = node.children ?? [];
    if (children.length === 0) return [];
    const below = failed_branch_ids(children);
    return below.length > 0 || children.some((child) => child.state === "failed") ? [node.id, ...below] : [];
  });
}

export function monitor_for_key(nodes: readonly TreeNode[], key: string): string | null {
  for (const node of nodes) {
    if (node.id === key) return node.monitor;
    const found = monitor_for_key(node.children ?? [], key);
    if (found) return found;
  }
  return null;
}

export function first_key_for(nodes: readonly TreeNode[], monitor_id: string): string | null {
  for (const node of nodes) {
    if (node.monitor === monitor_id) return node.id;
    const found = first_key_for(node.children ?? [], monitor_id);
    if (found) return found;
  }
  return null;
}

// The branches newly opened, with their siblings shut when only one sibling branch may be open at a time.
export function expanded_after(items: readonly TreeRowItem[], before: readonly string[], opened_now: readonly string[], accordion: boolean): string[] {
  if (!accordion) return [...opened_now];
  const newly = opened_now.filter((id) => !before.includes(id));
  const parents = new Map(items.map((item) => [item.id, item.parent_id]));
  return opened_now.filter((id) => newly.includes(id) || !newly.some((opened) => opened !== id && parents.get(opened) === parents.get(id)));
}

// ── The tree ─────────────────────────────────────────────────────────────────

export function MonitorTree({ nodes, settings, monitor_id, on_settings }: { nodes: TreeNode[]; settings: SidebarSettings; monitor_id: string | null; on_settings: (changes: Partial<SidebarSettings>) => void }) {
  const items = tree_items(nodes);
  const branches = items.filter((item) => item.has_children).map((item) => item.id);
  const [expanded, set_expanded] = useState<string[]>(settings.expanded);
  const [accordion, set_accordion] = useState(settings.accordion);
  const [clicked, set_clicked] = useState<string | null>(null);
  useEffect(() => set_expanded(settings.expanded), [settings.expanded.join("\n")]);

  const keep = (next: string[]) => {
    set_expanded(next);
    on_settings({ expanded: next });
  };

  // A monitor can sit under several groups; the row that was clicked keeps the mark while it shows that monitor.
  const selected = monitor_id === null ? null : clicked && monitor_for_key(nodes, clicked) === monitor_id ? clicked : first_key_for(nodes, monitor_id);
  const collapsed = new Set(branches.filter((id) => !expanded.includes(id)));

  return (
    <div className="monitor-tree">
      <div className="tree-tools">
        <span className="tile-label">Monitors</span>
        <span className="button-row">
          <button type="button" className="flat" title="Expand all" onClick={() => keep(branch_ids(nodes))}>Expand all</button>
          <button type="button" className="flat" title="Collapse all" onClick={() => keep([])}>Collapse all</button>
          <button type="button" className="flat" title="Expand failed" onClick={() => keep(failed_branch_ids(nodes))}>Expand failed</button>
          <button type="button" className={accordion ? "flat active" : "flat"} aria-pressed={accordion} title="Accordion mode" onClick={() => { set_accordion(!accordion); on_settings({ accordion: !accordion }); }}>Accordion mode</button>
        </span>
      </div>
      <Tree<TreeRowItem>
        label="Monitors"
        items={items}
        collapsed={collapsed}
        on_collapsed_change={(now_collapsed) => keep(expanded_after(items, expanded, branches.filter((id) => !now_collapsed.has(id)), accordion))}
        selected_id={selected}
        name_of={(item) => item.label}
        on_select={(item) => {
          set_clicked(item.id);
          location.hash = link(["monitor", item.monitor]);
        }}
        render_item={(item) => <span className="tree-name"><StatusDot state={item.state} /> {item.label}</span>}
        allow_inside={false}
        can_drop={() => false}
      />
    </div>
  );
}
