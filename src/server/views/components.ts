// The widget builders a monitor's page view is made of: value cards, repeated items, feeds, history charts, tables
// with row actions and toggle cells, button rows, dialogs and the job panel. Each reads the monitor's stored state
// through its data view and returns plain JSON for the page to draw; nothing here holds a widget or a timer.

import { metric_family_items } from "../../monitors/base/metric_family.ts";
import type { Plugin } from "../../monitors/base/plugin_base.ts";
import { format_duration } from "../../monitors/base/plugin_helpers.ts";
import { align_series, fill_percent, type SeriesStyle, SERIES_STYLES } from "../../shared/charts.ts";
import type {
  ButtonView, ChartView, ColumnView, DialogFieldView, DialogView, FeedRow, FeedView, JobPanelView, RepeatItemView, RepeatView, RowActionView, TableView, ValueCardView,
} from "../../shared/page_view.ts";
import { toggle_position } from "../../shared/page_view.ts";
import { python_format, python_str } from "../../shared/python_text.ts";
import { status_of, type Status } from "../../shared/status.ts";
import { keyed_rows, type TableRow } from "../../shared/table_rows.ts";
import { iso_local } from "../../shared/time.ts";
import type { ButtonSpec, ChartSpec, DialogFieldSpec, DialogSpec, FilterSpec, JobPanelSpec, RepeatSpec, TableSpec } from "../../shared/ui_spec.ts";
import { ENABLED_PREDICATES, FORMATTERS, ITEM_COLOR_RULES, ITEM_FORMATTERS, resolve } from "../../shared/ui_registry.ts";
import { plugin_attr } from "./engine.ts";

// How many readings a history chart draws.
export const HISTORY_LIMIT = 30;

// ── Value cards ──────────────────────────────────────────────────────────────

export function info_card(title: string, text = "--", state: Status | null = null): ValueCardView {
  return { type: "value", title, text, state };
}

// The standard card naming the monitored host.
export function host_card(target: string): ValueCardView {
  return info_card("TARGET HOST", target);
}

// An on/off card over a 0-or-1 metric: on_text in the online colour above one half, off_text failed otherwise, and
// "Checking..." with no colour while the metric is absent.
export function status_card(value: number | null, title = "STATUS", on_text = "ACTIVE", off_text = "INACTIVE"): ValueCardView {
  if (value === null) return info_card(title, "Checking...");
  return info_card(title, value > 0.5 ? on_text : off_text, value > 0.5 ? "online" : "failed");
}

// The latest value of one of the plugin's metrics, or null before any reading.
export function latest_value(plugin: Plugin, metric_name: string): number | null {
  return plugin.data.latest_metric(metric_name)?.value ?? null;
}

// ── Repeated items ───────────────────────────────────────────────────────────

const LABEL_TRANSFORMS: Record<string, (text: string) => string> = {
  slashes: (text) => (text !== "root" ? `/${text.replaceAll("_", "/")}` : "/"),
  spaces_upper: (text) => text.replaceAll("_", " ").toUpperCase(),
  none: (text) => text,
};

export const REPEAT_PANELS = ["bars", "tiles"];

// The items a repeat card or a spec table shows: the latest snapshot list, a JSON list in the settings store, or items
// discovered from metric names.
export function resolve_repeat_items(plugin: Plugin, repeat_spec: RepeatSpec): Record<string, unknown>[] {
  const source = repeat_spec.source ?? "snapshot";
  if (source === "setting") {
    const key = python_format(repeat_spec.setting_key ?? "", [], { plugin_id: plugin.id });
    const raw = plugin.data.get_setting(key);
    if (!raw) return [];
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];
    // A list of plain strings, such as DNS answers, becomes label and value items.
    return data.map((item) => (typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : { label: item, value: item }));
  }
  if (source === "metrics_prefix") return metric_family_items(plugin.data.latest_collector_metrics(), repeat_spec);
  const snapshot = plugin.data.latest_snapshot<unknown>([]);
  return Array.isArray(snapshot) ? (snapshot as Record<string, unknown>[]) : [];
}

// The largest numeric meter value among the items, or zero when none has one.
function largest_bar_value(items: readonly Record<string, unknown>[], bar_value: string): number {
  const values = items.map((item) => item[bar_value]).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? 0 : Math.max(...values);
}

// One chip, card, meter or tile per item resolved from a repeat spec's data source.
export function repeat_card(plugin: Plugin, repeat_spec: RepeatSpec, title: string | null = null): RepeatView {
  const source = repeat_spec.source ?? "snapshot";
  const container = repeat_spec.container ?? "chips";
  const item_label = repeat_spec.item_label ?? (source === "metrics_prefix" ? "key" : "label");
  const item_value = repeat_spec.item_value ?? "value";
  const formatter = resolve(FORMATTERS, repeat_spec.item_format);
  const item_format_fn = resolve(ITEM_FORMATTERS, repeat_spec.item_format_fn);
  const label_transform = LABEL_TRANSFORMS[repeat_spec.label_transform ?? "none"] ?? LABEL_TRANSFORMS.none;
  const label_prefix = repeat_spec.item_label_prefix ?? "";
  const label_suffix = repeat_spec.item_label_suffix ?? "";
  const color_rule = resolve(ITEM_COLOR_RULES, repeat_spec.item_color_by);
  const bar_value = repeat_spec.bar_value ?? item_value;
  const bar_max = repeat_spec.bar_max ?? 100;

  const items = resolve_repeat_items(plugin, repeat_spec);
  const scale = bar_max === "largest" ? largest_bar_value(items, bar_value) : bar_max;
  const views = items.map((item): RepeatItemView => {
    const raw_label = item[item_label] === undefined ? "" : python_str(item[item_label]);
    let label = raw_label ? label_transform(raw_label) : raw_label;
    if (label) label = `${label_prefix}${label}${label_suffix}`;
    let value: string;
    if (item_format_fn) value = item_format_fn(item);
    else {
      const raw_value = item[item_value];
      value = formatter ? formatter((raw_value ?? null) as number | null) : python_str(raw_value);
    }
    const state = color_rule ? color_rule(item) : null;
    const bar = item[bar_value];
    return { label, value, state: state ? status_of(state) : null, percent: fill_percent(typeof bar === "number" ? bar : null, scale) };
  });
  return {
    type: "repeat",
    title,
    container,
    items: views,
    empty_text: repeat_spec.empty_text ?? "No data",
    marker: repeat_spec.bar_marker ?? null,
  };
}

// ── Feeds ────────────────────────────────────────────────────────────────────

// A plugin's recent events, the "[name] " prefix taken off each message.
export function event_feed(plugin: Plugin, options: { title?: string; limit?: number; full_height?: boolean } = {}): FeedView {
  const prefix = `[${plugin.name}] `;
  const rows = plugin.data.plugin_events(plugin.id, prefix, plugin.target, options.limit ?? 100);
  return { type: "feed", title: options.title ?? "Recent events", rows, full_height: options.full_height ?? false };
}

// The target's recent log lines from this plugin.
export function log_feed(plugin: Plugin, options: { title?: string; limit?: number; full_height?: boolean } = {}): FeedView {
  const rows: FeedRow[] = plugin.data.log_lines(plugin.target, plugin.id, options.limit ?? 15).map((line) => ({
    timestamp: iso_local(line.timestamp), level: line.level, message: line.message,
  }));
  return { type: "feed", title: options.title ?? "Recent logs", rows, full_height: options.full_height ?? false };
}

// ── Charts ───────────────────────────────────────────────────────────────────

function epoch(moment: Date): number {
  return moment.getTime() / 1000;
}

// One metric's recent history.
export function history_chart(plugin: Plugin, title: string, metric_name: string, limit = HISTORY_LIMIT): ChartView {
  const history = plugin.data.metric_history(plugin.id, metric_name, limit);
  return { type: "chart", title, style: "lines", times: history.map((record) => epoch(record.timestamp)), series: [{ label: title, values: history.map((record) => record.value) }] };
}

// Several metrics' recent history on one chart, lined up on the first one's timestamps; a mirror chart negates its
// second series so it hangs below the axis.
export function series_chart(plugin: Plugin, title: string, series: NonNullable<ChartSpec["series"]>, style: string = "lines", limit = HISTORY_LIMIT): ChartView {
  if (!(SERIES_STYLES as readonly string[]).includes(style)) throw new Error(`chart style '${style}' is not one of ${JSON.stringify(SERIES_STYLES)}`);
  const histories = series.map((each) => plugin.data.metric_history(plugin.id, String(each.metric), limit).map((record): [number, number | null] => [epoch(record.timestamp), record.value]));
  const [times, columns] = align_series(histories);
  if (style === "mirror" && columns.length > 1) columns[1] = columns[1].map((value) => (value === null ? null : -value));
  return {
    type: "chart",
    title,
    style: style as SeriesStyle,
    times,
    series: series.map((each, index) => ({ label: each.label ?? String(each.metric), values: columns[index] ?? [] })),
  };
}

// ── Tables ───────────────────────────────────────────────────────────────────

// Whether a spec entry's `visible_if` lets it show; an unknown predicate name shows it.
function shown_for(plugin: Plugin, visible_if: unknown): boolean {
  if (!visible_if) return true;
  const predicate = resolve(ENABLED_PREDICATES, visible_if as string);
  return predicate === null || predicate(plugin);
}

// A spec table with its rows read now: cells coloured by their column's rule, toggle cells placed, row actions the
// plugin allows, and the filter box's placeholder and fields.
export function table_view(plugin: Plugin, table_spec: TableSpec, filter_spec: FilterSpec | null = null): TableView {
  const row_key = table_spec.row_key ?? "id";
  const spec_columns = table_spec.columns ?? [];
  const row_actions = (table_spec.row_actions ?? []).filter((action) => shown_for(plugin, action.visible_if)).map((action): RowActionView => ({
    id: String(action.id),
    icon: action.icon ?? "play_arrow",
    danger: action.color === "negative",
    tooltip: action.tooltip ?? "",
    kind: action.kind ?? null,
    dialog: action.dialog ?? null,
    action_id: action.action_id ?? String(action.id),
    params: action.params ?? {},
    notify: action.notify ?? true,
    confirm: action.confirm ? bind_plugin_fields(action.confirm, plugin) : null,
  }));
  const color_rules = spec_columns.flatMap((column) => {
    const rule = column.cell_color_by ? resolve(ITEM_COLOR_RULES, column.cell_color_by) : null;
    return rule ? [[column, rule] as const] : [];
  });
  const columns: ColumnView[] = spec_columns.map((column) => ({
    name: String(column.name),
    label: column.label ?? "",
    field: column.field ?? String(column.name),
    align: column.align ?? "left",
    sortable: column.sortable ?? true,
    ...(column.sort_field ? { sort_field: column.sort_field } : {}),
    colored: color_rules.some(([colored]) => colored === column),
    toggle: column.toggle ? { on_action_id: String(column.toggle.on_action_id), off_action_id: String(column.toggle.off_action_id), params: column.toggle.params ?? {} } : null,
  }));
  if (row_actions.length > 0) columns.push({ name: "actions", label: "", field: "actions", align: "center", sortable: false, colored: false, toggle: null });

  const raw = table_spec.rows_attr ? plugin_attr(plugin, table_spec.rows_attr) : resolve_repeat_items(plugin, { source: (table_spec.source ?? "snapshot") as RepeatSpec["source"] });
  const rows = (Array.isArray(raw) ? (raw as TableRow[]) : []).map((source) => {
    const row: TableRow = { ...source };
    for (const [column, rule] of color_rules) {
      const state = rule(source);
      row[`_color_${column.name}`] = state ? status_of(state) : "online";
    }
    for (const column of spec_columns) {
      if (column.toggle) row[`_toggle_${column.name}`] = toggle_position(column.toggle, source[column.field ?? String(column.name)]);
    }
    return row;
  });
  const sortable_fields = columns.filter((column) => column.sortable && column.name !== "actions").map((column) => column.field);
  return {
    type: "table",
    monitor_id: plugin.id,
    title: table_spec.title ?? null,
    row_key,
    columns,
    rows: keyed_rows(rows, row_key),
    row_actions,
    filter_placeholder: filter_spec?.placeholder ?? "Filter",
    filter_fields: filter_spec?.fields ?? sortable_fields,
    tree: table_spec.tree ? { parent_field: String(table_spec.tree.parent_field), column: table_spec.tree.column ?? String(spec_columns[0]?.name ?? "") } : null,
  };
}

// ── Buttons ──────────────────────────────────────────────────────────────────

// A row of action buttons, leaving out those whose visibility predicate says no.
export function buttons_view(plugin: Plugin, button_specs: readonly ButtonSpec[], title: string | null = null): { type: "buttons"; monitor_id: string; title: string | null; buttons: ButtonView[] } {
  const buttons = button_specs.filter((spec) => shown_for(plugin, spec.visible_if)).map((spec): ButtonView => ({
    id: String(spec.id),
    label: spec.label ?? String(spec.id),
    icon: spec.icon ?? null,
    flat: spec.flat ?? true,
    danger: spec.color === "negative" || spec.color === "danger",
    kind: spec.kind ?? null,
    dialog: spec.dialog ?? null,
    notify: spec.notify ?? true,
    confirm: spec.confirm ? bind_plugin_fields(spec.confirm, plugin) : null,
  }));
  return { type: "buttons", monitor_id: plugin.id, title, buttons };
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

// A plugin attribute as a template reads it, a missing one as empty.
function plugin_lookup(plugin: Plugin): (key: string) => unknown {
  return (key) => {
    const value = plugin_attr(plugin, key);
    return value === undefined || value === null ? "" : value;
  };
}

// Fills every `{plugin.attr}` field of a template now, leaving `{row[field]}` fields for the row a click comes from.
export function bind_plugin_fields(template: string, plugin: Plugin): string {
  const lookup = plugin_lookup(plugin);
  return template.replace(/\{\{|\}\}|\{(plugin(?:\.[^{}:!.[\]]+|\[[^\]]*\])+(?:![rs])?(?::[^{}]*)?)\}/g, (whole, field: string | undefined) => {
    if (field === undefined) return whole;
    return python_format(`{${field}}`, [], { plugin: lookup }).replaceAll("{", "{{").replaceAll("}", "}}");
  });
}

// The choices a select field offers: its own `options`, or the plugin attribute `options_attr` names.
export function form_options(plugin: unknown, field: DialogFieldSpec): unknown {
  if (field.options_attr !== undefined) return (plugin === null || plugin === undefined ? null : plugin_attr(plugin, field.options_attr)) || [];
  return field.options || [];
}

function option_pairs(options: unknown): [string, string][] {
  if (Array.isArray(options)) return options.map((value) => [python_str(value), python_str(value)]);
  if (options instanceof Map) return [...options].map(([value, label]) => [python_str(value), python_str(label)]);
  if (typeof options === "object" && options !== null) return Object.entries(options).map(([value, label]) => [value, python_str(label)]);
  return [];
}

// One form field's input: a checkbox, a select when it has options, else a text box.
export function form_field(plugin: Plugin, field: DialogFieldSpec): DialogFieldView {
  const label = field.label ?? field.name;
  if (field.type === "checkbox") return { name: field.name, label, placeholder: "", type: "checkbox", options: [], default: Boolean(field.default ?? false) };
  if (field.options !== undefined || field.options_attr !== undefined) {
    const options = option_pairs(form_options(plugin, field));
    let chosen = field.default_attr !== undefined ? plugin_attr(plugin, field.default_attr) : field.default;
    if (!options.some(([value]) => value === python_str(chosen))) chosen = options[0]?.[0] ?? null;
    return { name: field.name, label, placeholder: "", type: "select", options, default: chosen === null || chosen === undefined ? null : python_str(chosen) };
  }
  return { name: field.name, label, placeholder: field.placeholder ?? "", type: "text", options: [], default: field.default ?? "" };
}

// A dialog spec as the page opens it, its `{plugin.attr}` fields filled and its form fields resolved.
export function dialog_view(plugin: Plugin, dialog_name: string, spec: DialogSpec): DialogView {
  return {
    kind: spec.kind ?? "read",
    title: bind_plugin_fields(spec.title ?? dialog_name, plugin),
    render: spec.render ?? null,
    action_id: spec.action_id ?? null,
    params: spec.params ?? {},
    load_action_id: spec.load_action_id ?? null,
    load_params: spec.load_params ?? {},
    save_action_id: spec.save_action_id ?? null,
    save_params: spec.save_params ?? {},
    save_content_kwarg: spec.save_content_kwarg ?? "content",
    success_message: spec.success_message ?? "Saved",
    fields: (spec.fields ?? []).map((field) => form_field(plugin, field)),
    submit_label: spec.submit_label ?? "Run",
    confirm: spec.confirm ? bind_plugin_fields(spec.confirm, plugin) : null,
  };
}

// Every dialog the plugin's UI_SPEC declares, ready for the page.
export function dialog_views(plugin: Plugin): Record<string, DialogView> {
  const dialogs = plugin.UI_SPEC?.dialogs ?? {};
  return Object.fromEntries(Object.entries(dialogs).map(([name, spec]) => [name, dialog_view(plugin, name, spec)]));
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

// The progress line and history of a plugin's jobs, with run and cancel controls when the spec names a run action.
export function job_panel(plugin: Plugin, spec: JobPanelSpec): JobPanelView {
  const history_limit = spec.history_limit ?? 10;
  const predicate = spec.enabled_if ? resolve(ENABLED_PREDICATES, spec.enabled_if) : null;
  const enabled = predicate === null ? true : predicate(plugin);
  const running = plugin.jobs?.is_running() ?? false;

  let progress: { text: string; state: Status | null };
  if (running) {
    const current = plugin.jobs!.current_id();
    const job = current === null ? null : plugin.data.job(current);
    progress = { text: job?.progress || "Starting...", state: "online" };
  } else if (!enabled) {
    progress = { text: spec.disabled_text ?? "Not available — check monitor configuration", state: "unavailable" };
  } else {
    progress = { text: "", state: null };
  }

  const recent = plugin.jobs?.recent(history_limit, spec.exclude_kinds ?? []) ?? [];
  return {
    type: "jobs",
    monitor_id: plugin.id,
    title: spec.title ?? "Jobs",
    run: spec.run_action_id ? { label: spec.run_label ?? "Run", icon: spec.run_icon ?? "play_arrow", enabled: enabled && !running, action_id: spec.run_action_id } : null,
    cancel: spec.run_action_id ? { label: spec.cancel_label ?? "Cancel", icon: spec.cancel_icon ?? "stop", visible: running } : null,
    progress,
    rows: recent.map((job) => ({ id: job.id, started: job.started, kind: job.kind, state: job.state, duration: format_duration(job.duration), duration_seconds: job.duration })),
  };
}
