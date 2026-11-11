// The default way any monitor shows the monitors nested under it: one collapsible card per child in a wrapping row,
// each with the child's status dot, drawing the child's own page the first time it opens. Which cards are open is kept
// per parent as a setting, so it survives a page refresh. The cards themselves are drawn in the browser; this holds the
// pure parts both sides share: cell sizing, the open-card state, the inline layout and the cards' data.

import type { LayoutCell, LayoutRow } from "../../shared/ui_spec.ts";
import type { Plugin } from "./plugin_base.ts";

// ── Pure helpers ─────────────────────────────────────────────────────────────

// The flex-cell style string for one child card, from its grid_* config keys.
export function child_cell_style(child_config: Record<string, unknown>, default_min_width: string): string {
  const col_span = Math.trunc(Number(child_config.grid_col_span ?? 1));
  const child_height = child_config.grid_height ?? null;
  const child_min_width = String(child_config.grid_min_width ?? default_min_width);
  let style = `flex: ${col_span} 1 calc(${col_span} * ${child_min_width}); min-width: ${child_min_width};`;
  if (child_height) style += ` height: ${String(child_height)}; overflow-y: auto;`;
  return style;
}

// The name a child shows under this parent: the link's own label, or the monitor's name.
export function child_label(parent: Plugin, child: Plugin): string {
  return parent.links.get(child.id) || child.name;
}

// Every monitor reachable from these roots once each, parents before children, in config order.
export function* iter_monitors(roots: Iterable<Plugin>): Generator<Plugin> {
  const seen = new Set<Plugin>();
  function* walk(plugins: Iterable<Plugin>): Generator<Plugin> {
    for (const plugin of plugins) {
      if (seen.has(plugin)) continue;
      seen.add(plugin);
      yield plugin;
      yield* walk(plugin.children);
    }
  }
  yield* walk(roots);
}

// The widget name and property overrides of one layout entry.
export function split_item(item: LayoutCell): [name: string, overrides: Record<string, unknown>] {
  if (typeof item === "string") return [item, {}];
  const { widget, ...rest } = item;
  return [widget, rest];
}

// A compact layout for embedding a monitor's page inside another's, with the hidden widgets kept but not shown.
export function make_inline_layout(default_layout: readonly LayoutRow[], hidden: readonly string[] = ["host_card", "logs"]): LayoutRow[] {
  return default_layout.map((row) =>
    row.map((item) => {
      const [name, base] = split_item(item);
      return hidden.includes(name) ? { widget: name, ...base, visible: false } : item;
    }),
  );
}

// ── Expansion state ──────────────────────────────────────────────────────────

export function expanded_setting_key(parent: Plugin): string {
  return `group_expanded_${parent.id}`;
}

const expanded_cache = new WeakMap<Plugin, Record<string, boolean>>();

// Which of the parent's child cards are open, read once through its data view and cached on it.
export function expanded(parent: Plugin): Record<string, boolean> {
  let cached = expanded_cache.get(parent);
  if (cached === undefined) {
    const raw = parent.data.get_setting(expanded_setting_key(parent));
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      cached = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, boolean>) : {};
    } catch {
      cached = {};
    }
    expanded_cache.set(parent, cached);
  }
  return cached;
}

// Flips one child card open or shut and keeps the new state as the parent's setting; returns whether it is now open.
export function toggle_expanded(parent: Plugin, child_id: string): boolean {
  const state = expanded(parent);
  state[child_id] = !(state[child_id] ?? false);
  parent.engine!.set_setting(expanded_setting_key(parent), JSON.stringify(state));
  return state[child_id];
}

// ── The cards' data ──────────────────────────────────────────────────────────

// One child card as the page draws it.
export interface ChildCard {
  id: string;
  label: string;
  status: string;
  open: boolean;
  style: string;
  // The child's own page, embedded with its inline layout once the card opens.
  view: "spec" | "custom" | "none";
}

export interface ChildCardsView {
  min_card_width: string;
  cards: ChildCard[];
}

// Everything the browser needs to draw a parent's child cards.
export function child_cards_view(parent: Plugin): ChildCardsView {
  const min_card_width = String(parent.config.grid_min_width ?? "320px");
  const statuses = parent.data.latest_statuses();
  const open = expanded(parent);
  return {
    min_card_width,
    cards: parent.children.map((child) => ({
      id: child.id,
      label: child_label(parent, child),
      status: statuses[child.id] ?? "unavailable",
      open: open[child.id] ?? false,
      style: child_cell_style(child.config, min_card_width),
      view: child.custom_view() !== null ? "custom" : child.UI_SPEC !== null ? "spec" : "none",
    })),
  };
}
