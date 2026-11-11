// How a monitor shows the monitors under it: a group with a `layout` composes its descendants' individual widgets into
// its own grid, addressed as "<child_id>.<widget>"; any other monitor with children shows one collapsible card per
// child, whose open state is kept per parent as a setting so it survives a reload.

import { create_logger_for } from "../../core/logging.ts";
import type { Plugin } from "../../monitors/base/plugin_base.ts";
import type { BodyView, ChildCardView } from "../../shared/page_view.ts";
import { expanded, set_expanded } from "../../monitors/base/child_cards.ts";
import { spec_with_titles, STATUS_WIDGET } from "../../monitors/group.ts";
import { status_of } from "../../shared/status.ts";
import type { LayoutRow } from "../../shared/ui_spec.ts";
import { dialog_views, info_card } from "./components.ts";
import { child_label, iter_monitors } from "../../core/coordination/monitor_graph.ts";
import { CompositeLayout } from "./layout.ts";
import { build_body, type BuildContext } from "./monitor.ts";
import { build_spec } from "./spec.ts";

const log = create_logger_for("x_monitor.plugins.group");

// ── Composite grid ───────────────────────────────────────────────────────────

// A group's configured grid filled with its descendants' widgets, a whole child where a bare id is placed.
export function composite_body(group: Plugin, layout_rows: readonly LayoutRow[], context: BuildContext): BodyView {
  const grid = new CompositeLayout(layout_rows);
  const statuses = group.data.latest_statuses();

  for (const child of iter_monitors(group.children)) {
    if (grid.hosts_child(child.id)) {
      const cell = grid.cell(child.id);
      const title = grid.config_for(child.id)?.title;
      if (title) cell.push({ type: "section", title });
      cell.push({ type: "body", monitor_id: child.id, body: build_body(child, "inline", context) });
    }

    const widgets = grid.widgets_for(child.id);
    const status_config = widgets.get(STATUS_WIDGET);
    widgets.delete(STATUS_WIDGET);
    if (status_config !== undefined) {
      const state = status_of(statuses[child.id] ?? "unavailable");
      grid.cell(`${child.id}.${STATUS_WIDGET}`).push(info_card(status_config.title || child.name.toUpperCase(), state.toUpperCase(), state));
    }

    if (widgets.size === 0) continue;
    const spec = child.UI_SPEC;
    if (spec === null) {
      log.warn(`Group ${group.id}: ${child.id} has a hand-written UI and cannot have its widgets placed individually — reference it as '${child.id}' to render it whole`);
      continue;
    }
    const titles = Object.fromEntries([...widgets].filter(([, config]) => config.title).map(([name, config]) => [name, config.title!]));
    context.dialogs[child.id] ??= dialog_views(child);
    build_spec(child, { context: "inline", spec: spec_with_titles(spec, titles), layout: grid.view(child.id) });
  }

  for (const ref of grid.unclaimed()) log.warn(`Group ${group.id}: layout references unknown widget '${ref}'`);
  return { monitor_id: group.id, rows: grid.grid.rows, children: [], custom: null };
}

// ── Child cards ──────────────────────────────────────────────────────────────

// Opens or shuts one child card and keeps the choice.
export function set_child_open(settings: { set_setting(key: string, value: string): void }, parent: Plugin, child_id: string, open: boolean): void {
  set_expanded(parent, child_id, open, settings);
}

// One collapsible card per child, each drawing the child's own page while it is open.
export function child_cards(parent: Plugin, context: BuildContext): ChildCardView[] {
  const min_width = String(parent.config.grid_min_width ?? "320px");
  const statuses = parent.data.latest_statuses();
  const open_cards = expanded(parent);
  return parent.children.map((child) => {
    const open = open_cards[child.id] ?? false;
    const config = child.config as Record<string, unknown>;
    return {
      id: child.id,
      label: child_label(parent, child),
      state: status_of(statuses[child.id] ?? "unavailable"),
      open,
      col_span: Math.trunc(Number(config.grid_col_span ?? 1)),
      height: config.grid_height ? String(config.grid_height) : null,
      min_width: String(config.grid_min_width ?? min_width),
      body: open ? build_body(child, "inline", context) : null,
    };
  });
}
