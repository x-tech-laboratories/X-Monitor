// Triggered actions: a monitor's `triggers` list, each entry one of its actions run when a cycle shows a condition on
// its status or one of its metrics. An entry runs once each time its condition becomes true and has held for `for`,
// and is armed again once it clears. Parsing and the decision are pure; the engine keeps each entry's state.

import { format_duration, parse_duration } from "../../monitors/base/plugin_helpers.ts";
import { is_status, statuses } from "../../shared/status.ts";
import type { CollectResult } from "../connectors/types.ts";
import { python_json } from "./schedule.ts";

// ── Conditions ───────────────────────────────────────────────────────────────

const comparisons = {
  above: [">", (value: number, limit: number) => value > limit],
  below: ["<", (value: number, limit: number) => value < limit],
  equals: ["=", (value: number, limit: number) => value === limit],
} as const;

type Comparison = keyof typeof comparisons;

// What a trigger watches: a set of statuses, or a metric compared with a limit.
export class Condition {
  readonly statuses: ReadonlySet<string>;
  readonly metric: string | null;
  readonly comparison: Comparison | null;
  readonly limit: number;

  constructor(fields: { statuses?: Iterable<string>; metric?: string | null; comparison?: Comparison | null; limit?: number }) {
    this.statuses = new Set(fields.statuses ?? []);
    this.metric = fields.metric ?? null;
    this.comparison = fields.comparison ?? null;
    this.limit = fields.limit ?? 0;
  }

  // Whether the cycle shows the condition, or null when it did not report what the condition watches.
  holds(result: CollectResult): boolean | null {
    if (this.metric === null) return result.status === null ? null : this.statuses.has(String(result.status));
    const value = result.metrics[this.metric];
    if (value === undefined || value === null) return null;
    return comparisons[this.comparison!][1](Number(value), this.limit);
  }

  // The condition in words, such as "status is failed or warning" or "up_to_date < 1".
  describe(): string {
    if (this.metric === null) return `status is ${[...this.statuses].sort().join(" or ")}`;
    return `${this.metric} ${comparisons[this.comparison!][0]} ${python_number(this.limit)}`;
  }
}

// A number as Python's "{:g}" writes it.
function python_number(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
  return String(Number(value.toPrecision(6)));
}

function parse_condition(entry: Record<string, unknown>, action: string): Condition {
  if (("status" in entry) === ("metric" in entry)) throw new Error(`the triggered '${action}' needs exactly one of \`status\` or \`metric\``);
  if ("status" in entry) {
    const names = Array.isArray(entry.status) ? entry.status : [entry.status];
    const found = new Set<string>();
    for (const name of names) {
      const text = String(name);
      if (!is_status(text)) throw new Error(`the triggered '${action}' names an unknown status '${text}'; use ${statuses.join(", ")}`);
      found.add(text);
    }
    if (found.size === 0) throw new Error(`the triggered '${action}' needs at least one status`);
    return new Condition({ statuses: found });
  }
  const given = (Object.keys(comparisons) as Comparison[]).filter((key) => key in entry);
  if (given.length !== 1) throw new Error(`the triggered '${action}' needs exactly one of \`above\`, \`below\` or \`equals\``);
  const limit = Number(entry[given[0]]);
  if (entry[given[0]] === null || entry[given[0]] === "" || Number.isNaN(limit)) throw new Error(`\`${given[0]}\` of the triggered '${action}' must be a number`);
  return new Condition({ metric: String(entry.metric), comparison: given[0], limit });
}

// ── A monitor's triggers ─────────────────────────────────────────────────────

export interface TriggerState {
  since?: number;
  fired?: boolean;
}

export class TriggeredAction {
  readonly action: string;
  readonly condition: Condition;
  // Seconds the condition must hold before the action runs.
  readonly hold: number;
  readonly args: Record<string, unknown>;

  constructor(action: string, condition: Condition, hold = 0, args: Record<string, unknown> = {}) {
    this.action = action;
    this.condition = condition;
    this.hold = hold;
    this.args = args;
  }

  describe(): string {
    const text = `when ${this.condition.describe()}`;
    return this.hold ? `${text} for ${format_duration(this.hold)}` : text;
  }

  // The settings key holding this entry's state; a changed condition, hold or argument starts afresh.
  state_key(plugin_id: string): string {
    let key = `trigger:${plugin_id}:${this.action}:${this.describe()}`;
    if (Object.keys(this.args).length > 0) key += `:${python_json(this.args)}`;
    return key;
  }

  result_key(plugin_id: string): string {
    return `trigger-result:${this.state_key(plugin_id).slice("trigger:".length)}`;
  }

  // The entry's next state after a cycle, and whether to run the action now; a cycle that did not report what the
  // entry watches leaves the state as it was.
  step(state: TriggerState, holds: boolean | null, now: number): [TriggerState, boolean] {
    if (holds === null) return [state, false];
    if (!holds) return [{}, false];
    const since = state.since ?? now;
    if (state.fired || now - since < this.hold) return [{ since, fired: Boolean(state.fired) }, false];
    return [{ since, fired: true }, true];
  }
}

// Reads a monitor's `triggers` list, throwing on a malformed entry.
export function parse_triggers(value: unknown): TriggeredAction[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error("`triggers` must be a list of {action, status | metric} entries");
  return value.map((entry: unknown) => {
    const record = entry as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null || Array.isArray(record) || !record.action) {
      throw new Error(`each \`triggers\` entry needs an \`action\`, not ${JSON.stringify(entry)}`);
    }
    const action = String(record.action);
    const args = record.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error(`\`args\` of the triggered '${action}' must be a mapping`);
    const hold = parse_duration(record.for ?? 0, "for");
    return new TriggeredAction(action, parse_condition(record, action), hold, { ...(args as Record<string, unknown>) });
  });
}
