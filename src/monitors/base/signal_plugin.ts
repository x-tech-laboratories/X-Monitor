// Shared scaffolding for a single-signal monitor. Each one collects one signal, such as cpu, smart or throughput, and
// declares the cards, tables and charts that show it; this base assembles the usual host card, tables, charts and
// events page around them so every signal monitor lays out the same way.

import { worst_status as shared_worst_status, type Status } from "../../shared/status.ts";
import type { CardSpec, ChartSpec, LayoutRow, TableSpec, UISpec } from "../../shared/ui_spec.ts";
import { Plugin } from "./plugin_base.ts";

// The most severe of the given statuses, online when there are none.
export function worst_status(values: Iterable<string>): Status {
  return shared_worst_status(values);
}

export abstract class SignalPlugin extends Plugin {
  cards(): Record<string, CardSpec> {
    return {};
  }

  charts(): Record<string, ChartSpec> {
    return {};
  }

  // Cards that join the host card's top row; the rest are placed by rows().
  card_row(): string[] {
    return Object.keys(this.cards());
  }

  // Full-width layout rows this monitor adds above its charts.
  rows(): LayoutRow[] {
    return [];
  }

  // Tables, each on a full-width row between the cards and the charts.
  tables(): Record<string, TableSpec> {
    return {};
  }

  override get UI_SPEC(): UISpec {
    const charts = this.charts();
    const tables = this.tables();
    const layout: LayoutRow[] = [
      ["host_card", ...this.card_row()],
      ...this.rows(),
      ...Object.keys(tables).map((name) => [name]),
      ...Object.keys(charts).map((name) => [name]),
      ["events"],
    ];
    const spec: UISpec = { layout, cards: this.cards(), charts, events: true };
    if (Object.keys(tables).length > 0) spec.tables = tables;
    return spec;
  }
}
