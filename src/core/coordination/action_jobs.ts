// Detached actions: an action whose plan asks to run detached is launched as a job on its host, and one engine loop
// polls every running one until it ends. The finished run's output then goes to the action's own interpreter, as if
// the command had run inline. Nothing waits per job, so a job started before a restart or a reload is simply polled by
// the next loop.

import * as detached from "../connectors/job_commands.ts";
import type { ExecContext } from "../connectors/engine.ts";
import { action_plan, cmd_result, CollectResult, type ActionOutcome, type ActionPlan, type CmdResult, type DispatchResult } from "../connectors/types.ts";
import { create_logger_for } from "../logging.ts";
import { shell_quote } from "../shell.ts";
import type { JobDict } from "../state/records.ts";
import type { Plugin } from "../../monitors/base/plugin_base.ts";
import { ACTION_LOOP, action_id_of, action_job_kind, is_watched, sleep_unless_watched, WATCHED_POLL_SECONDS } from "./jobs.ts";
import type { XMonitorEngine } from "./engine.ts";

const log = create_logger_for("x_monitor.core.coordination.action_jobs");

// ── Settings ─────────────────────────────────────────────────────────────────

// Seconds between polls of the running detached actions.
export const POLL_SECONDS = 5.0;

// Characters of the newest output line shown as a running action's progress.
export const PROGRESS_LIMIT = 200;

// ── Helpers ──────────────────────────────────────────────────────────────────

// The name a person sees for an action, or its id when no button names it.
export function action_label(plugin: Plugin, action_id: string): string {
  for (const action of plugin.all_actions()) {
    if (action.action_id === action_id) return String(action.name || action_id);
  }
  const text = action_id.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// The command under `timeout`, which kills it once the whole run takes too long.
export function bounded(command: string, timeout: number | null): string {
  if (!timeout) return command;
  return `timeout ${Math.trunc(timeout)} sh -c ${shell_quote(command)}`;
}

// The newest non-blank line, cut to fit the progress line.
function last_line(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line) return line.slice(0, PROGRESS_LIMIT);
  }
  return null;
}

// ── Follower ─────────────────────────────────────────────────────────────────

// What the follower needs of the engine; a test double needs only this.
export type ActionJobsEngine = Pick<XMonitorEngine, "connectors" | "db" | "finish_action" | "apply" | "all_monitors" | "job_context">;

// Launches detached actions and follows each running one to its end.
export class ActionJobs {
  private readonly engine: ActionJobsEngine;
  // Each running job's action arguments, which only this process knows; a restarted one interprets without them.
  private readonly args = new Map<number, Record<string, unknown>>();

  constructor(engine: ActionJobsEngine) {
    this.engine = engine;
  }

  // ── Launch ─────────────────────────────────────────────────────────────

  // Starts the plan's command detached and records it as a job, refusing a second run of the same action.
  async launch(plugin: Plugin, action_id: string, plan: ActionPlan, context: ExecContext, interpret: (result: CmdResult) => ActionOutcome, args: Record<string, unknown>): Promise<DispatchResult> {
    const label = action_label(plugin, action_id);
    if (plugin.jobs!.action_job(action_id) !== null) return [false, { content: `${label} is already running` }];
    const command = bounded(plan.command, plan.timeout);
    const workdir = detached.workdir_for(`${plugin.id}-${action_id}-${Math.trunc(Date.now() / 1000)}`);
    const result = await this.engine.connectors.execute(context, action_plan(detached.launch_command(command, workdir)));
    const pid = result.exit_code === 0 ? detached.parse_launch(result.stdout) : null;
    if (pid === null) {
      const failed = cmd_result(result.exit_code || -1, "", result.stderr || result.stdout || "Could not start");
      return this.engine.finish_action(plugin, interpret(failed));
    }
    const job_id = plugin.jobs!.create(action_job_kind(action_id), command, workdir);
    plugin.jobs!.set_pid(job_id, pid);
    this.args.set(job_id, args);
    const message = `${label} started in the background (pid ${pid})`;
    this.engine.apply(plugin, new CollectResult({ logs: [[message, "INFO"]] }));
    return [true, { content: message, job_id: String(job_id) }];
  }

  // ── Follow ─────────────────────────────────────────────────────────────

  // Polls every running detached action until the signal aborts.
  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await sleep_unless_watched(this.poll_seconds(), ACTION_LOOP, signal);
      if (signal?.aborted) return;
      await this.poll_all();
    }
  }

  // Seconds until the next poll: sooner while someone has a running action's log open.
  poll_seconds(): number {
    const watched = this.engine.db.running_jobs().some((job) => action_id_of(job.kind) !== null && is_watched(job.id));
    return watched ? WATCHED_POLL_SECONDS : POLL_SECONDS;
  }

  // Advances every running detached action of a current monitor by one poll.
  async poll_all(): Promise<void> {
    const monitors = new Map(this.engine.all_monitors().map((plugin) => [plugin.id, plugin]));
    const pending: Promise<void>[] = [];
    for (const job of this.engine.db.running_jobs()) {
      const plugin = monitors.get(job.plugin_id);
      if (plugin === undefined || action_id_of(job.kind) === null || !job.pid || !job.workdir) continue;
      pending.push(this.advance(plugin, job));
    }
    for (const outcome of await Promise.allSettled(pending)) {
      if (outcome.status === "rejected") log.error(`Polling a detached action failed: ${(outcome.reason as Error)?.message ?? String(outcome.reason)}`);
    }
  }

  // Reads one poll of a running action, and hands its whole output to the interpreter once it ends.
  private async advance(plugin: Plugin, job: JobDict): Promise<void> {
    const context = this.engine.job_context(plugin, plugin.job_agent(job));
    if (context === null) return;
    const result = await this.engine.connectors.execute(context, action_plan(detached.poll_command(job.workdir!, job.pid!, job.output_seq)));
    // A poll that never reached the host says nothing about the job, so the next one tries again.
    if (result.exit_code !== 0 && !result.stdout.trim()) return;
    const poll = detached.parse_poll(result.stdout);
    const finished = poll.exit_code !== null || !poll.alive;

    const job_id = job.id;
    let [lines, consumed] = detached.split_lines(poll.new_output);
    const rest = Buffer.from(poll.new_output, "utf8").subarray(consumed).toString("utf8");
    if (finished && rest) {
      lines = [...lines, rest];
      consumed = Buffer.byteLength(poll.new_output, "utf8");
    }
    if (lines.length > 0) {
      plugin.jobs!.append_output(job_id, lines);
      plugin.jobs!.bump_output_seq(job_id, job.output_seq + consumed);
      const progress = last_line(lines);
      if (progress) plugin.jobs!.set_progress(job_id, progress);
    }
    if (!finished) return;

    // The running job's output is read from memory, before finishing moves it to disk.
    const output = this.engine.db.job_output(job_id, -1, 0).map((row) => row.message).join("\n");
    const exit_code = poll.exit_code ?? -1;
    if (poll.exit_code === null) {
      plugin.jobs!.finish(job_id, "failed", -1, "Process ended without writing an exit code");
    } else {
      plugin.jobs!.finish(job_id, exit_code === 0 ? "succeeded" : "failed", exit_code, exit_code === 0 ? null : `Exited with status ${exit_code}`);
    }
    this.interpret(plugin, job, cmd_result(exit_code, output, ""));
  }

  // Records a finished action's outcome on its monitor, as its interpreter reads the output.
  private interpret(plugin: Plugin, job: JobDict, result: CmdResult): void {
    const action_id = action_id_of(job.kind)!;
    const args = this.args.get(job.id) ?? {};
    this.args.delete(job.id);
    const custom = plugin.custom_action(action_id);
    let outcome: ActionOutcome = custom !== null ? custom.interpret(result) : plugin.interpret_action(action_id, result, args);
    if (!(outcome instanceof CollectResult)) {
      const label = action_label(plugin, action_id);
      const message = outcome ? `${label} finished` : `${label} failed (exit ${result.exit_code})`;
      outcome = new CollectResult({ logs: [[message, outcome ? "INFO" : "ERROR"]], success: Boolean(outcome) });
    }
    this.engine.apply(plugin, outcome);
  }
}
