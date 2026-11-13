// The Plugin contract every monitor derives from. A plugin is pure: it declares its IO as data (requests() or
// commands()), parses connector results into a CollectResult (parse_results() or parse()), plans and interprets
// actions, and describes its page with UI_SPEC, while the Coordination Engine owns every connector, write and side
// effect. Agent-backed targets add push: subscriptions() declares event streams, and SAMPLED lets the agent run a
// single-command plugin itself and push results. Any monitor can hold children: polling it from the page polls them
// first, and child_statuses() reads their latest statuses, which lets an aggregating plugin fold them.
//
// The page is drawn in the browser, so where the Python app's render_ui() built widgets, a plugin here describes its
// page as data: UI_SPEC for the declarative page, and custom_view() for the few with a page of their own.

import { action_id_of, WATCHED_POLL_SECONDS, type JobsGateway } from "../../core/coordination/jobs.ts";
import type { PluginDataView } from "../../core/coordination/data_view.ts";
import { parse_schedule, type ScheduledAction } from "../../core/coordination/schedule.ts";
import { parse_triggers, type TriggeredAction } from "../../core/coordination/triggers.ts";
import { cmd_result, COLLECT_TIMEOUT, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command, type Request, type Result } from "../../core/connectors/types.ts";
import type { EngineLike } from "../../core/contracts.ts";
import { create_logger_for } from "../../core/logging.ts";
import type { JobDict } from "../../core/state/records.ts";
import type { StreamSpec } from "../../shared/agent_protocol.ts";
import type { ActionButtonSpec, UISpec } from "../../shared/ui_spec.ts";
import { parse_custom_actions, type CustomAction } from "./custom_actions.ts";
import { parse_duration, type PluginConfig } from "./plugin_helpers.ts";

const log = create_logger_for("x_monitor.plugins.base.plugin_base");

// A page a plugin draws itself: `kind` names the page's React view and `data` is everything it needs, made fresh on
// each refresh.
export interface CustomView {
  kind: string;
  data: unknown;
}

// How the header shows an action now.
export type ActionState = "normal" | "accent" | "disabled" | "hidden";

// What a plugin hands its page header.
export interface Presented {
  name: string;
  target: string;
  actions: ActionButtonSpec[];
}

export abstract class Plugin {
  // ── Identity and config ──────────────────────────────────────────────────

  name: string;
  id: string;
  config: PluginConfig;
  // Seconds between cycles.
  interval: number;
  // Pins polls to the clock: a cycle runs when UTC time is this far past a multiple of interval.
  offset: number | null;
  scheduled_actions: ScheduledAction[];
  triggered_actions: TriggeredAction[];
  children: Plugin[] = [];
  // Children this monitor holds through a link, by id, with the label that link gives them.
  links = new Map<string, string | null>();
  // The host it collects on; the engine sets it to the transport's own once wired.
  target: string;
  timeout: number;
  custom_actions: CustomAction[];

  // ── Wired by the engine ──────────────────────────────────────────────────

  engine: EngineLike | null = null;
  // The read-only projection of stored state; the one handle a pure plugin holds into it.
  data!: PluginDataView;
  // Detached-job control scoped to this plugin.
  jobs: JobsGateway | null = null;

  // ── Class settings ───────────────────────────────────────────────────────

  // The host this monitor is about, when that is not the one it collects on, such as a scan run from elsewhere.
  display_target: string | null = null;
  // An availability monitor measures reachability itself, so an unreachable host is its failed verdict.
  readonly AVAILABILITY: boolean = false;
  // Whether a monitor of this type can run on its host's own agent: it only runs commands on that host.
  readonly RUNS_ON_AGENT: boolean = true;
  // Collect on the agent: it runs commands() itself at this monitor's interval and pushes each result.
  readonly SAMPLED: boolean = false;
  // Seconds between cycles while one of this plugin's jobs runs, when sooner than `interval`.
  job_poll_interval: number | null = null;
  // Job kinds this plugin runs beside its main job; jobs.running() never returns one.
  readonly SIDE_JOB_KINDS: readonly string[] = [];
  // Suffix of the generic sample stream's id.
  readonly SAMPLE_STREAM: string = "sample";
  // Intervals a sample stream may stay quiet before the agent pushes anyway.
  readonly SAMPLE_MAX_QUIET_INTERVALS: number = 5;

  // Takes only its name and config; the engine wires all IO and persistence afterwards.
  constructor(name: string, config: PluginConfig) {
    this.name = name;
    this.id = String(config.id ?? name);
    this.config = config;
    this.interval = parse_duration(config.interval ?? 60, "interval");
    this.offset = "offset" in config && config.offset !== undefined ? parse_duration(config.offset, "offset") : null;
    this.scheduled_actions = parse_schedule(config.schedule);
    this.triggered_actions = parse_triggers(config.triggers);
    const ssh_config = (config.ssh_config ?? {}) as Record<string, unknown>;
    this.target = String(ssh_config.host ?? config.target_host ?? "localhost");
    this.timeout = parse_duration(config.timeout ?? COLLECT_TIMEOUT, "timeout");
    this.custom_actions = parse_custom_actions(config.actions);
  }

  // Whether this monitor's status only repeats its children's, so it never notifies and is not counted on its own.
  get restates_children(): boolean {
    return false;
  }

  bind(data: PluginDataView): void {
    this.data = data;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  // The declarative page; null for a plugin without one.
  get UI_SPEC(): UISpec | null {
    return null;
  }

  // A page of its own, for the few plugins the declarative page cannot draw.
  custom_view(): CustomView | null {
    return null;
  }

  // ── Scheduling ───────────────────────────────────────────────────────────

  // Seconds until the next cycle when sooner than `interval`: job_poll_interval while a job runs, and every few
  // seconds while someone has a running job's log open.
  next_cycle_in(): number | null {
    if (!this.jobs) return null;
    if (this.jobs.watched()) return Math.min(WATCHED_POLL_SECONDS, this.job_poll_interval || WATCHED_POLL_SECONDS);
    if (this.job_poll_interval === null) return null;
    if (this.jobs.is_running() || this.SIDE_JOB_KINDS.some((kind) => this.jobs!.running_side(kind) !== null)) return this.job_poll_interval;
    return null;
  }

  // ── Collection ───────────────────────────────────────────────────────────

  // This cycle's IO as a list of requests, pure; defaults to the command-only commands().
  requests(): Request[] {
    return this.commands();
  }

  // Results in, a CollectResult out, pure; defaults to parse() for command-only plugins.
  parse_results(results: Result[]): CollectResult {
    return this.parse(results as CmdResult[]);
  }

  commands(): Command[] {
    return [];
  }

  parse(_results: CmdResult[]): CollectResult {
    return new CollectResult();
  }

  // The escape hatch for sequential local IO a request list cannot express; the engine runs the function and hands its
  // value to parse_results() as the single result. Making the function must be pure; running it may do IO.
  io_call(): (() => unknown) | null {
    return null;
  }

  // ── Push ─────────────────────────────────────────────────────────────────

  // The event streams this monitor wants pushed when an agent reaches its target; defaults to the generic sample stream
  // when SAMPLED is set and commands() is one command.
  subscriptions(): StreamSpec[] {
    if (!this.SAMPLED) return [];
    const commands = this.commands();
    if (commands.length !== 1) return [];
    return [{
      id: `${this.id}:${this.SAMPLE_STREAM}`,
      kind: "sample",
      params: { command: commands[0].text, interval: this.interval, max_quiet: this.interval * this.SAMPLE_MAX_QUIET_INTERVALS },
    }];
  }

  // Whether pushed events fully replace this monitor's poll.
  event_driven(): boolean {
    return this.subscriptions().some((stream) => stream.kind === "sample");
  }

  // One pushed event as a CollectResult, or null to ignore it; defaults to reading a sample frame through parse().
  parse_event(stream_id: string, payload: Record<string, unknown>, _timestamp: number): CollectResult | null {
    if (!stream_id.endsWith(`:${this.SAMPLE_STREAM}`)) return null;
    return this.parse([cmd_result(Number(payload.exit_code ?? -1), String(payload.stdout ?? ""), String(payload.stderr ?? ""))]);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  get_actions(): ActionButtonSpec[] {
    return [];
  }

  // "accent" while its job runs, "disabled" while another job runs, else "normal"; a subclass may answer "hidden".
  action_state(action: ActionButtonSpec): ActionState {
    if (action.detached && this.jobs) return this.jobs.action_job(action.action_id) ? "accent" : "normal";
    const job = this.jobs && action.job ? this.jobs.running() : null;
    if (job === null) return "normal";
    const kinds = typeof action.job === "string" ? [action.job] : (action.job ?? []);
    return kinds.includes(job.kind) ? "accent" : "disabled";
  }

  // The plugin's own action buttons followed by the custom ones its config adds.
  all_actions(): ActionButtonSpec[] {
    return [...this.get_actions(), ...this.custom_actions.map((action) => action.button())];
  }

  custom_action(action_id: string): CustomAction | null {
    return this.custom_actions.find((action) => action.action_id === action_id) ?? null;
  }

  // Pure: what an action needs, or null for an action this plugin does not handle.
  plan_action(_action_id: string, _args: Record<string, unknown> = {}): ActionPlanResult {
    return null;
  }

  // Takes in what an action run on the monitor's agent reported, for a plugin whose page reads state that action sets.
  absorb_remote_action(_action_id: string, _metadata: Record<string, string>, _args: Record<string, unknown> = {}): void {}

  // The agent a launched detached job runs on, when it is not the monitor's own target, so a cancel reaches it.
  job_agent(job: JobDict): string | null {
    return this.custom_action(action_id_of(job.kind ?? "") ?? "")?.agent ?? null;
  }

  // Pure: success or failure from the action's result, or a CollectResult with `success` set that is also written.
  interpret_action(_action_id: string, result: unknown, _args: Record<string, unknown> = {}): ActionOutcome {
    return (result as CmdResult).exit_code === 0;
  }

  // Pure: an action to run because of the status a cycle just recorded, as [action_id, args], or null. `now` is in
  // monotonic seconds; the plugin may keep the bookkeeping this needs between calls.
  on_status(_status: string, _now: number): [action_id: string, args: Record<string, unknown>] | null {
    return null;
  }

  // Runs one page-triggered action through the engine, returning success and any content it produced.
  async run_action(action_id: string, args: Record<string, unknown> = {}): Promise<[success: boolean, content: string]> {
    const [success, metadata] = await this.engine!.dispatch_action(this, action_id, args);
    return [success, String(metadata?.content ?? "")];
  }

  // ── Children ─────────────────────────────────────────────────────────────

  // Each child's id mapped to its latest status, unavailable for one with none yet.
  child_statuses(): Record<string, string> {
    const statuses = this.data.latest_statuses();
    return Object.fromEntries(this.children.map((child) => [child.id, statuses[child.id] ?? "unavailable"]));
  }

  // Polls this monitor now, polling its children first so it sees their fresh statuses.
  async run_cycle(): Promise<boolean> {
    const outcomes = await Promise.allSettled(this.children.map((child) => child.run_cycle()));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "rejected") log.error(`${this.children[index].name}: poll from '${this.name}' failed: ${String(outcome.reason)}`);
    });
    return this.engine!.run_cycle_now(this);
  }

  present(): Presented {
    return { name: this.name, target: this.target, actions: this.all_actions() };
  }
}

// A plugin class as the loader finds it: constructed from a name and its config.
export type PluginClass = new (name: string, config: PluginConfig) => Plugin;
