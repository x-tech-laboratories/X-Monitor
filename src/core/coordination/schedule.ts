// Scheduled actions: a monitor's `schedule` list, each entry one of its actions run at the times a cron expression
// names, in local time. Parsing and the next-run calculation are pure; the engine's schedule loop runs them and keeps
// each entry's last handled time in the settings store.

import { CronSchedule } from "@x-tech-laboratories/x-libs/cron";

export { CronSchedule } from "@x-tech-laboratories/x-libs/cron";

// One `schedule` entry: the action to run, when, and the arguments to pass it.
export class ScheduledAction {
  readonly action: string;
  readonly cron: CronSchedule;
  readonly args: Record<string, unknown>;

  constructor(action: string, cron: CronSchedule, args: Record<string, unknown> = {}) {
    this.action = action;
    this.cron = cron;
    this.args = args;
  }

  // The settings key holding this entry's last handled time; a changed expression or argument starts afresh.
  state_key(plugin_id: string): string {
    let key = `schedule:${plugin_id}:${this.action}:${this.cron.expression}`;
    if (Object.keys(this.args).length > 0) key += `:${python_json(this.args)}`;
    return key;
  }

  // The settings key holding this entry's last run: when it started, whether it succeeded, and what it logged.
  result_key(plugin_id: string): string {
    return `schedule-result:${this.state_key(plugin_id).slice("schedule:".length)}`;
  }

  // Whether a run fell after the last handled time, in epoch seconds, and no later than now.
  due(handled: number, now: number): boolean {
    const upcoming = this.cron.next_after(new Date(handled * 1000));
    return upcoming !== null && upcoming.getTime() / 1000 <= now;
  }
}

// Reads a monitor's `schedule` list, throwing on a malformed entry.
export function parse_schedule(value: unknown): ScheduledAction[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error("`schedule` must be a list of {action, cron} entries");
  return value.map((entry: unknown) => {
    const record = entry as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null || Array.isArray(record) || !record.action || !record.cron) {
      throw new Error(`each \`schedule\` entry needs an \`action\` and a \`cron\`, not ${JSON.stringify(entry)}`);
    }
    const args = record.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error(`\`args\` of the scheduled '${String(record.action)}' must be a mapping`);
    return new ScheduledAction(String(record.action), CronSchedule.parse(String(record.cron)), { ...(args as Record<string, unknown>) });
  });
}

// JSON with sorted keys and Python's ", " and ": " separators, so settings keys written by the Python app still match.
export function python_json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(python_json).join(", ")}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}: ${python_json((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(", ")}}`;
}
