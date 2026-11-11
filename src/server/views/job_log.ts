// A job's log as its dialog shows it: the job's name, a one-line summary, its command, any error and its output lines,
// and the watches that poll a running job every few seconds while someone has its log open.

import { action_id_of } from "../../core/coordination/jobs.ts";
import type { JobDict, JobOutputDict } from "../../core/database/database.ts";
import type { Plugin } from "../../monitors/base/plugin_base.ts";
import { format_duration } from "../../monitors/base/plugin_helpers.ts";

// ── Text ─────────────────────────────────────────────────────────────────────

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// The name a person sees for an action, or its id in words when no button names it.
export function action_label(plugin: Pick<Plugin, "all_actions">, action_id: string): string {
  const action = plugin.all_actions().find((each) => each.action_id === action_id);
  if (action !== undefined) return String(action.name || action_id);
  return capitalize(action_id.replaceAll("_", " "));
}

// A job's name in its log dialog: the action's name for a detached action, else its kind.
export function job_title(plugin: Pick<Plugin, "all_actions">, job: Pick<JobDict, "kind">): string {
  const action_id = action_id_of(job.kind);
  return action_id !== null ? action_label(plugin, action_id) : capitalize(job.kind);
}

// The dialog's one-line description of a job: when it started, its state and how it ended.
export function job_summary(job: Pick<JobDict, "started" | "state" | "exit_code" | "duration">): string {
  const parts = [`Started ${job.started}`, job.state];
  if (job.exit_code !== null && job.exit_code !== undefined) parts.push(`exit ${job.exit_code}`);
  parts.push(format_duration(job.duration));
  return parts.join(" · ");
}

// ── The view ─────────────────────────────────────────────────────────────────

export interface JobLogView {
  id: number;
  title: string;
  summary: string;
  command: string;
  error: string | null;
  running: boolean;
  lines: JobOutputDict[];
}

// A job's log, its lines after `after_seq`; null when the job is no longer kept.
export async function job_log_view(plugin: Plugin, job_id: number, after_seq = -1): Promise<JobLogView | null> {
  const job = plugin.data.job(job_id);
  if (job === null) return null;
  const lines = plugin.jobs ? await plugin.jobs.log(job_id) : [];
  return {
    id: job.id,
    title: `${job_title(plugin, job)} log`,
    summary: job_summary(job),
    command: job.command,
    error: job.error || null,
    running: job.state === "running",
    lines: lines.filter((line) => line.seq > after_seq),
  };
}

export const JOB_GONE_NOTICE = "That job is no longer kept";

// ── Watches ──────────────────────────────────────────────────────────────────

// Seconds an open log's watch lasts without the page renewing it, so a closed tab stops the fast polling soon.
export const LEASE_SECONDS = 30;

interface Lease {
  end: () => void;
  timer: ReturnType<typeof setTimeout>;
}

// The open logs of running jobs: each lease polls its job every few seconds until the page closes the log, the lease
// runs out, or the job ends.
export class JobWatches {
  private readonly leases = new Map<string, Lease>();
  private next_id = 1;

  // Starts watching a running job for an open log and returns the lease the page renews and ends; null for a job that
  // is not running.
  open(plugin: Plugin, job: JobDict): string | null {
    if (job.state !== "running" || plugin.jobs === null) return null;
    const lease_id = `${job.id}-${this.next_id++}`;
    const end = plugin.jobs.watch(job);
    this.leases.set(lease_id, { end, timer: this.expiry(lease_id) });
    return lease_id;
  }

  // Keeps a lease going for another LEASE_SECONDS; false when it has already ended.
  renew(lease_id: string): boolean {
    const lease = this.leases.get(lease_id);
    if (lease === undefined) return false;
    clearTimeout(lease.timer);
    lease.timer = this.expiry(lease_id);
    return true;
  }

  close(lease_id: string): void {
    const lease = this.leases.get(lease_id);
    if (lease === undefined) return;
    clearTimeout(lease.timer);
    lease.end();
    this.leases.delete(lease_id);
  }

  close_all(): void {
    for (const lease_id of this.leases.keys()) this.close(lease_id);
  }

  get size(): number {
    return this.leases.size;
  }

  private expiry(lease_id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.close(lease_id), LEASE_SECONDS * 1000);
    timer.unref?.();
    return timer;
  }
}
