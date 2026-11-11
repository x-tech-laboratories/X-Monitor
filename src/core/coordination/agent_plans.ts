// The server's side of agents that run their host's monitors themselves. For each agent set to `run_monitors`, the
// server compiles a plan: the effective config of every monitor on that agent whose plugin can run on its own host.
// The agent acknowledges the plan version it runs, and from then on those monitors are the agent's: the server no
// longer polls, schedules or triggers them, applies the records the agent syncs instead, sends their buttons down as
// actions, and marks them unavailable when the agent goes quiet. Which monitors an agent has taken survives a restart
// in the settings store, so an agent that is offline keeps its monitors.

import { createHash } from "node:crypto";

import type { SyncMessage } from "../connectors/agent_connector.ts";
import { CollectResult } from "../connectors/types.ts";
import { LATE_STATUS_MILLISECONDS } from "../database/database.ts";
import { create_logger_for } from "../logging.ts";
import { python_dumps, python_repr } from "../python.ts";
import * as records from "../sync/records.ts";
import type { Plugin } from "../../monitors/base/plugin_base.ts";
import { format_duration } from "../../monitors/base/plugin_helpers.ts";
import type { XMonitorEngine } from "./engine.ts";

const log = create_logger_for("x_monitor.core.coordination.agent_plans");

const plan_setting = (agent_id: string) => `agent-plan:${agent_id}`;
const seq_setting = (agent_id: string) => `agent-seq:${agent_id}`;
const job_setting = (agent_id: string, job_id: unknown) => `agent-job:${agent_id}:${String(job_id)}`;

// Retention for the agent's own database, which only has to outlast an offline stretch.
const AGENT_RETENTION_DAYS = 3;

// How long an action sent to an agent may take to answer before the button reports a timeout.
export const ACTION_TIMEOUT = 300.0;

// A monitor whose agent has sent nothing for this many intervals, and at least the floor, is marked unavailable.
const SILENT_INTERVALS = 3;
const SILENT_FLOOR_SECONDS = 300.0;

const monotonic = () => performance.now() / 1000;

function two(value: number): string {
  return String(value).padStart(2, "0");
}

// The agent a monitor runs on, or "" for one reached over SSH or run on the server.
export function agent_of(plugin: Plugin): string {
  return String(plugin.config?.agent || "");
}

// A monitor's effective config as the agent's engine reads it.
export function plan_entry(plugin: Plugin): Record<string, unknown> {
  const entry = Object.fromEntries(Object.entries(plugin.config).filter(([key]) => key !== "children"));
  if (!Object.hasOwn(entry, "id")) entry.id = plugin.id;
  if (!Object.hasOwn(entry, "name")) entry.name = plugin.name;
  return entry;
}

// What the plans need of the engine; a test double needs only this.
export type AgentPlansEngine = Pick<XMonitorEngine, "ready" | "connectors" | "db" | "all_monitors" | "apply" | "notifications">;

export class AgentPlans {
  private readonly engine: AgentPlansEngine;
  // Each agent's acknowledged plan: its version and the ids of the monitors it runs.
  private readonly acked = new Map<string, [version: string, monitors: Set<string>]>();
  private loaded = false;
  // When each agent-run monitor last had a record, monotonic, and which are already marked silent.
  private readonly last_record = new Map<string, number>();
  private readonly silent = new Set<string>();
  private readonly started = monotonic();
  // For an agent that went quiet: when, each monitor's status before it did, and the status changes its sync reports.
  private readonly offline_since = new Map<string, number>();
  private readonly baseline = new Map<string, string>();
  private readonly backlog = new Map<string, Map<string, [Date, string][]>>();

  constructor(engine: AgentPlansEngine) {
    this.engine = engine;
  }

  // ── Which monitors an agent runs ───────────────────────────────────────

  // Reads every agent's acknowledged plan from the settings store, once the store is ready.
  private load(): void {
    if (this.loaded || !this.engine.ready) return;
    for (const conn of this.engine.connectors.agents.all) {
      const raw = this.engine.db.get_setting(plan_setting(conn.agent_id));
      let stored: unknown = null;
      try {
        stored = raw ? JSON.parse(raw) : null;
      } catch {
        stored = null;
      }
      if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
        const record = stored as Record<string, unknown>;
        this.acked.set(conn.agent_id, [String(record.version ?? ""), new Set(Array.isArray(record.monitors) ? record.monitors.map(String) : [])]);
      }
    }
    this.loaded = true;
  }

  // Whether this monitor's agent runs it, so the server must not collect, schedule or trigger it itself.
  runs(plugin: Plugin): boolean {
    this.load();
    const agent_id = agent_of(plugin);
    if (!agent_id) return false;
    const conn = this.engine.connectors.agents.get(agent_id);
    if (conn === null || !conn.run_monitors) return false;
    return this.acked.get(agent_id)?.[1].has(plugin.id) ?? false;
  }

  // The agent's plan as [version, config, monitor ids]: every monitor on it whose plugin runs on its own host.
  compile(agent_id: string): [string, Record<string, unknown>, string[]] {
    const monitors = this.engine.all_monitors().filter((plugin) => agent_of(plugin) === agent_id && plugin.RUNS_ON_AGENT && plugin.children.length === 0);
    const config = {
      log_retention_days: AGENT_RETENTION_DAYS,
      metric_retention_days: AGENT_RETENTION_DAYS,
      plugins: monitors.map(plan_entry),
    };
    const version = createHash("sha256").update(python_dumps(config, true)).digest("hex").slice(0, 16);
    return [version, config, monitors.map((plugin) => plugin.id)];
  }

  // Sends every connected agent that runs monitors its plan if it changed, as after a config reload.
  async refresh(): Promise<void> {
    for (const conn of this.engine.connectors.agents.all) {
      if (!conn.runs_engine) continue;
      const [version, config] = this.compile(conn.agent_id);
      if (version !== this.acked.get(conn.agent_id)?.[0]) await conn.send_plan(version, config);
    }
  }

  // ── Messages from the agent ────────────────────────────────────────────

  async on_frame(agent_id: string, message: SyncMessage): Promise<void> {
    if (message.type === "plan_ack") await this.on_plan_ack(agent_id, String(message.version || ""));
    else if (message.type === "records") await this.on_records(agent_id, Array.isArray(message.records) ? message.records : []);
  }

  // Takes the monitors of the plan the agent runs, or sends it the current plan when it runs another.
  private async on_plan_ack(agent_id: string, version: string): Promise<void> {
    this.load();
    const conn = this.engine.connectors.agents.get(agent_id);
    if (conn === null || !conn.runs_engine) return;
    const [current, config, monitor_ids] = this.compile(agent_id);
    if (version !== current) {
      await conn.send_plan(current, config);
      return;
    }
    this.acked.set(agent_id, [version, new Set(monitor_ids)]);
    this.engine.db.set_setting(plan_setting(agent_id), python_dumps({ version, monitors: monitor_ids }));
    const now = monotonic();
    for (const monitor_id of monitor_ids) if (!this.last_record.has(monitor_id)) this.last_record.set(monitor_id, now);
    // The agent collects these itself now, so the streams the server had it run for them go.
    for (const monitor_id of monitor_ids) conn.unregister_stream(monitor_id);
    await conn.push_subscriptions();
    log.info(`agent ${python_repr(agent_id)} runs ${monitor_ids.length} monitor(s) itself (plan ${version})`);
  }

  // Stores a batch of the agent's records in order, skipping any already stored, then acknowledges it.
  private async on_records(agent_id: string, batch: unknown[]): Promise<void> {
    this.load();
    const stored = Number.parseInt(this.engine.db.get_setting(seq_setting(agent_id)) || "0", 10) || 0;
    let through = stored;
    for (const entry of batch) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const seq = Number(entry[0]);
      if (!Number.isInteger(seq)) continue;
      const kind = String(entry[1]);
      const payload = entry[2] as records.RecordPayload;
      if (seq <= stored) {
        through = Math.max(through, seq);
        continue;
      }
      // One bad record must not stall the sync behind it.
      try {
        this.apply_record(agent_id, kind, payload);
      } catch (error) {
        log.error(`agent ${python_repr(agent_id)}: could not apply record ${seq} (${kind}): ${(error as Error).message}`);
      }
      through = Math.max(through, seq);
    }
    if (through > stored) this.engine.db.set_setting(seq_setting(agent_id), String(through));
    const conn = this.engine.connectors.agents.get(agent_id);
    if (conn !== null && through) await conn.ack_records(through);
  }

  // Applies one record to the server's store as if the server had made the write itself.
  private apply_record(agent_id: string, kind: string, payload: records.RecordPayload): void {
    const db = this.engine.db;
    if (kind === records.RESULT) {
      const [, plugin_id, plugin_name, result] = records.decode_result(payload);
      const plugin = this.monitor(plugin_id);
      const target = plugin !== null ? plugin.target : String(payload.target ?? agent_id);
      db.apply_result(target, plugin_id, plugin !== null ? plugin.name : plugin_name, result);
      this.last_record.set(plugin_id, monotonic());
      this.silent.delete(plugin_id);
      if (result.status !== null && this.offline_since.has(agent_id)) this.note_offline_status(agent_id, plugin_id, String(result.status), result.timestamp);
    } else if (kind === records.SETTING) {
      db.set_setting(String(payload.key), String(payload.value));
    } else if (kind === records.JOB) {
      this.apply_job(agent_id, payload);
    }
  }

  // Mirrors one step of an agent's job under a server job id of its own.
  private apply_job(agent_id: string, payload: records.RecordPayload): void {
    const db = this.engine.db;
    const step = payload.step;
    const key = job_setting(agent_id, payload.job_id);
    if (step === records.JOB_CREATE) {
      if (payload.plugin_id === undefined) throw new Error("'plugin_id'");
      const job_id = db.create_job(String(payload.plugin_id), String(payload.target ?? agent_id), String(payload.kind ?? "job"), String(payload.command ?? ""), (payload.workdir as string | null | undefined) ?? null);
      db.set_setting(key, String(job_id));
      return;
    }
    const mapped = db.get_setting(key);
    if (mapped === null) return;
    const job_id = Number.parseInt(mapped, 10);
    if (step === records.JOB_PID) db.set_job_pid(job_id, Math.trunc(Number(payload.pid)));
    else if (step === records.JOB_PROGRESS) db.set_job_progress(job_id, String(payload.progress));
    else if (step === records.JOB_OUTPUT) db.append_job_output(job_id, (payload.lines as string[] | null) ?? [], String(payload.stream ?? "stdout"));
    else if (step === records.JOB_OUTPUT_SEQ) db.bump_job_output_seq(job_id, Math.trunc(Number(payload.output_seq)));
    else if (step === records.JOB_FINISH) db.finish_job(job_id, String(payload.state), (payload.exit_code as number | null | undefined) ?? null, (payload.error as string | null | undefined) ?? null);
  }

  // ── What the server still does for an agent-run monitor ────────────────

  // Marks an agent-run monitor unavailable once its agent has sent nothing for several of its intervals.
  check_silence(plugin: Plugin): void {
    const limit = Math.max(SILENT_INTERVALS * Number(plugin.interval || 60), SILENT_FLOOR_SECONDS);
    const last = this.last_record.get(plugin.id) ?? this.started;
    if (this.silent.has(plugin.id) || monotonic() - last < limit) return;
    this.silent.add(plugin.id);
    const agent_id = agent_of(plugin);
    const went_quiet = Date.now() / 1000 - (monotonic() - last);
    if (!this.offline_since.has(agent_id)) this.offline_since.set(agent_id, went_quiet);
    this.baseline.set(plugin.id, this.engine.db.latest_status(plugin.id));
    const since = new Date(went_quiet * 1000);
    const text = `${since.getFullYear()}-${two(since.getMonth() + 1)}-${two(since.getDate())} ${two(since.getHours())}:${two(since.getMinutes())}`;
    this.engine.apply(plugin, new CollectResult({ status: "unavailable", logs: [[`Agent ${python_repr(agent_id)} runs this monitor and has sent nothing since ${text}`, "WARNING"]] }));
  }

  // Collects a status the agent recorded while away, and sends the summary once its live records resume.
  private note_offline_status(agent_id: string, plugin_id: string, status: string, when: Date | null): void {
    const moment = when ?? new Date();
    if (Date.now() - moment.getTime() > LATE_STATUS_MILLISECONDS) {
      const by_monitor = this.backlog.get(agent_id) ?? new Map<string, [Date, string][]>();
      this.backlog.set(agent_id, by_monitor);
      const changes = by_monitor.get(plugin_id) ?? [];
      by_monitor.set(plugin_id, changes);
      const previous = changes.length > 0 ? changes[changes.length - 1][1] : this.baseline.get(plugin_id);
      if (status !== previous) changes.push([moment, status]);
      return;
    }
    this.send_offline_summary(agent_id);
  }

  // Notifies once that an agent is back, listing each monitor's status changes while it was away.
  private send_offline_summary(agent_id: string): void {
    const since = this.offline_since.get(agent_id);
    this.offline_since.delete(agent_id);
    const backlog = this.backlog.get(agent_id) ?? new Map<string, [Date, string][]>();
    this.backlog.delete(agent_id);
    if (since === undefined) return;
    const names = new Map(this.engine.all_monitors().map((plugin) => [plugin.id, plugin.name]));
    const name_of = (plugin_id: string) => names.get(plugin_id) ?? plugin_id;
    const lines = [...backlog]
      .sort(([first], [second]) => (name_of(first) < name_of(second) ? -1 : name_of(first) > name_of(second) ? 1 : 0))
      .filter(([, changes]) => changes.length > 0)
      .map(([plugin_id, changes]) => `${name_of(plugin_id)}: ${changes.map(([when, status]) => `${status} at ${two(when.getHours())}:${two(when.getMinutes())}`).join(", ")}`);
    const statuses = new Set([...backlog.values()].flatMap((changes) => changes.map(([, status]) => status)));
    const title = `${agent_id} is back after ${format_duration(Math.trunc(Date.now() / 1000 - since))} out of reach`;
    const body = lines.length > 0 ? lines.join("\n") : "No monitor changed status while it was out of reach.";
    const monitor_ids = [...(this.acked.get(agent_id)?.[1] ?? [])].sort();
    this.engine.notifications.send_summary(title, body, monitor_ids, statuses.has("failed") ? "failed" : "online");
    log.info(`${title}: ${lines.length} monitor(s) changed status`);
  }

  // Runs a button's action on the agent that runs the monitor, returning what the engine's dispatch returns.
  async dispatch(plugin: Plugin, action_id: string, args: Record<string, unknown> = {}): Promise<[boolean, Record<string, string> | null]> {
    const conn = this.engine.connectors.agents.get(agent_of(plugin));
    if (conn === null) return [false, { content: `No agent runs ${plugin.name}` }];
    const [success, metadata] = await conn.request_action(plugin.id, action_id, args, ACTION_TIMEOUT);
    // A broken absorb must not lose the action's answer.
    try {
      plugin.absorb_remote_action(action_id, metadata, args);
    } catch (error) {
      log.error(`${plugin.name}: could not take in what ${action_id} reported: ${(error as Error).message}`);
    }
    return [success, Object.keys(metadata).length > 0 ? metadata : null];
  }

  // Asks the agent for a cycle now; the result arrives as a record.
  async poll_now(plugin: Plugin): Promise<boolean> {
    const conn = this.engine.connectors.agents.get(agent_of(plugin));
    if (conn === null || !conn.is_connected) return false;
    await conn.poll_now(plugin.id);
    return true;
  }

  private monitor(monitor_id: string): Plugin | null {
    return this.engine.all_monitors().find((plugin) => plugin.id === monitor_id) ?? null;
  }
}
