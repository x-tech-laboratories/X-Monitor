// Maintenance windows: times when chosen monitors send no problem notifications. A window recurs daily between two
// times of day, optionally on chosen weekdays, or runs once between two dates, in the server's local time. A problem
// that begins during a window and is still there when it ends is announced then.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_logger_for } from "../../core/logging.ts";

const log = create_logger_for("x_monitor.core.notifications.maintenance");

// ── Shapes ───────────────────────────────────────────────────────────────────

// Monday first, as Python's weekday() counts.
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

// Seconds since midnight.
type TimeOfDay = number;

// One maintenance window.
export class Window {
  readonly name: string;
  readonly monitors: ReadonlySet<string> | null;
  readonly days: ReadonlySet<number> | null;
  readonly daily_from: TimeOfDay | null;
  readonly daily_to: TimeOfDay | null;
  readonly start: Date | null;
  readonly end: Date | null;

  constructor(fields: { name: string; monitors?: ReadonlySet<string> | null; days?: ReadonlySet<number> | null; daily_from?: TimeOfDay | null; daily_to?: TimeOfDay | null; start?: Date | null; end?: Date | null }) {
    this.name = fields.name;
    this.monitors = fields.monitors ?? null;
    this.days = fields.days ?? null;
    this.daily_from = fields.daily_from ?? null;
    this.daily_to = fields.daily_to ?? null;
    this.start = fields.start ?? null;
    this.end = fields.end ?? null;
  }

  // Whether the window is in effect at `now`.
  active(now: Date): boolean {
    if (this.start !== null) return this.start <= now && now < this.end!;
    const moment = seconds_of_day(now);
    const from = this.daily_from!;
    const to = this.daily_to!;
    if (from <= to) return from <= moment && moment < to && this.on(now);
    // A window past midnight belongs to the day it started on.
    if (moment >= from) return this.on(now);
    return moment < to && this.on(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  }

  private on(day: Date): boolean {
    return this.days === null || this.days.has(weekday(day));
  }

  // The window's schedule in words, such as "Sun 03:00-05:00".
  describe(): string {
    if (this.start !== null) return `${stamp(this.start)} to ${stamp(this.end!)}`;
    const days = this.days === null ? "Daily" : [...this.days].sort((a, b) => a - b).map((day) => title(DAYS[day]!)).join(", ");
    return `${days} ${clock(this.daily_from!)}-${clock(this.daily_to!)}`;
  }

  // Whether the window applies to a monitor, given its id followed by its groups' ids.
  covers(monitor_ids: string[]): boolean {
    return this.monitors === null || monitor_ids.some((id) => this.monitors!.has(id));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function weekday(day: Date): number {
  return (day.getDay() + 6) % 7;
}

function seconds_of_day(moment: Date): number {
  return moment.getHours() * 3600 + moment.getMinutes() * 60 + moment.getSeconds() + moment.getMilliseconds() / 1000;
}

const two = (value: number) => String(value).padStart(2, "0");

function clock(seconds: TimeOfDay): string {
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor((seconds % 3600) / 60))}`;
}

function stamp(moment: Date): string {
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())} ${two(moment.getHours())}:${two(moment.getMinutes())}`;
}

function title(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function time_of_day(value: unknown, key: string): TimeOfDay {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(String(value));
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  const seconds = Number(match?.[3] ?? 0);
  if (match === null || hours > 23 || minutes > 59 || seconds > 59) throw new Error(`\`${key}\` must be a time of day such as "03:00", not ${JSON.stringify(value)}`);
  return hours * 3600 + minutes * 60 + seconds;
}

function date_time(value: unknown, key: string): Date {
  if (value instanceof Date) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value ?? ""));
  if (match === null) throw new Error(`\`${key}\` must be a date and time such as 2026-10-01T09:00, not ${JSON.stringify(value ?? null)}`);
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0));
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// Builds one window from its config entry, throwing if it is malformed.
export function window(entry: Record<string, unknown>): Window {
  const name = String(entry.name || "maintenance");
  let monitors = entry.monitors;
  if (typeof monitors === "string") monitors = [monitors];
  const covered = Array.isArray(monitors) && monitors.length > 0 ? new Set(monitors.map(String)) : null;

  if (entry.start != null || entry.end != null) {
    const start = date_time(entry.start, "start");
    const end = date_time(entry.end, "end");
    if (end <= start) throw new Error("`end` must come after `start`");
    return new Window({ name, monitors: covered, start, end });
  }

  if (entry.from == null || entry.to == null) throw new Error("give `from` and `to` for a daily window, or `start` and `end` for a one-off one");
  let days = entry.days;
  if (typeof days === "string") days = [days];
  let weekdays: Set<number> | null = null;
  if (Array.isArray(days) && days.length > 0) {
    const unknown = days.filter((day) => !(DAYS as readonly string[]).includes(String(day).toLowerCase().slice(0, 3)));
    if (unknown.length > 0) throw new Error(`\`days\` must be weekday names such as mon or tuesday, not ${JSON.stringify(unknown)}`);
    weekdays = new Set(days.map((day) => (DAYS as readonly string[]).indexOf(String(day).toLowerCase().slice(0, 3))));
  }
  const daily_from = time_of_day(entry.from, "from");
  const daily_to = time_of_day(entry.to, "to");
  if (daily_from === daily_to) throw new Error("`from` and `to` must differ");
  return new Window({ name, monitors: covered, days: weekdays, daily_from, daily_to });
}

// Every well-formed window; a malformed one is logged and left out.
export function parse_windows(entries: unknown): Window[] {
  const windows: Window[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // One bad window must not stop the others from applying.
    try {
      if (typeof entry !== "object" || entry === null) throw new Error("expected a mapping");
      windows.push(window(entry as Record<string, unknown>));
    } catch (error) {
      const label = typeof entry === "object" && entry !== null ? ((entry as Record<string, unknown>).name ?? entry) : entry;
      log.error(`notifications: maintenance window ${JSON.stringify(label)} ignored: ${(error as Error).message}`);
    }
  }
  return windows;
}
