// The job-control surface a job-capable monitor and its page hold. A job is a detached command on the target,
// advanced by the owning monitor's polls; "running" is stored state, not a live task, so everything here is store
// reads and writes plus, to cancel, one ordinary command on the host the job runs on.

import { cancel_command } from "../connectors/job_commands.ts";
import type { DatabaseManager, JobOutputDict } from "../database/database.ts";
import type { JobDict } from "../state/records.ts";

// ── Kinds ────────────────────────────────────────────────────────────────────

// Prefix of the kind an action launched as a detached job is recorded under, followed by the action's id.
export const ACTION_JOB_PREFIX = "action:";

export function action_job_kind(action_id: string): string {
  return ACTION_JOB_PREFIX + action_id;
}

// The action id a job kind names, or null when the job is not a detached action.
export function action_id_of(kind: string): string | null {
  return kind.startsWith(ACTION_JOB_PREFIX) ? kind.slice(ACTION_JOB_PREFIX.length) : null;
}

// Seconds between polls of a job while someone has its log open.
export const WATCHED_POLL_SECONDS = 2.0;

// Wake key of the engine loop that polls detached actions, which no monitor's own cycle does.
export const ACTION_LOOP = "action-jobs";

// ── Watching ─────────────────────────────────────────────────────────────────

// How many open log views follow each job, by job id.
const watchers = new Map<number, number>();

// Each sleeping polling loop's wake key and the function that ends its sleep early.
const naps = new Set<{ wake: string; end: () => void }>();

export function is_watched(job_id: number): boolean {
  return (watchers.get(job_id) ?? 0) > 0;
}

// Counts one more log view on the job, wakes the loop sleeping under `wake`, and returns what ends the watch.
export function watch(job_id: number, wake: string): () => void {
  watchers.set(job_id, (watchers.get(job_id) ?? 0) + 1);
  for (const nap of naps) if (nap.wake === wake) nap.end();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (watchers.get(job_id) ?? 0) - 1;
    if (left > 0) watchers.set(job_id, left);
    else watchers.delete(job_id);
  };
}

// Sleeps for `seconds`, or until a log view starts watching a job polled under `wake`; true when woken early.
// An abort signal ends the sleep too, resolving false.
export function sleep_unless_watched(seconds: number, wake: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const nap = { wake, end: () => finish(true) };
    const timer = setTimeout(() => finish(false), seconds * 1000);
    const on_abort = () => finish(false);
    function finish(woken: boolean): void {
      clearTimeout(timer);
      naps.delete(nap);
      signal?.removeEventListener("abort", on_abort);
      resolve(woken);
    }
    naps.add(nap);
    if (signal?.aborted) finish(false);
    else signal?.addEventListener("abort", on_abort, { once: true });
  });
}

// ── Gateway ──────────────────────────────────────────────────────────────────

// The parts of a monitor the gateway reads.
export interface JobOwner {
  readonly id: string;
  readonly target: string;
  readonly SIDE_JOB_KINDS: readonly string[];
  job_agent(job: JobDict): string | null;
}

// Runs a raw command on the monitor's transport, or on the named agent.
export type CancelExec = (command: string, agent: string | null) => Promise<unknown>;

export class JobsGateway {
  private readonly db: DatabaseManager;
  private readonly plugin: JobOwner;
  private readonly cancel_exec: CancelExec | null;

  constructor(db: DatabaseManager, plugin: JobOwner, cancel_exec: CancelExec | null = null) {
    this.db = db;
    this.plugin = plugin;
    this.cancel_exec = cancel_exec;
  }

  // Whether a job of this kind runs beside the monitor's main job: a detached action, or a kind the monitor names.
  private is_side(kind: string): boolean {
    return action_id_of(kind) !== null || this.plugin.SIDE_JOB_KINDS.includes(kind);
  }

  // The monitor's running main job; side jobs never count.
  running(): JobDict | null {
    return this.db.running_jobs(this.plugin.id).find((job) => !this.is_side(job.kind)) ?? null;
  }

  running_side(kind: string): JobDict | null {
    return this.db.running_jobs(this.plugin.id).find((job) => job.kind === kind) ?? null;
  }

  action_job(action_id: string): JobDict | null {
    return this.running_side(action_job_kind(action_id));
  }

  // Every running detached action of this monitor, newest first.
  action_jobs(): JobDict[] {
    return this.db.running_jobs(this.plugin.id).filter((job) => action_id_of(job.kind) !== null);
  }

  is_running(): boolean {
    return this.running() !== null;
  }

  // Whether a main job or a detached action runs, either of which Cancel can stop.
  any_running(): boolean {
    return this.running() !== null || this.action_jobs().length > 0;
  }

  current_id(): number | null {
    return this.running()?.id ?? null;
  }

  recent(limit = 20, exclude_kinds: readonly string[] = []): JobDict[] {
    return this.db.recent_jobs(this.plugin.id, limit, null, exclude_kinds);
  }

  // Polls this job every few seconds while its log is open; returns what ends the watch.
  watch(job: JobDict): () => void {
    const wake = action_id_of(job.kind) !== null ? ACTION_LOOP : this.plugin.id;
    return watch(job.id, wake);
  }

  // Whether a log view follows one of this monitor's running jobs that its own cycle polls.
  watched(): boolean {
    return this.db.running_jobs(this.plugin.id).some((job) => action_id_of(job.kind) === null && is_watched(job.id));
  }

  log(job_id: number): Promise<JobOutputDict[]> {
    return this.db.job_log(job_id);
  }

  // Kills the main job, else the newest detached action, on its target and marks it cancelled at once.
  async cancel(): Promise<boolean> {
    const job = this.running() ?? this.action_jobs()[0] ?? null;
    if (job === null || !job.pid) return false;
    if (this.cancel_exec !== null) await this.cancel_exec(cancel_command(job.pid), this.plugin.job_agent(job));
    this.db.finish_job(job.id, "cancelled", 130, "Cancelled by user");
    return true;
  }

  create(kind: string, command: string, workdir: string | null = null): number {
    return this.db.create_job(this.plugin.id, this.plugin.target, kind, command, workdir);
  }

  set_pid(job_id: number, pid: number): void {
    this.db.set_job_pid(job_id, pid);
  }

  set_progress(job_id: number, summary: string): void {
    this.db.set_job_progress(job_id, summary);
  }

  append_output(job_id: number, lines: Iterable<string | null | undefined>, stream = "stdout"): void {
    this.db.append_job_output(job_id, lines, stream);
  }

  bump_output_seq(job_id: number, new_seq: number): void {
    this.db.bump_job_output_seq(job_id, new_seq);
  }

  finish(job_id: number, state: string, exit_code: number | null = null, error: string | null = null): void {
    this.db.finish_job(job_id, state, exit_code, error);
  }
}
