// The pure geometry behind the chart widgets: how full a bar or gauge is, which strip cells are up, how a whole splits
// into shares, and how several histories line up on one axis. The server uses it to build a page's view and the page
// uses it to draw one, so it holds no DOM and no colours beyond Halon token names.

import type { Status } from "./status.ts";

// ── Shared geometry ──────────────────────────────────────────────────────────

// A gauge's arc opens at the bottom and sweeps this many degrees clockwise from its left end.
export const GAUGE_SWEEP_DEGREES = 270;

// How many past readings an uptime strip draws, one cell each.
export const STRIP_CELLS = 60;

// The gauge ring's radius in its 48-unit SVG box, leaving room for the 6-unit stroke.
export const GAUGE_RADIUS = 21;

// The length of the ring's 270° sweep, along which the dash is measured.
export const GAUGE_SWEEP_LENGTH = (2 * Math.PI * GAUGE_RADIUS * GAUGE_SWEEP_DEGREES) / 360;

// The Halon token each status is drawn with as a mark: a dot, a word, a table cell or a fill.
export const STATUS_COLORS: Record<Status | "offline", string> = {
  online: "var(--status-success)",
  info: "var(--status-info)",
  warning: "var(--status-warning-text)",
  failed: "var(--status-danger)",
  unavailable: "var(--text-tertiary)",
  offline: "var(--text-tertiary)",
};

export const ACCENT = "var(--accent)";

// The colours a widget may name by word instead of by status.
export const NAMED_COLORS: Record<string, string> = {
  accent: ACCENT,
  "series-1": "var(--series-1)",
  "series-2": "var(--series-2)",
  "series-3": "var(--series-3)",
  neutral: "var(--text-tertiary)",
};

export const TRACK_COLOR = "var(--surface-secondary)";

// How full a bar or gauge is, as a percentage clamped to 0–100; no reading is empty.
export function fill_percent(value: number | null | undefined, maximum = 100): number {
  if (value === null || value === undefined || !maximum) return 0;
  return Math.max(0, Math.min(100, (value / maximum) * 100));
}

// The CSS colour for a status name or a named colour, falling back to the accent.
export function color_for(name: string | null | undefined, fallback: string = ACCENT): string {
  if (name !== null && name !== undefined && Object.hasOwn(STATUS_COLORS, name)) return STATUS_COLORS[name as Status];
  if (name !== null && name !== undefined && Object.hasOwn(NAMED_COLORS, name)) return NAMED_COLORS[name];
  return fallback;
}

// The dash that draws a gauge's filled arc `percent` of the sweep long; an empty gauge draws nothing, since a
// zero-length round cap would still show a dot.
export function gauge_dash(percent: number): { stroke_visible: boolean; dash: string } {
  if (percent <= 0) return { stroke_visible: false, dash: "0 999" };
  return { stroke_visible: true, dash: `${((GAUGE_SWEEP_LENGTH * percent) / 100).toFixed(2)} 999` };
}

// ── Strips ───────────────────────────────────────────────────────────────────

export type StripState = "online" | "failed" | "unavailable" | "info";

// One state per strip cell, oldest first: online above `up_above`, failed at or below it, unavailable where there is
// no reading yet.
export function strip_states(values: readonly (number | null)[], up_above = 0.5, cells = STRIP_CELLS): StripState[] {
  const states: StripState[] = values
    .map((value): StripState => (value !== null && value !== undefined && value > up_above ? "online" : value === null || value === undefined ? "unavailable" : "failed"))
    .slice(-cells);
  return [...Array<StripState>(Math.max(0, cells - states.length)).fill("unavailable"), ...states];
}

// The share of measured cells that were up, as a percentage, or null before any reading.
export function up_share(states: readonly string[]): number | null {
  const measured = states.filter((state) => state !== "unavailable");
  if (measured.length === 0) return null;
  return (100 * measured.filter((state) => state === "online" || state === "info").length) / measured.length;
}

// The text beside a strip: its up share, or "--" before any reading.
export function up_share_text(states: readonly string[]): string {
  const share = up_share(states);
  return share === null ? "--" : `${share.toFixed(1)}% up`;
}

// The colour of one strip cell: its status colour, or the track colour where there is no data.
export function strip_cell_color(state: string): string {
  return state === "unavailable" ? TRACK_COLOR : STATUS_COLORS[state as Status];
}

// ── Shares ───────────────────────────────────────────────────────────────────

// Each part's share of the whole, as percentages; all zero while there is nothing to share.
export function share_percents(values: readonly (number | null | undefined)[]): number[] {
  const parts = values.map((value) => Math.max(0, value || 0));
  const total = parts.reduce((sum, part) => sum + part, 0);
  if (!total) return parts.map(() => 0);
  return parts.map((part) => (100 * part) / total);
}

// ── Series ───────────────────────────────────────────────────────────────────

export const SERIES_STYLES = ["lines", "stack", "mirror"] as const;
export type SeriesStyle = (typeof SERIES_STYLES)[number];

// Lines several metric histories up on the first one's timestamps, newest last, padding a shorter history at its old
// end with gaps.
export function align_series<Stamp>(histories: readonly (readonly [Stamp, number | null][])[]): [Stamp[], (number | null)[][]] {
  if (histories.length === 0 || histories[0].length === 0) return [[], histories.map(() => [])];
  const times = histories[0].map(([stamp]) => stamp);
  const columns = histories.map((history) => {
    const values = history.map(([, value]) => value).slice(-times.length);
    return [...Array<number | null>(times.length - values.length).fill(null), ...values];
  });
  return [times, columns];
}

// ── Card kinds ───────────────────────────────────────────────────────────────

// Card kinds the chart widgets draw, by the value of a card spec's `kind`.
export const CARD_KINDS = ["gauge", "share", "strip"] as const;

// The metrics a chart card reads from the latest readings on every refresh; a strip reads history instead.
export function card_metric_names(card_spec: { kind?: string; metric?: string; parts?: { metric?: string }[] }): string[] {
  if (card_spec.kind === "gauge") return [String(card_spec.metric)];
  if (card_spec.kind === "share") return (card_spec.parts ?? []).map((part) => String(part.metric));
  return [];
}
