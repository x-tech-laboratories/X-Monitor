// Shared pieces of the page-view tests: a monitor whose UI_SPEC a test hands it, writing readings as a cycle would, and
// reading the widgets a built page holds.

import { CollectResult, type CollectResultFields } from "../../src/core/connectors/types.ts";
import { Plugin } from "../../src/monitors/base/plugin_base.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import type { RowView, WidgetView } from "../../src/shared/page_view.ts";
import type { UISpec } from "../../src/shared/ui_spec.ts";
import { store_of } from "../harness.ts";

// A monitor whose page is whatever spec the test gives it.
export class SpecPlugin extends Plugin {
  spec: UISpec | null = null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.spec = (config.ui_spec as UISpec | undefined) ?? null;
  }

  override get UI_SPEC(): UISpec | null {
    return this.spec;
  }
}

// Writes one cycle's result as the engine would.
export function apply(plugin: Plugin, fields: CollectResultFields): void {
  store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, new CollectResult(fields));
}

// Every widget in the rows, in layout order.
export function widgets_of(rows: readonly RowView[]): WidgetView[] {
  return rows.flatMap((row) => row.cells.flatMap((cell) => cell.content));
}

// The widgets of one type, in layout order.
export function widgets_by_type<Type extends WidgetView["type"]>(rows: readonly RowView[], type: Type): Extract<WidgetView, { type: Type }>[] {
  return widgets_of(rows).filter((widget): widget is Extract<WidgetView, { type: Type }> => widget.type === type);
}
