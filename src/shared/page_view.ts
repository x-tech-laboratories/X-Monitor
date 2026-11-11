// The JSON a monitor's page is drawn from, and the small pure rules both sides apply to it. The server resolves a
// monitor's UI_SPEC, custom_view() and readings into these shapes (src/server/views/); the page only draws them, runs
// the actions they name, and fills each `{row[field]}` from the row a click came from.

import { python_format, python_str } from "@x-tech-laboratories/x-libs/python_text";

import type { SortColumn, TableRow } from "./table_rows.ts";
import type { StripState } from "./charts.ts";
import type { Status } from "./status.ts";

// ── Marks ────────────────────────────────────────────────────────────────────

// The badge tone each monitor state is drawn with; a state with no fill of its own stays neutral.
export const STATUS_BADGES: Record<string, BadgeTone> = { online: "good", info: "info", failed: "bad", warning: "warn" };

export type BadgeTone = "none" | "good" | "info" | "warn" | "bad";

// How a value takes its status: a state word becomes a badge, a measured number takes the status colour.
export function state_mark(text: string): "badge" | "color" {
  return /\d/.test(text) ? "color" : "badge";
}

// ── Layout ───────────────────────────────────────────────────────────────────

export interface CellConfig {
  flex: number;
  visible: boolean;
  height: string | null;
  min_width: string;
  title: string | null;
}

export interface CellView extends CellConfig {
  widget: string;
  content: WidgetView[];
}

export interface RowView {
  // Every cell of the row is hidden, so the row takes no room.
  hidden: boolean;
  cells: CellView[];
}

// ── Widgets ──────────────────────────────────────────────────────────────────

export interface ValueCardView {
  type: "value";
  title: string;
  text: string;
  state: Status | null;
}

export interface GaugeView {
  type: "gauge";
  title: string;
  text: string;
  percent: number;
  state: Status | null;
  caption: string | null;
}

export interface SharePartView {
  label: string;
  text: string;
  percent: number;
  // A status name, "accent", "series-1" to "series-3" or "neutral".
  color: string;
}

export interface ShareView {
  type: "share";
  title: string;
  parts: SharePartView[];
}

export interface StripRowView {
  label: string | null;
  states: StripState[];
  share_text: string;
}

export interface StripView {
  type: "strip";
  title: string;
  cells: number;
  rows: StripRowView[];
}

export interface RepeatItemView {
  label: string;
  value: string;
  state: Status | null;
  percent: number;
}

export interface RepeatView {
  type: "repeat";
  title: string | null;
  // "chips", "bars", "tiles" or anything else for small info cards.
  container: string;
  items: RepeatItemView[];
  empty_text: string;
  marker: number | null;
}

export interface ChartView {
  type: "chart";
  title: string;
  style: "lines" | "stack" | "mirror";
  // When each reading was taken, in epoch seconds, newest last.
  times: number[];
  series: { label: string; values: (number | null)[] }[];
}

export interface FeedRow {
  timestamp: string;
  level: string;
  message: string;
  target?: string;
}

export interface FeedView {
  type: "feed";
  title: string;
  rows: FeedRow[];
  full_height: boolean;
}

export interface ToggleView {
  on_action_id: string;
  off_action_id: string;
  params: Record<string, string>;
}

export interface ColumnView extends SortColumn {
  label: string;
  field: string;
  align: string;
  sortable: boolean;
  // The column colours its cells by state, read from the row's `_color_<name>`.
  colored: boolean;
  toggle: ToggleView | null;
}

export interface RowActionView {
  id: string;
  icon: string;
  danger: boolean;
  tooltip: string;
  kind: string | null;
  dialog: string | null;
  action_id: string;
  params: Record<string, string>;
  notify: boolean;
  confirm: string | null;
}

export interface TableView {
  type: "table";
  monitor_id: string;
  title: string | null;
  row_key: string;
  columns: ColumnView[];
  rows: TableRow[];
  row_actions: RowActionView[];
  filter_placeholder: string;
  filter_fields: string[];
  tree: { parent_field: string; column: string } | null;
}

export interface ButtonView {
  id: string;
  label: string;
  icon: string | null;
  flat: boolean;
  danger: boolean;
  kind: string | null;
  dialog: string | null;
  notify: boolean;
  confirm: string | null;
}

export interface ButtonsView {
  type: "buttons";
  monitor_id: string;
  title: string | null;
  buttons: ButtonView[];
}

export interface JobRowView {
  id: number;
  started: string;
  kind: string;
  state: string;
  duration: string;
  duration_seconds: number;
}

export interface JobPanelView {
  type: "jobs";
  monitor_id: string;
  title: string;
  run: { label: string; icon: string; enabled: boolean; action_id: string } | null;
  cancel: { label: string; icon: string; visible: boolean } | null;
  progress: { text: string; state: Status | null };
  rows: JobRowView[];
}

export interface SectionTitleView {
  type: "section";
  title: string;
}

// A whole monitor drawn inside another's page, such as a group's child.
export interface NestedBodyView {
  type: "body";
  monitor_id: string;
  body: BodyView;
}

// The journal's search bar and table, over one or several journal monitors.
export interface LogSearchView {
  type: "log_search";
  monitors: { id: string; target: string }[];
  show_host: boolean;
  default_limit: number;
}

// The borg archive browser.
export interface BrowserView {
  type: "browser";
  monitor_id: string;
  archives: string[];
  restore_dir: string;
  browse_limit: number;
}

// A cell a custom view fills itself.
export interface SlotView {
  type: "slot";
  name: string;
}

export type WidgetView =
  | ValueCardView | GaugeView | ShareView | StripView | RepeatView | ChartView | FeedView | TableView | ButtonsView
  | JobPanelView | SectionTitleView | NestedBodyView | LogSearchView | BrowserView | SlotView;

// ── Dialogs ──────────────────────────────────────────────────────────────────

export interface DialogFieldView {
  name: string;
  label: string;
  placeholder: string;
  type: "text" | "checkbox" | "select";
  // A select's choices as [value, label] pairs.
  options: [value: string, label: string][];
  default: unknown;
}

// A dialog spec with every `{plugin.attr}` already filled; `{row[field]}` waits for the row it opens on.
export interface DialogView {
  kind: "read" | "edit" | "form";
  title: string;
  render: string | null;
  action_id: string | null;
  params: Record<string, string>;
  load_action_id: string | null;
  load_params: Record<string, string>;
  save_action_id: string | null;
  save_params: Record<string, string>;
  save_content_kwarg: string;
  success_message: string;
  fields: DialogFieldView[];
  submit_label: string;
  confirm: string | null;
}

// ── A monitor's page ─────────────────────────────────────────────────────────

export interface ChildCardView {
  id: string;
  label: string;
  state: Status;
  open: boolean;
  col_span: number;
  height: string | null;
  min_width: string;
  // Drawn only while the card is open.
  body: BodyView | null;
}

export interface BodyView {
  monitor_id: string;
  rows: RowView[];
  // One collapsible card per child, for a monitor that holds children and no layout of its own for them.
  children: ChildCardView[];
  // A page the monitor draws itself: `kind` names the React view, `data` is the monitor's own and `extra` what the
  // server read for it.
  custom: { kind: string; data: unknown; extra: Record<string, unknown> } | null;
}

export type ActionState = "normal" | "accent" | "disabled" | "hidden";

export interface HeaderActionView {
  action_id: string;
  name: string;
  icon: string;
  danger: boolean;
  kind: string | null;
  dialog: string | null;
  confirm: string | null;
  more: boolean;
  state: ActionState;
  // A toggle's state metric: pressed, released, or null before it has been read.
  toggle: { pressed: boolean | null; on_action_id: string; off_action_id: string } | null;
}

export interface MuteView {
  // Notifications go somewhere, so the toggle is shown at all.
  present: boolean;
  maintenance: string | null;
  // The group that mutes this monitor, when it is not the monitor itself.
  muted_by: string | null;
  sending: boolean;
}

export interface MonitorPageView {
  id: string;
  name: string;
  lede: string;
  schedule: string[];
  actions: HeaderActionView[];
  more: { visible: boolean; filled: boolean };
  cancel: { present: boolean; visible: boolean };
  mute: MuteView;
  body: BodyView;
  // Every dialog a button, row or action on this page opens, by monitor id and dialog name.
  dialogs: Record<string, Record<string, DialogView>>;
}

// ── Templates ────────────────────────────────────────────────────────────────

// Fills a dialog title or confirm template from the row and the plugin's attributes, a missing attribute reading as
// empty; `plugin` is either the attributes or a lookup that reads them.
export function substitute(template: string, row: TableRow | null, plugin: Record<string, unknown> | ((key: string) => unknown) = {}): string {
  const read = typeof plugin === "function" ? plugin : (key: string) => plugin[key];
  const proxy = (key: string): unknown => {
    const value = read(key);
    return value === undefined || value === null ? "" : value;
  };
  return python_format(template, [], { row: row ?? {}, plugin: proxy });
}

// ── Outcomes and forms ───────────────────────────────────────────────────────

// What to tell the user after an action: its own short message when it gave one, else whether it worked.
export function outcome_notice(label: string, success: boolean, content: string): string {
  if (content && content.length <= 200) return content;
  return `${label} ${success ? "succeeded" : "failed"}`;
}

// Each form input's value by field name, text trimmed and checkboxes kept as booleans.
export function form_values(inputs: Record<string, unknown>): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, typeof value === "boolean" ? value : value === null || value === undefined || value === "" ? "" : python_str(value).trim()]));
}

// Whether a toggle cell shows pressed for a row value: on, off, or null when the value is neither.
export function toggle_position(toggle: { on?: unknown[]; off?: unknown[] }, value: unknown): boolean | null {
  if ((toggle.on ?? []).includes(value)) return true;
  if ((toggle.off ?? []).includes(value)) return false;
  return null;
}

// The arguments an action takes from a row: each argument name mapped to that row's field.
export function row_params(params: Record<string, string>, row: TableRow | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([argument, field]) => [argument, (row ?? {})[field] ?? null]));
}

// A row action's label in its notice: its tooltip or id, in words with each word capitalised.
export function title_words(text: string): string {
  return text.replaceAll("_", " ").toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_whole, before: string, letter: string) => before + letter.toUpperCase());
}

// ── Replies ──────────────────────────────────────────────────────────────────

// What the server answers an action, poll, toggle or cancel with: how it went, the toast to show, and the detached job
// it started, whose live log the page then opens.
export interface ActionReply {
  success: boolean;
  content: string;
  notice: string;
  tone: "positive" | "negative" | "warning" | "info";
  job_id: number | null;
}
