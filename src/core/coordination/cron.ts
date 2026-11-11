// Five-field cron expressions read in local time: minute, hour, day of month, month, day of week, with the @daily
// style aliases and month and weekday names.

const aliases: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const month_names: Record<string, number> = Object.fromEntries(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map((name, index) => [name, index + 1]),
);

const weekday_names: Record<string, number> = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((name, index) => [name, index]));

// Long enough to reach a 29 February across a century year that skips its leap day.
const search_days = 366 * 9;

function field_value(text: string, names: Record<string, number>, label: string): number {
  const lowered = text.toLowerCase();
  if (Object.hasOwn(names, lowered)) return names[lowered];
  if (!/^\d+$/.test(text)) throw new Error(`${label} has an unrecognised value '${text}'`);
  return Number(text);
}

// Expands one field, such as "*/15", "1-5" or "mon,wed", into the values it allows.
function parse_field(text: string, low: number, high: number, label: string, names: Record<string, number> = {}): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const slash = part.indexOf("/");
    const base = slash === -1 ? part : part.slice(0, slash);
    const step_text = slash === -1 ? "" : part.slice(slash + 1);
    let step = 1;
    if (step_text) {
      if (!/^\d+$/.test(step_text) || Number(step_text) === 0) throw new Error(`${label} has a bad step '${step_text}'`);
      step = Number(step_text);
    }
    let start: number;
    let end: number;
    if (base === "*") {
      start = low;
      end = high;
    } else if (base.includes("-")) {
      const dash = base.indexOf("-");
      start = field_value(base.slice(0, dash), names, label);
      end = field_value(base.slice(dash + 1), names, label);
    } else {
      start = field_value(base, names, label);
      // A lone value with a step, as in "5/10", runs from that value to the end of the range.
      end = step_text ? high : start;
    }
    if (!(low <= start && start <= high && low <= end && end <= high) || start > end) throw new Error(`${label} value '${base}' is outside ${low}-${high}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export class CronSchedule {
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly any_day: boolean;
  readonly any_weekday: boolean;

  private constructor(expression: string, fields: string[]) {
    const [minute, hour, day, month, weekday] = fields;
    this.expression = expression;
    this.minutes = parse_field(minute, 0, 59, "minute");
    this.hours = parse_field(hour, 0, 23, "hour");
    this.days = parse_field(day, 1, 31, "day of month");
    this.months = parse_field(month, 1, 12, "month", month_names);
    // Cron allows 7 as a second name for Sunday.
    this.weekdays = new Set([...parse_field(weekday, 0, 7, "day of week", weekday_names)].map((value) => (value === 7 ? 0 : value)));
    this.any_day = day.startsWith("*");
    this.any_weekday = weekday.startsWith("*");
  }

  // Reads an expression such as "30 2 * * *" or "@daily", throwing when it is malformed or never matches.
  static parse(expression: string): CronSchedule {
    const text = String(expression).trim();
    const fields = (aliases[text.toLowerCase()] ?? text).split(/\s+/).filter((field) => field !== "");
    if (fields.length !== 5) throw new Error(`cron expression '${text}' needs five fields: minute hour day-of-month month day-of-week`);
    const schedule = new CronSchedule(text, fields);
    if (schedule.next_after(new Date(2000, 0, 1)) === null) throw new Error(`cron expression '${text}' never matches a real date`);
    return schedule;
  }

  // Whether it runs on this date; a restricted day of month and day of week match either, as cron does.
  matches_day(day: Date): boolean {
    if (!this.months.has(day.getMonth() + 1)) return false;
    const weekday = day.getDay();
    if (this.any_day && this.any_weekday) return true;
    if (this.any_day) return this.weekdays.has(weekday);
    if (this.any_weekday) return this.days.has(day.getDate());
    return this.days.has(day.getDate()) || this.weekdays.has(weekday);
  }

  // The first run strictly after `moment`, in local time, or null when there is none.
  next_after(moment: Date): Date | null {
    const start = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours(), moment.getMinutes() + 1);
    const hours = [...this.hours].sort((a, b) => a - b);
    const minutes = [...this.minutes].sort((a, b) => a - b);
    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (let step = 0; step < search_days; step++) {
      if (this.matches_day(day)) {
        for (const hour of hours) {
          for (const minute of minutes) {
            const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
            if (candidate >= start) return candidate;
          }
        }
      }
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    }
    return null;
  }
}
