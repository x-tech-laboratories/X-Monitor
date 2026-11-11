// The shapes of a monitor's declarative page (its UI_SPEC) and of its header action buttons.
//
// Every field is optional because the renderer treats a missing key as "this widget is not used". A function field
// may name a registered rule (see ui_registry.ts) or hold the function itself; the server resolves both before the
// page sees the result, so only names and data cross to the browser.

import type { Status } from "./status.ts";

// ── Rules ────────────────────────────────────────────────────────────────────

export type Formatter = (value: number | null) => string;
export type ColorRule = (value: number | null) => Status | null;
export type ItemFormatter = (item: Record<string, unknown>) => string;
export type ItemColorRule = (item: Record<string, unknown>) => Status | null;
export type EnabledPredicate = (plugin: unknown) => boolean;

// A registered name or the function itself.
export type RuleRef<Rule> = string | Rule;

// Inline thresholds a card colors its value by.
export interface ThresholdColor {
  warning?: number | null;
  threshold?: number | null;
}

// ── Cards ────────────────────────────────────────────────────────────────────

export interface CardSpec {
  title?: string;
  // One metric's latest value.
  metric?: string;
  format?: RuleRef<Formatter>;
  color?: RuleRef<ColorRule> | ThresholdColor;
  // Several metrics combined into one card.
  metrics?: string[];
  format_fn?: RuleRef<ItemFormatter>;
  color_fn?: RuleRef<ItemColorRule>;
  // A plugin attribute read each refresh.
  value_attr?: string;
  value_format?: string;
  color_attr?: string;
  refresh?: boolean;
  // Static text, computed once.
  value?: string;
  repeat?: RepeatSpec;
  // A chart card: "gauge", "share" or "strip".
  kind?: "gauge" | "share" | "strip";
  max?: number;
  caption?: string;
  parts?: SharePartSpec[];
  cells?: number;
  up_above?: number;
  rows?: SeriesSpec[];
  // The status card only.
  on_text?: string;
  off_text?: string;
}

export interface RepeatSpec {
  source?: "snapshot" | "setting" | "metrics_prefix";
  container?: "chips" | "bars" | "tiles" | "cards";
  bar_value?: string;
  bar_max?: number | "largest";
  bar_marker?: number;
  item_label?: string;
  item_value?: string;
  item_format?: RuleRef<Formatter>;
  item_format_fn?: RuleRef<ItemFormatter>;
  label_transform?: "none" | "slashes" | "spaces_upper";
  item_label_prefix?: string;
  item_label_suffix?: string;
  item_color_by?: RuleRef<ItemColorRule>;
  empty_text?: string;
  // With source "setting": a key with "{plugin_id}" in it.
  setting_key?: string;
  // With source "metrics_prefix".
  metrics_prefix?: string;
  metrics_suffix?: string;
  metrics_exclude?: string[];
  fields?: MetricFieldSpec[];
}

export interface MetricFieldSpec {
  name: string;
  prefix: string;
  suffix: string;
}

export interface SharePartSpec {
  metric?: string;
  label?: string;
  // A status name, "accent", "series-1" to "series-3" or "neutral".
  color?: string;
}

export interface SeriesSpec {
  metric?: string;
  label?: string;
}

// ── Charts ───────────────────────────────────────────────────────────────────

export interface ChartSpec {
  title?: string;
  metric?: string;
  series?: SeriesSpec[];
  style?: "lines" | "stack" | "mirror";
}

// ── Tables ───────────────────────────────────────────────────────────────────

export interface ColumnSpec {
  name?: string;
  label?: string;
  field?: string;
  align?: string;
  sortable?: boolean;
  sort_field?: string;
  cell_color_by?: RuleRef<ItemColorRule>;
  toggle?: ToggleCellSpec;
}

export interface ToggleCellSpec {
  on?: unknown[];
  off?: unknown[];
  on_action_id?: string;
  off_action_id?: string;
  // Argument name to row field name.
  params?: Record<string, string>;
}

export interface RowActionSpec {
  id?: string;
  icon?: string;
  color?: string;
  tooltip?: string;
  visible_if?: RuleRef<EnabledPredicate>;
  kind?: string;
  dialog?: string;
  action_id?: string;
  params?: Record<string, string>;
  notify?: boolean;
  confirm?: string;
}

export interface TreeSpec {
  parent_field?: string;
  column?: string;
}

export interface TableSpec {
  row_key?: string;
  columns?: ColumnSpec[];
  row_actions?: RowActionSpec[];
  rows_attr?: string;
  source?: string;
  tree?: TreeSpec;
}

export interface FilterSpec {
  placeholder?: string;
  fields?: string[];
}

// ── Buttons, dialogs and jobs ────────────────────────────────────────────────

export interface ButtonSpec {
  id?: string;
  label?: string;
  icon?: string;
  color?: string;
  flat?: boolean;
  visible_if?: RuleRef<EnabledPredicate>;
  kind?: string;
  dialog?: string;
  notify?: boolean;
  confirm?: string;
}

export interface DialogFieldSpec {
  name: string;
  label?: string;
  placeholder?: string;
  default?: unknown;
  type?: string;
  options?: unknown[];
  options_attr?: string;
  default_attr?: string;
}

export interface DialogSpec {
  kind?: "read" | "edit" | "form";
  title?: string;
  render?: string;
  action_id?: string;
  params?: Record<string, string>;
  load_action_id?: string;
  load_params?: Record<string, string>;
  save_action_id?: string;
  save_params?: Record<string, string>;
  save_content_kwarg?: string;
  success_message?: string;
  fields?: DialogFieldSpec[];
  submit_label?: string;
  confirm?: string;
}

export interface JobPanelSpec {
  widget?: string;
  title?: string;
  run_label?: string;
  run_icon?: string;
  cancel_label?: string;
  cancel_icon?: string;
  enabled_if?: RuleRef<EnabledPredicate>;
  disabled_text?: string;
  run_action_id?: string;
  history_limit?: number;
  exclude_kinds?: string[];
}

// ── The page ─────────────────────────────────────────────────────────────────

// A layout row: widget names, or a name with its cell's overrides (visible, height, flex, min_width, title).
export type LayoutCell = string | ({ widget: string } & Record<string, unknown>);
export type LayoutRow = LayoutCell[];

export interface UISpec {
  layout?: LayoutRow[];
  cards?: Record<string, CardSpec>;
  chart?: ChartSpec;
  charts?: Record<string, ChartSpec>;
  events?: boolean | Record<string, unknown>;
  tables?: Record<string, TableSpec>;
  filters?: Record<string, FilterSpec>;
  buttons?: Record<string, ButtonSpec[]>;
  dialogs?: Record<string, DialogSpec>;
  job_panel?: JobPanelSpec;
}

// ── Header actions ───────────────────────────────────────────────────────────

// One header button from a plugin's get_actions(): an action, a toggle over a metric, or a dialog opener.
export interface ActionButtonSpec {
  action_id: string;
  name?: string;
  icon?: string;
  variant?: string;
  kind?: "toggle" | "dialog" | string;
  metric?: string;
  on_action_id?: string;
  off_action_id?: string;
  confirm?: string;
  job?: string | string[];
  dialog?: string;
  more?: boolean;
  detached?: boolean;
}
