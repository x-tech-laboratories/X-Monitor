// A container monitor that folds its child monitors' statuses into its own. It issues no requests of its own: each cycle
// it re-reads the children's latest statuses from the read-only data view, counting a child with no status yet as
// unavailable, and combines them by its `aggregate` rule (worst child by default; best child; or online while a quorum
// of children is healthy). A poll of the group from the dashboard polls every descendant first, then folds their fresh
// statuses. Config: aggregate, layout (compose individual descendant widgets into the group's own grid) plus the
// grid_min_width default and the per-child grid_* sizing keys; without a layout it shows one collapsible card per child.

import { CollectResult, type Result } from "../core/connectors/types.ts";
import { create_logger_for } from "../core/logging.ts";
import { best_status, log_level_of, status_of, worst_status, type Status } from "../shared/status.ts";
import type { LayoutCell, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { child_cards_view, child_label, iter_monitors, split_item, type ChildCardsView } from "./base/child_cards.ts";
import { Plugin, type CustomView } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { int_or_null } from "./base/text_parsing.ts";

const log = create_logger_for("x_monitor.plugins.group");

// Group-provided pseudo-widget: a status card for a child that has none of its own.
export const STATUS_WIDGET = "status";

export const WORST = "worst";
export const BEST = "best";
export const QUORUM = "quorum";

export type AggregateRule = typeof WORST | typeof BEST | typeof QUORUM;

// The child statuses that count toward a quorum.
const healthy_statuses: readonly Status[] = ["online", "info"];

// ── Aggregation ──────────────────────────────────────────────────────────────

// The `aggregate` setting as [rule, quorum size], reading anything unrecognised as worst.
export function parse_aggregate(value: unknown): [rule: AggregateRule, quorum: number] {
  if (value === null || value === undefined || value === WORST) return [WORST, 0];
  if (value === BEST) return [BEST, 0];
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && QUORUM in value) {
    const raw = (value as Record<string, unknown>)[QUORUM];
    const size = typeof raw === "boolean" ? Number(raw) : (int_or_null(raw) ?? 0);
    if (size >= 1) return [QUORUM, size];
  }
  log.error(`aggregate: expected worst, best or {quorum: <n>}, got ${JSON.stringify(value)}; using worst`);
  return [WORST, 0];
}

// The group's status from its children's, by rule, and a line saying why when a quorum is lost.
export function aggregate_status(rule: AggregateRule, quorum: number, statuses: readonly string[]): [status: Status, reason: string | null] {
  if (rule === BEST) return [best_status(statuses), null];
  if (rule === QUORUM) {
    const healthy = statuses.filter((status) => healthy_statuses.includes(status_of(status)));
    if (healthy.length >= quorum) return ["online", null];
    const unhealthy = statuses.filter((status) => !healthy_statuses.includes(status_of(status)));
    return [worst_status(unhealthy), `${healthy.length} of ${statuses.length} healthy, quorum is ${quorum}`];
  }
  return [worst_status(statuses), null];
}

// A copy of a child's UI_SPEC with the group's per-widget title overrides applied; the spec itself when there are none.
export function spec_with_titles(spec: UISpec | null, titles: Record<string, string>): UISpec | null {
  if (spec === null || Object.keys(titles).length === 0) return spec;
  const patched: UISpec = { ...spec };
  for (const key of ["cards", "charts"] as const) {
    const section = patched[key] as Record<string, Record<string, unknown>> | undefined;
    if (!section || Object.keys(section).length === 0) continue;
    (patched as Record<string, unknown>)[key] = Object.fromEntries(Object.entries(section).map(([name, widget]) => [name, name in titles ? { ...widget, title: titles[name] } : widget]));
  }
  if (patched.chart && "chart" in titles) patched.chart = { ...patched.chart, title: titles.chart };
  return patched;
}

// ── Composite layout ─────────────────────────────────────────────────────────

// A layout ref's child id and widget; a ref with no dot names a whole child.
export function parse_ref(ref: string): [child_id: string, widget: string | null] {
  const dot = ref.lastIndexOf(".");
  return dot === -1 ? [ref, null] : [ref.slice(0, dot), ref.slice(dot + 1)];
}

// A layout cell's overrides with the defaults filled, as the page's layout resolution fills them.
export interface CellConfig {
  flex: number;
  visible: boolean;
  height: string | null;
  min_width: string;
  title: string | null;
}

function cell_config(overrides: Record<string, unknown>): CellConfig {
  return {
    flex: Math.trunc(Number(overrides.flex ?? 1)),
    visible: Boolean(overrides.visible ?? true),
    height: (overrides.height as string | undefined) || null,
    min_width: (overrides.min_width as string | undefined) || "280px",
    title: (overrides.title as string | undefined) || null,
  };
}

// One descendant's part in the group's composite grid.
export interface CompositeChild {
  id: string;
  name: string;
  label: string;
  status: string;
  // Whether the grid places the child whole, by its bare id.
  whole: CellConfig | null;
  // The child's own widgets the grid places, by widget name, with their cell config.
  widgets: Record<string, CellConfig>;
  // The widget titles the group overrides, for spec_with_titles.
  titles: Record<string, string>;
  // The group's status card for the child, when the grid places the status pseudo-widget.
  status_widget: { cell: CellConfig; title: string; state: string } | null;
  // How the child's page is drawn: declaratively, by its own view, or not at all.
  view: "spec" | "custom" | "none";
}

export interface CompositeView {
  mode: "composite";
  // The group's rows as configured, each cell "<child_id>.<widget>", a bare child id, or a cell object.
  layout: LayoutRow[];
  children: CompositeChild[];
  // Visible refs no descendant fills, such as a misspelled id or widget name.
  unclaimed: string[];
}

export type GroupView = CompositeView | ({ mode: "cards" } & ChildCardsView);

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Group extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  readonly aggregate: AggregateRule;
  readonly quorum: number;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    [this.aggregate, this.quorum] = parse_aggregate(config.aggregate);
  }

  // A worst-of group only repeats its children; a best-of or quorum verdict is news of its own.
  override get restates_children(): boolean {
    return this.aggregate === WORST;
  }

  // A group issues no requests; each cycle it re-reads its children's live statuses and folds them by its rule.
  override parse_results(_results: Result[]): CollectResult {
    const [status, reason] = this.aggregate_children();
    return new CollectResult({ status, logs: reason ? [[reason, log_level_of(status)]] : [] });
  }

  aggregate_children(): [status: Status, reason: string | null] {
    return aggregate_status(this.aggregate, this.quorum, Object.values(this.child_statuses()));
  }

  // Every monitor under this group once each, depth-first, so a layout can address a nested group's children.
  descendants(): Plugin[] {
    return [...iter_monitors(this.children)];
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  // The configured composite grid, or the default one-card-per-child layout without one.
  override custom_view(): CustomView {
    const layout_rows = this.config.layout;
    const data: GroupView = Array.isArray(layout_rows) && layout_rows.length > 0 ? this.composite_view(layout_rows as LayoutRow[]) : { mode: "cards", ...child_cards_view(this) };
    return { kind: "group", data };
  }

  private composite_view(rows: LayoutRow[]): CompositeView {
    const cells = new Map<string, CellConfig>();
    for (const row of rows) for (const item of row as LayoutCell[]) {
      const [name, overrides] = split_item(item);
      cells.set(name, cell_config(overrides));
    }
    const statuses = this.data.latest_statuses();
    const claimed = new Set<string>();
    const children: CompositeChild[] = [];

    for (const child of this.descendants()) {
      const whole = cells.get(child.id) ?? null;
      if (whole !== null) claimed.add(child.id);
      const widgets: Record<string, CellConfig> = {};
      for (const [ref, config] of cells) {
        const [owner, widget] = parse_ref(ref);
        if (owner === child.id && widget !== null) widgets[widget] = config;
      }
      const status_cell = widgets[STATUS_WIDGET] ?? null;
      delete widgets[STATUS_WIDGET];
      const state = statuses[child.id] ?? "unavailable";
      let status_widget: CompositeChild["status_widget"] = null;
      if (status_cell !== null) {
        claimed.add(`${child.id}.${STATUS_WIDGET}`);
        status_widget = { cell: status_cell, title: status_cell.title || child.name.toUpperCase(), state };
      }

      const view = child.custom_view() !== null ? "custom" : child.UI_SPEC !== null ? "spec" : "none";
      if (Object.keys(widgets).length > 0) {
        if (view === "spec") for (const widget of Object.keys(widgets)) claimed.add(`${child.id}.${widget}`);
        else log.warn(`Group ${this.id}: ${child.id} has a hand-written UI and cannot have its widgets placed individually — reference it as '${child.id}' to render it whole`);
      }
      const titles = Object.fromEntries(Object.entries(widgets).filter(([, config]) => config.title).map(([widget, config]) => [widget, config.title!]));

      if (whole !== null || status_widget !== null || Object.keys(widgets).length > 0) {
        children.push({ id: child.id, name: child.name, label: child_label(this, child), status: state, whole, widgets, titles, status_widget, view });
      }
    }

    const unclaimed = [...cells].filter(([ref, config]) => !claimed.has(ref) && config.visible).map(([ref]) => ref).sort();
    for (const ref of unclaimed) log.warn(`Group ${this.id}: layout references unknown widget ${JSON.stringify(ref)}`);
    return { mode: "composite", layout: rows, children, unclaimed };
  }
}
