// The declarative page: walks a monitor's UI_SPEC and fills its layout cells with the widgets each top-level key asks
// for, as generic_render() did. A card dispatches on its first matching key: `repeat`, then `kind` (a gauge, share
// bar or uptime strip), then `metrics`, then `metric`, then the static and attribute forms; `host_card` and
// `status_card` are reserved names with fixed renderings.

import { python_format } from "@x-tech-laboratories/x-libs/python_text";

import type { Plugin } from "../../monitors/base/plugin_base.ts";
import { fill_percent, share_percents, strip_states, STRIP_CELLS, up_share_text, CARD_KINDS } from "../../shared/charts.ts";
import type { GaugeView, ShareView, StripView, WidgetView } from "../../shared/page_view.ts";
import { status_of, type Status } from "../../shared/status.ts";
import type { CardSpec, ChartSpec, ColorRule, Formatter, LayoutRow, UISpec } from "../../shared/ui_spec.ts";
import { COLOR_RULES, FORMATTERS, ITEM_COLOR_RULES, ITEM_FORMATTERS, resolve, threshold_color } from "../../shared/ui_registry.ts";
import { buttons_view, event_feed, history_chart, host_card, info_card, job_panel, latest_value, repeat_card, series_chart, status_card, table_view } from "./components.ts";
import { plugin_attr } from "./engine.ts";
import { make_inline_layout, PluginLayout, type LayoutTarget } from "./layout.ts";

// ── Rules ────────────────────────────────────────────────────────────────────

// A card's `color` as a rule: inline thresholds, a registered name, or the function itself; null with no colour.
export function card_color_rule(card_spec: CardSpec, widget_name: string): ColorRule | null {
  const color = card_spec.color;
  if (!color) return null;
  if (typeof color === "object") {
    if (!("warning" in color) || !("threshold" in color)) {
      throw new Error(`UI_SPEC card '${widget_name}' has an inline color needing both 'warning' and 'threshold', got ${JSON.stringify(Object.keys(color).sort())}`);
    }
    return threshold_color(color.warning ?? null, color.threshold ?? null);
  }
  const rule = resolve(COLOR_RULES, color);
  if (rule === null) throw new Error(`UI_SPEC card '${widget_name}' references unknown color rule '${String(color)}' — register it via spec.register_color_rule first`);
  return rule;
}

// A card's `format` as a formatter, "int" by default.
export function card_formatter(card_spec: CardSpec, widget_name: string): Formatter {
  const name = card_spec.format ?? "int";
  const formatter = resolve(FORMATTERS, name);
  if (formatter === null) throw new Error(`UI_SPEC card '${widget_name}' references unknown format '${String(name)}' — register it via spec.register_formatter first`);
  return formatter;
}

function state_or_null(state: string | null): Status | null {
  return state ? status_of(state) : null;
}

// ── Cards ────────────────────────────────────────────────────────────────────

// A static card, or one reading a plugin attribute through `value_format`, coloured by the attribute `color_attr` names.
function value_card(plugin: Plugin, title: string, card_spec: CardSpec): WidgetView {
  const text = card_spec.value_attr !== undefined
    ? python_format(card_spec.value_format ?? "{}", [plugin_attr(plugin, card_spec.value_attr)])
    : (card_spec.value ?? "--");
  const state = card_spec.color_attr ? plugin_attr(plugin, card_spec.color_attr) : null;
  return info_card(title, text, typeof state === "string" ? status_of(state) : null);
}

// Several metrics combined into one card through an item formatter, coloured by an item colour rule.
function multi_metric_card(plugin: Plugin, title: string, card_spec: CardSpec): WidgetView {
  const format_fn = resolve(ITEM_FORMATTERS, card_spec.format_fn, true)!;
  const color_fn = resolve(ITEM_COLOR_RULES, card_spec.color_fn);
  const values = Object.fromEntries((card_spec.metrics ?? []).map((name) => [name, latest_value(plugin, name)]));
  return info_card(title, format_fn(values), color_fn ? state_or_null(color_fn(values)) : null);
}

// One metric, formatted and coloured by the card's rule.
function metric_card(plugin: Plugin, widget_name: string, title: string, card_spec: CardSpec): WidgetView {
  const formatter = card_formatter(card_spec, widget_name);
  const value = latest_value(plugin, String(card_spec.metric));
  const rule = card_color_rule(card_spec, widget_name);
  return info_card(title, formatter(value), rule ? state_or_null(rule(value)) : null);
}

// A stat with a small arc filled by the metric's share of `maximum`, coloured by the card's rule or the accent.
export function gauge_card(title: string, value: number | null, formatter: Formatter, color_rule: ColorRule | null, maximum = 100, caption: string | null = null): GaugeView {
  return { type: "gauge", title, text: formatter(value), percent: fill_percent(value, maximum), state: color_rule ? state_or_null(color_rule(value)) : null, caption: caption || null };
}

// One bar split into the parts' shares of their total, each part's value printed in the legend.
export function share_card(plugin: Plugin, title: string, parts: NonNullable<CardSpec["parts"]>, formatter: Formatter): ShareView {
  const values = parts.map((part) => latest_value(plugin, String(part.metric)));
  const shares = share_percents(values);
  return {
    type: "share",
    title,
    parts: parts.map((part, index) => ({ label: part.label ?? "", text: formatter(values[index]), percent: shares[index], color: part.color ?? "series-1" })),
  };
}

// The last `cells` readings of each row's 0/1 metric as up and down cells; a lone unlabelled row carries no label.
export function strip_card(plugin: Plugin, title: string, rows: NonNullable<CardSpec["rows"]>, up_above = 0.5, cells = STRIP_CELLS): StripView {
  const labeled = rows.length > 1 || Boolean(rows[0]?.label);
  return {
    type: "strip",
    title,
    cells,
    rows: rows.map((row) => {
      const values = plugin.data.metric_history(plugin.id, String(row.metric), cells).map((record) => record.value);
      const states = strip_states(values, up_above, cells);
      return { label: labeled ? (row.label ?? String(row.metric)) : null, states, share_text: up_share_text(states) };
    }),
  };
}

// A card whose spec names a chart kind.
function chart_card(plugin: Plugin, widget_name: string, card_spec: CardSpec): WidgetView {
  const title = String(card_spec.title);
  const formatter = card_formatter(card_spec, widget_name);
  const color_rule = card_color_rule(card_spec, widget_name);
  if (card_spec.kind === "gauge") return gauge_card(title, latest_value(plugin, String(card_spec.metric)), formatter, color_rule, card_spec.max ?? 100, card_spec.caption ?? null);
  if (card_spec.kind === "share") return share_card(plugin, title, card_spec.parts ?? [], formatter);
  if (card_spec.kind === "strip") return strip_card(plugin, title, card_spec.rows?.length ? card_spec.rows : [{ metric: card_spec.metric }], card_spec.up_above ?? 0.5, card_spec.cells ?? STRIP_CELLS);
  throw new Error(`UI_SPEC card '${widget_name}' has unknown kind '${String(card_spec.kind)}'; expected one of ${JSON.stringify(CARD_KINDS)}`);
}

// Every plain card, by its first matching kind, into its cell.
function fill_cards(plugin: Plugin, layout: LayoutTarget, cards: Record<string, CardSpec>): void {
  for (const [widget_name, card_spec] of Object.entries(cards)) {
    if (widget_name === "host_card" || widget_name === "status_card") continue;
    if (!layout.renders(widget_name)) continue;
    let widget: WidgetView;
    if (card_spec.repeat) widget = repeat_card(plugin, card_spec.repeat, card_spec.title ?? null);
    else if (card_spec.kind !== undefined) widget = chart_card(plugin, widget_name, card_spec);
    else if (card_spec.metrics !== undefined) widget = multi_metric_card(plugin, String(card_spec.title), card_spec);
    else if (card_spec.metric !== undefined) widget = metric_card(plugin, widget_name, String(card_spec.title), card_spec);
    else widget = value_card(plugin, String(card_spec.title), card_spec);
    layout.cell(widget_name).push(widget);
  }
}

// ── The page ─────────────────────────────────────────────────────────────────

export interface SpecBuild {
  // "page" for the monitor's own page, "inline" inside another's, which hides the host card and logs.
  context?: "page" | "inline";
  spec?: UISpec | null;
  layout?: LayoutTarget | null;
}

// The layout a spec lays itself out on: the monitor's config layout over the spec's rows, made compact inline.
export function spec_layout(plugin: Plugin, rows: readonly LayoutRow[], context: "page" | "inline" = "page"): PluginLayout {
  return new PluginLayout(plugin.config, context === "page" ? rows : make_inline_layout(rows));
}

// Fills a layout from a monitor's UI_SPEC by sending each top-level key to its builder, and returns the layout.
export function build_spec(plugin: Plugin, options: SpecBuild = {}): LayoutTarget {
  const spec = options.spec ?? plugin.UI_SPEC;
  if (spec === null || spec === undefined) throw new Error(`${plugin.constructor.name} has no UI_SPEC and none was passed to build_spec()`);

  const cards = spec.cards ?? {};
  const charts: Record<string, ChartSpec> = { ...spec.charts };
  if (spec.chart && !("chart" in charts)) charts.chart = spec.chart;
  const layout = options.layout ?? spec_layout(plugin, spec.layout ?? [], options.context ?? "page");

  fill_cards(plugin, layout, cards);

  if (layout.hosts("host_card") && layout.renders("host_card")) layout.cell("host_card").push(host_card(plugin.target));

  if (cards.status_card && layout.renders("status_card")) {
    const card = cards.status_card;
    layout.cell("status_card").push(status_card(latest_value(plugin, String(card.metric)), card.title ?? "STATUS", card.on_text ?? "ACTIVE", card.off_text ?? "INACTIVE"));
  }

  for (const [widget_name, chart] of Object.entries(charts)) {
    if (!layout.renders(widget_name)) continue;
    layout.cell(widget_name).push(chart.series
      ? series_chart(plugin, chart.title ?? widget_name.toUpperCase(), chart.series, chart.style ?? "lines")
      : history_chart(plugin, chart.title ?? String(chart.metric).toUpperCase(), String(chart.metric)));
  }

  const events = spec.events ?? false;
  if (events && layout.renders("events")) layout.cell("events").push(event_feed(plugin, typeof events === "object" ? events : {}));

  const filters = spec.filters ?? {};
  for (const [widget_name, table] of Object.entries(spec.tables ?? {})) {
    if (!layout.renders(widget_name)) continue;
    layout.cell(widget_name).push(table_view(plugin, table, filters[widget_name] ?? null));
  }

  for (const [widget_name, button_specs] of Object.entries(spec.buttons ?? {})) {
    if (!layout.renders(widget_name)) continue;
    layout.cell(widget_name).push(buttons_view(plugin, button_specs));
  }

  if (spec.job_panel) {
    const widget = spec.job_panel.widget ?? "jobs";
    if (layout.renders(widget)) layout.cell(widget).push(job_panel(plugin, spec.job_panel));
  }
  return layout;
}
