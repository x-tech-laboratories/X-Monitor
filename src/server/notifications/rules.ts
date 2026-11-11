// When a monitor's status is worth a notification. A rule says which statuses count as a problem for one monitor, how
// many problem cycles in a row it takes to notify, whether to repeat while the problem lasts, and whether to announce
// the recovery. The tracker applies those rules to the stream of status writes, one per collection cycle.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_logger_for } from "../../core/logging.ts";
import { parse_duration } from "../../monitors/base/plugin_helpers.ts";
import { is_status, severity, type Status } from "../../shared/status.ts";
import { is_link, restates_children } from "../../core/coordination/monitor_graph.ts";
import type { NotifyingMonitor as TreeMonitor } from "./index.ts";

const log = create_logger_for("x_monitor.core.notifications.rules");

// ── Kinds ────────────────────────────────────────────────────────────────────

export const PROBLEM_STATUSES: readonly Status[] = ["failed", "warning", "unavailable"];
// The statuses a recovery lands in that read as recovered rather than as a new state.
export const HEALTHY_STATUSES: readonly string[] = ["online", "info"];

export const PROBLEM = "problem";
export const REMINDER = "reminder";
export const RECOVERED = "recovered";
export const FLAPPING = "flapping";
export const SETTLED = "settled";

// ── Rules ────────────────────────────────────────────────────────────────────

// How one monitor notifies.
export interface Rule {
  channels: string[];
  on: ReadonlySet<string>;
  after: number;
  repeat: number;
  recovery: boolean;
  // Seconds a problem must last, unbroken, before the first notification: the `for` setting.
  hold: number;
  // Problem starts and ends within `flap_window` that make a monitor flapping; 0 is off.
  flap_changes: number;
  flap_window: number;
}

export function make_rule(fields: Partial<Rule> & { channels: string[] }): Rule {
  return { on: new Set(["failed"]), after: 1, repeat: 0, recovery: true, hold: 0, flap_changes: 0, flap_window: 3600, ...fields };
}

// A stored status string as a Status, reading anything unknown as unavailable.
function status_value(value: string): Status {
  return is_status(value) ? value : "unavailable";
}

// A monitor's `notify:` value layered over the settings it inherits.
function merge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
  if (override === null || override === undefined || override === true) return base;
  if (override === false) return { ...base, enabled: false };
  if (typeof override === "object" && !Array.isArray(override)) return { ...base, enabled: true, ...(override as Record<string, unknown>) };
  log.error(`notify: expected true, false or a mapping, got ${JSON.stringify(override)}; ignoring it`);
  return base;
}

// Python's int(): a whole number from a number or a numeric string, throwing on anything else.
function as_int(value: unknown, key: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*[-+]?\d+\s*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(value)} (${key})`);
  return Math.trunc(number);
}

// Builds a Rule from merged settings, or null when notifications are off.
function build_rule(settings: Record<string, unknown>, channel_ids: string[], where: string): Rule | null {
  if (settings.enabled === false) return null;
  let channels = settings.channels ?? channel_ids;
  if (typeof channels === "string") channels = [channels];
  const listed = (Array.isArray(channels) ? channels : []).map(String);
  const known = listed.filter((channel) => channel_ids.includes(channel));
  for (const unknown of new Set(listed.filter((channel) => !known.includes(channel)))) {
    log.error(`${where}: notification channel ${JSON.stringify(unknown)} is not defined`);
  }
  if (known.length === 0) return null;

  let on = settings.on ?? ["failed"];
  if (typeof on === "string") on = [on];
  const on_list = (Array.isArray(on) ? on : []).map(String);
  const statuses = new Set(on_list.filter((status) => (PROBLEM_STATUSES as readonly string[]).includes(status)));
  for (const bad of new Set(on_list.filter((status) => !statuses.has(status)))) {
    log.error(`${where}: notify \`on\` value ${JSON.stringify(bad)} is not one of failed, warning, unavailable`);
  }

  try {
    const after = Math.max(1, as_int(settings.after ?? 1, "after"));
    const repeat = parse_duration(settings.repeat || 0, "repeat");
    const hold = parse_duration(settings.for || 0, "for");
    const flapping = settings.flapping || {};
    if (typeof flapping !== "object" || Array.isArray(flapping)) throw new Error("`flapping` must be a mapping with `changes` and `within`");
    const flap = flapping as Record<string, unknown>;
    const flap_changes = Math.max(0, as_int(flap.changes ?? 0, "changes"));
    const flap_window = parse_duration(flap.within ?? "1h", "within");
    return { channels: known, on: statuses, after, repeat, recovery: Boolean(settings.recovery ?? true), hold, flap_changes, flap_window };
  } catch (error) {
    log.error(`${where}: bad notify setting (${(error as Error).message}); notifications for it are off`);
    return null;
  }
}

// Every monitor's rule, keyed by monitor id. A group's `notify:` settings pass down to everything defined beneath it,
// not to monitors it only links to; a plain group never notifies for itself, since its status only repeats its children's.
export function resolve_rules(roots: Iterable<TreeMonitor>, defaults: Record<string, unknown>, channel_ids: string[]): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  const walk = (monitors: Iterable<TreeMonitor>, inherited: Record<string, unknown>) => {
    for (const monitor of monitors) {
      const settings = merge(inherited, (monitor.config ?? {}).notify);
      if (!restates_children(monitor)) {
        const rule = build_rule(settings, channel_ids, `monitor ${JSON.stringify(monitor.id)}`);
        if (rule !== null) rules.set(monitor.id, rule);
      }
      walk(monitor.children.filter((child) => !is_link(monitor, child)), settings);
    }
  };
  walk(roots, { ...defaults });
  return rules;
}

// ── Tracking ─────────────────────────────────────────────────────────────────

// One notification the tracker decided to send.
export interface Alert {
  kind: string;
  status: string;
  since: number;
  // A recovery that ends a spell of flapping.
  settled: boolean;
}

function alert(kind: string, status: string, since: number, settled = false): Alert {
  return { kind, status, since, settled };
}

interface State {
  alerting: boolean;
  status: Status;
  problem_cycles: number;
  since: number;
  last_sent: number;
  flapping: boolean;
  changes: number[];
}

function new_state(): State {
  return { alerting: false, status: "online", problem_cycles: 0, since: 0, last_sent: 0, flapping: false, changes: [] };
}

// Turns each monitor's status writes into the notifications its rule asks for.
export class Tracker {
  readonly rules: Map<string, Rule>;
  private readonly states = new Map<string, State>();

  constructor(rules: Map<string, Rule> | Record<string, Rule>) {
    this.rules = rules instanceof Map ? rules : new Map(Object.entries(rules));
  }

  private state_of(plugin_id: string): State {
    let state = this.states.get(plugin_id);
    if (state === undefined) {
      state = new_state();
      this.states.set(plugin_id, state);
    }
    return state;
  }

  // Starts from a status X-Monitor held before it restarted, so it is not announced again.
  seed(plugin_id: string, status: string, since: number, now: number): void {
    const rule = this.rules.get(plugin_id);
    if (rule === undefined) return;
    const state = this.state_of(plugin_id);
    if (rule.on.has(status)) {
      state.alerting = true;
      state.status = status_value(status);
      state.problem_cycles = rule.after;
      state.since = since;
      state.last_sent = now;
    }
  }

  // Whether the monitor currently has a problem its rule counts.
  alerting(plugin_id: string): boolean {
    return this.states.get(plugin_id)?.alerting ?? false;
  }

  // The problem a monitor has now, as an announcement, or null.
  problem(plugin_id: string): Alert | null {
    const state = this.states.get(plugin_id);
    if (!state?.alerting) return null;
    return alert(PROBLEM, state.status, state.since);
  }

  // Whether the monitor is flapping, with its notifications held until it settles.
  flapping(plugin_id: string): boolean {
    return this.states.get(plugin_id)?.flapping ?? false;
  }

  // Records one status write; returns the notification it triggers, if any.
  observe(plugin_id: string, status: string, now: number): Alert | null {
    const rule = this.rules.get(plugin_id);
    if (rule === undefined) return null;
    const state = this.state_of(plugin_id);
    const was_alerting = state.alerting;
    const found = this.transition(rule, state, status_value(status), now);
    if (!rule.flap_changes) return found;

    if (state.alerting !== was_alerting) state.changes.push(now);
    while (state.changes.length > 0 && now - state.changes[0]! > rule.flap_window) state.changes.shift();
    if (state.flapping) {
      if (state.changes.length > 0) return null;
      state.flapping = false;
      if (state.alerting) return alert(SETTLED, state.status, state.since);
      return alert(RECOVERED, state.status, state.since, true);
    }
    if (state.changes.length >= rule.flap_changes) {
      state.flapping = true;
      return alert(FLAPPING, state.status, state.since);
    }
    return found;
  }

  // Applies one status to the monitor's state; returns what the change alone would announce.
  private transition(rule: Rule, state: State, current: Status, now: number): Alert | null {
    // Not measuring says nothing about the problem: it neither ends it nor counts toward one.
    if (current === "unavailable" && !rule.on.has(current)) return null;
    if (!rule.on.has(current)) {
      state.problem_cycles = 0;
      if (!state.alerting) return null;
      state.alerting = false;
      state.status = current;
      return rule.recovery ? alert(RECOVERED, current, state.since) : null;
    }

    state.problem_cycles += 1;
    if (state.problem_cycles === 1) state.since = now;
    if (!state.alerting) {
      if (state.problem_cycles < rule.after || now - state.since < rule.hold) return null;
      state.alerting = true;
      state.status = current;
      state.last_sent = now;
      return alert(PROBLEM, current, state.since);
    }
    if (severity(current) > severity(state.status)) {
      state.status = current;
      state.last_sent = now;
      return alert(PROBLEM, current, state.since);
    }
    state.status = current;
    if (rule.repeat && now - state.last_sent >= rule.repeat) {
      state.last_sent = now;
      return alert(REMINDER, current, state.since);
    }
    return null;
  }
}
