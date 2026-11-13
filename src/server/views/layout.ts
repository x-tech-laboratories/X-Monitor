// Layout resolution: turns a monitor's declared rows of widgets into the rows of cells its page view carries. Every
// cell is made up front, in declared order, so the page follows the layout rather than the order the builder fills it.

import type { CellConfig, CellView, RowView, WidgetView } from "../../shared/page_view.ts";
import { make_inline_layout, split_item } from "../../monitors/base/child_cards.ts";
import { parse_ref } from "../../monitors/group.ts";
import type { LayoutRow } from "../../shared/ui_spec.ts";

export { make_inline_layout, split_item };

export type ResolvedRow = [name: string, config: CellConfig][];

// ── Rows ─────────────────────────────────────────────────────────────────────

function first_set(...values: unknown[]): unknown {
  return values.find((value) => Boolean(value)) ?? null;
}

// Pure: merges per-widget config overrides onto declared rows, filling defaults; a cell's own property wins.
export function resolve_rows(raw_rows: readonly LayoutRow[], widget_overrides: Record<string, Record<string, unknown>>): ResolvedRow[] {
  return raw_rows.map((row) =>
    row.map((item): [string, CellConfig] => {
      const [name, base] = split_item(item);
      const override = widget_overrides[name] ?? {};
      return [name, {
        flex: Math.trunc(Number(base.flex ?? override.flex ?? 1)),
        visible: Boolean(base.visible ?? override.visible ?? true),
        height: (first_set(base.height, override.height) as string | null),
        min_width: String(first_set(base.min_width, override.min_width) ?? "280px"),
        title: (first_set(base.title, override.title) as string | null),
      }];
    }));
}

// ── A monitor's own grid ─────────────────────────────────────────────────────

// The cells a builder fills, by widget name; `layout` in a monitor's config, when set, is either a full list of rows
// replacing the default ones or a map of per-widget overrides merged onto them.
export class PluginLayout {
  readonly rows: RowView[] = [];
  private readonly cells = new Map<string, CellView>();

  constructor(plugin_config: Record<string, unknown>, default_layout: readonly LayoutRow[]) {
    const user = plugin_config.layout ?? {};
    const [raw_rows, overrides] = Array.isArray(user)
      ? [user as LayoutRow[], {}]
      : [default_layout, (typeof user === "object" && user !== null ? user : {}) as Record<string, Record<string, unknown>>];
    for (const row of resolve_rows(raw_rows, overrides)) {
      const cells = row.map(([name, config]): CellView => ({ widget: name, ...config, content: [] }));
      for (const cell of cells) this.cells.set(cell.widget, cell);
      this.rows.push({ hidden: cells.every((cell) => !cell.visible), cells });
    }
  }

  // Every widget name this layout has a cell for.
  widgets(): string[] {
    return [...this.cells.keys()];
  }

  // The resolved cell properties of one widget, null when it has no cell.
  config_for(widget_name: string): CellConfig | null {
    return this.cells.get(widget_name) ?? null;
  }

  // Whether the layout places this widget at all.
  hosts(widget_name: string): boolean {
    return this.cells.has(widget_name);
  }

  // Whether the builder should make this widget; a plain layout makes all of them, a widget with no cell going nowhere.
  renders(_widget_name: string): boolean {
    return true;
  }

  // The content list of a widget's cell; one with no cell gets a list nothing shows.
  cell(widget_name: string): WidgetView[] {
    return this.cells.get(widget_name)?.content ?? [];
  }
}

// What the spec builder needs of a layout: a monitor's own grid or a child's window onto its group's grid.
export interface LayoutTarget {
  hosts(widget_name: string): boolean;
  renders(widget_name: string): boolean;
  cell(widget_name: string): WidgetView[];
}

// ── A group's grid ───────────────────────────────────────────────────────────

// A group's own grid, whose cells address a descendant's widget as "<child_id>.<widget_name>" so elements of different
// children can share a row; view() hands one child a window onto it in the child's own widget names.
export class CompositeLayout {
  readonly grid: PluginLayout;
  private readonly claimed = new Set<string>();

  constructor(rows: readonly LayoutRow[]) {
    this.grid = new PluginLayout({}, rows);
  }

  // Splits a "child_id.widget" ref; a ref with no dot names a whole child.
  static parse(ref: string): [child_id: string, widget: string | null] {
    return parse_ref(ref);
  }

  // The widget names this grid places for one child, mapped to their cell config.
  widgets_for(child_id: string): Map<string, CellConfig> {
    const found = new Map<string, CellConfig>();
    for (const ref of this.grid.widgets()) {
      const [owner, widget] = CompositeLayout.parse(ref);
      if (owner === child_id && widget !== null) found.set(widget, this.grid.config_for(ref)!);
    }
    return found;
  }

  // Whether the grid places the child whole, by a bare id with no widget suffix.
  hosts_child(child_id: string): boolean {
    return this.grid.hosts(child_id);
  }

  config_for(ref: string): CellConfig | null {
    return this.grid.config_for(ref);
  }

  // Visible refs no descendant ever filled: a misspelled id or widget name.
  unclaimed(): string[] {
    return this.grid.widgets().filter((ref) => !this.claimed.has(ref) && this.grid.config_for(ref)!.visible).sort();
  }

  cell(ref: string): WidgetView[] {
    this.claimed.add(ref);
    return this.grid.cell(ref);
  }

  view(child_id: string): ChildLayoutView {
    return new ChildLayoutView(this, child_id);
  }
}

// One child's window onto a CompositeLayout: it answers in the child's own widget names.
export class ChildLayoutView implements LayoutTarget {
  private readonly composite: CompositeLayout;
  private readonly child_id: string;

  constructor(composite: CompositeLayout, child_id: string) {
    this.composite = composite;
    this.child_id = child_id;
  }

  private ref(widget_name: string): string {
    return `${this.child_id}.${widget_name}`;
  }

  hosts(widget_name: string): boolean {
    return this.composite.grid.hosts(this.ref(widget_name));
  }

  renders(widget_name: string): boolean {
    return this.composite.grid.config_for(this.ref(widget_name))?.visible ?? false;
  }

  cell(widget_name: string): WidgetView[] {
    return this.composite.cell(this.ref(widget_name));
  }
}
