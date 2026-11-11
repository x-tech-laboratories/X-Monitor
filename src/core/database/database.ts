// The Database Engine: every read is served from the in-memory StateStore, and every write updates the store, is
// handed to a Persistence sink that mirrors it to disk off the read path, and announces itself on the change bus.
//
// DatabaseManager keeps the Python app's method names and return shapes, so monitors, the page and the exporters
// read the same rows. The SQLite sink lives in sqlite_persistence.ts; tests and an agent without a state directory use
// memory_persistence, which keeps nothing.

import { createHash } from "node:crypto";

import { iso_local } from "../../shared/time.ts";
import type { CollectResult } from "../connectors/types.ts";
import { status_of } from "../../shared/status.ts";
import * as changes from "../state/changes.ts";
import { CHANGES } from "../state/changes.ts";
import type { EventRecord, JobDict, JobFields, JobOutputRecord, JobRecord, LogLineRecord, MetricRecord, StatusRecord } from "../state/records.ts";
import { StateStore } from "../state/store.ts";

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface JobOutputDict {
  seq: number;
  timestamp: string;
  stream: string;
  message: string;
}

export interface EventDict {
  timestamp: string;
  level: string;
  target: string;
  message: string;
}

// Narrower than EventDict: no target, and the plugin-name prefix taken off the message.
export interface PluginEventDict {
  timestamp: string;
  level: string;
  message: string;
}

export interface MetricRowDict {
  target: string;
  plugin_id: string;
  metric_name: string;
  value: number;
  timestamp: string;
}

// Every column of a metric row, as the metric tables index them.
export interface MetricModelDict {
  timestamp: Date;
  target: string;
  plugin_id: string;
  metric_name: string;
  value: number;
  metadata: string | null;
}

export interface LogLineModelDict {
  timestamp: Date;
  target: string;
  plugin_id: string;
  level: string;
  message: string;
  dedup_hash: string;
}

export interface EventModelDict {
  timestamp: Date;
  level: string;
  message: string;
  target: string | null;
  plugin_id: string | null;
}

export { type JobDict } from "../state/records.ts";

// ── Persistence ──────────────────────────────────────────────────────────────

// Where writes go after the store has them. Each call queues work and returns at once; nothing waits on the disk.
export interface Persistence {
  write_metrics(records: MetricRecord[]): void;
  write_status(record: StatusRecord): void;
  write_event(record: EventRecord): void;
  write_log_line(record: LogLineRecord): void;
  write_job(record: JobRecord): void;
  update_job(job_id: number, fields: JobFields): void;
  write_job_output(job_id: number, records: JobOutputRecord[]): void;
  fail_jobs(job_ids: number[], finished: Date, error: string): void;
  write_setting(key: string, value: string): void;
  write_snapshot(plugin_id: string, json: string, updated: Date): void;
  // A metric landed at a time downsampling may already have passed, so the next pass starts from that day again.
  note_late_metric(timestamp: Date): void;
  // A finished job's whole output, newest `keep` lines, read after every queued write.
  read_job_log(job_id: number, keep: number): Promise<JobOutputDict[]>;
  // Restores the store from disk at startup.
  hydrate(store: StateStore): Promise<void>;
  prune_logs(retention_days: number): Promise<number>;
  prune_metrics(retention_days: number): Promise<number>;
  prune_status(retention_days: number): Promise<number>;
  prune_jobs(retention_days: number): Promise<number>;
  downsample_metrics(older_than_days: number): void;
  stop_downsampling(): void;
  // Waits until every queued write is on disk.
  flush(): Promise<void>;
  close(): Promise<void>;
}

// Keeps nothing: for tests, and anything with no database file.
export function memory_persistence(): Persistence {
  return {
    write_metrics: () => {},
    write_status: () => {},
    write_event: () => {},
    write_log_line: () => {},
    write_job: () => {},
    update_job: () => {},
    write_job_output: () => {},
    fail_jobs: () => {},
    write_setting: () => {},
    write_snapshot: () => {},
    note_late_metric: () => {},
    read_job_log: async () => [],
    hydrate: async () => {},
    prune_logs: async () => 0,
    prune_metrics: async () => 0,
    prune_status: async () => 0,
    prune_jobs: async () => 0,
    downsample_metrics: () => {},
    stop_downsampling: () => {},
    flush: async () => {},
    close: async () => {},
  };
}

// A status that happened longer ago than this before it arrived becomes current without being announced.
export const LATE_STATUS_MILLISECONDS = 2 * 60 * 1000;

// ── Database manager ─────────────────────────────────────────────────────────

export class DatabaseManager {
  readonly store: StateStore;
  readonly persistence: Persistence;

  constructor(options: { store?: StateStore; persistence?: Persistence } = {}) {
    this.store = options.store ?? new StateStore();
    this.persistence = options.persistence ?? memory_persistence();
  }

  hydrate(): Promise<void> {
    return this.persistence.hydrate(this.store);
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  insert_metric(target: string, plugin_id: string, metric_name: string, value: number, metadata: string | null = null): void {
    const record = this.store.add_metric(target, plugin_id, metric_name, value, metadata);
    this.persistence.write_metrics([record]);
    CHANGES.publish(changes.METRIC, plugin_id);
  }

  latest_metric(plugin_id: string, metric_name: string): MetricRecord | null {
    return this.store.latest_metric(plugin_id, metric_name);
  }

  latest_collector_metrics(plugin_id: string): MetricRecord[] {
    return this.store.latest_collector_metrics(plugin_id);
  }

  metric_history(plugin_id: string, metric_name: string, limit = 30): MetricRecord[] {
    return this.store.metric_history(plugin_id, metric_name, limit);
  }

  collector_metrics(plugin_id: string, limit = 15): MetricModelDict[] {
    return this.store.collector_metrics(plugin_id, limit).map(metric_row);
  }

  latest_metrics(): MetricRowDict[] {
    return this.store.latest_metrics().map((record) => ({
      target: record.target, plugin_id: record.plugin_id, metric_name: record.metric_name, value: record.value, timestamp: iso_local(record.timestamp),
    }));
  }

  recent_metrics_raw(limit = 20): MetricModelDict[] {
    return this.store.recent_metrics(limit).map(metric_row);
  }

  // ── Status ─────────────────────────────────────────────────────────────

  insert_status(plugin_id: string, state: string, timestamp: Date | null = null): void {
    const record: StatusRecord = { plugin_id, state: status_of(state), timestamp: timestamp ?? new Date() };
    const current = this.store.statuses.get(plugin_id);
    // A late status, synced from an agent after an offline stretch, joins the history without replacing a newer one.
    const is_current = current === undefined || record.timestamp >= current.timestamp;
    if (is_current) this.store.statuses.set(plugin_id, record);
    // One that happened long before it arrived becomes current silently, so a sync replays no alerts.
    const announce = is_current && (timestamp === null || Date.now() - timestamp.getTime() <= LATE_STATUS_MILLISECONDS);
    this.persistence.write_status(record);
    if (announce) CHANGES.publish(changes.STATUS, plugin_id);
  }

  latest_statuses(): Record<string, string> {
    return Object.fromEntries([...this.store.statuses].map(([id, record]) => [id, record.state]));
  }

  latest_status(plugin_id: string): string {
    return this.store.statuses.get(plugin_id)?.state ?? "unavailable";
  }

  latest_status_time(plugin_id: string): Date | null {
    return this.store.statuses.get(plugin_id)?.timestamp ?? null;
  }

  // ── Events ─────────────────────────────────────────────────────────────

  insert_event(level: string, message: string, target: string | null = null, plugin_id: string | null = null, timestamp: Date | null = null): void {
    const record = this.store.add_event(level, message, target, plugin_id, timestamp);
    this.persistence.write_event(record);
    CHANGES.publish(changes.EVENT, plugin_id);
  }

  recent_events(limit = 200, level: string | null = null, target: string | null = null, search: string | null = null): EventDict[] {
    return this.store.recent_events(limit, level, target, search).map((record) => ({
      timestamp: iso_local(record.timestamp), level: record.level, target: record.target ?? "", message: record.message,
    }));
  }

  recent_events_raw(limit = 20): EventModelDict[] {
    return this.store.recent_events(limit).map((record) => ({ ...record }));
  }

  plugin_events(plugin_id = "", prefix = "", target = "", limit = 100): PluginEventDict[] {
    return this.store.plugin_events(plugin_id, prefix, target, limit).map((record) => ({
      timestamp: iso_local(record.timestamp),
      level: record.level,
      message: prefix && record.message.startsWith(prefix) ? record.message.slice(prefix.length) : record.message,
    }));
  }

  // ── Log lines ──────────────────────────────────────────────────────────

  insert_log_line(target: string, plugin_id: string, level: string, message: string, log_time: string | null = null, timestamp: Date | null = null): void {
    const key = `${target}\u001f${plugin_id}\u001f${log_time ?? ""}\u001f${message}`;
    const dedup_hash = createHash("sha1").update(key, "utf8").digest("hex");
    const record = this.store.add_log_line(target, plugin_id, level, message, dedup_hash, timestamp);
    // Already in the buffer, so the disk has it too.
    if (record === null) return;
    this.persistence.write_log_line(record);
    CHANGES.publish(changes.LOG, plugin_id);
  }

  log_lines(target: string, filter_prefix = "", limit = 15): LogLineModelDict[] {
    return this.store.recent_log_lines(target, filter_prefix, limit).map((record) => ({ ...record }));
  }

  // ── Retention ──────────────────────────────────────────────────────────

  prune_logs(retention_days: number | null): Promise<number> {
    return retention_days && retention_days > 0 ? this.persistence.prune_logs(retention_days) : Promise.resolve(0);
  }

  prune_metrics(retention_days: number | null): Promise<number> {
    return retention_days && retention_days > 0 ? this.persistence.prune_metrics(retention_days) : Promise.resolve(0);
  }

  prune_status(retention_days: number | null): Promise<number> {
    return retention_days && retention_days > 0 ? this.persistence.prune_status(retention_days) : Promise.resolve(0);
  }

  prune_jobs(retention_days: number | null): Promise<number> {
    return retention_days && retention_days > 0 ? this.persistence.prune_jobs(retention_days) : Promise.resolve(0);
  }

  downsample_metrics(older_than_days: number | null): void {
    if (older_than_days && older_than_days > 0) this.persistence.downsample_metrics(older_than_days);
  }

  stop_downsampling(): void {
    this.persistence.stop_downsampling();
  }

  // ── Jobs ───────────────────────────────────────────────────────────────

  create_job(plugin_id: string, target: string, kind: string, command: string, workdir: string | null = null): number {
    const record = this.store.create_job(plugin_id, target, kind, command, workdir);
    this.persistence.write_job({ ...record });
    CHANGES.publish(changes.JOB, plugin_id);
    return record.id;
  }

  private update_job(job_id: number, fields: JobFields): void {
    const record = this.store.update_job(job_id, fields);
    if (record === null) return;
    this.persistence.update_job(job_id, fields);
    CHANGES.publish(changes.JOB, record.plugin_id);
  }

  set_job_pid(job_id: number, pid: number): void {
    this.update_job(job_id, { pid });
  }

  // How far a poll has consumed the target's output file, so the next poll appends only what is new.
  bump_job_output_seq(job_id: number, new_seq: number): void {
    this.update_job(job_id, { output_seq: new_seq });
  }

  set_job_progress(job_id: number, progress: string): void {
    this.update_job(job_id, { progress });
  }

  finish_job(job_id: number, state: string, exit_code: number | null = null, error: string | null = null): void {
    this.update_job(job_id, { state, exit_code, error, finished: new Date() });
  }

  append_job_output(job_id: number, lines: Iterable<string | null | undefined>, stream = "stdout"): void {
    const records = this.store.append_job_output(job_id, lines, stream);
    if (records.length === 0) return;
    this.persistence.write_job_output(job_id, records);
    CHANGES.publish(changes.JOB, this.store.get_job(job_id)?.plugin_id ?? null);
  }

  get_job(job_id: number): JobDict | null {
    return this.store.get_job(job_id);
  }

  recent_jobs(plugin_id: string | null = null, limit = 20, kind: string | null = null, exclude_kinds: readonly string[] = []): JobDict[] {
    return this.store.recent_jobs(plugin_id, limit, kind, exclude_kinds);
  }

  running_jobs(plugin_id: string | null = null): JobDict[] {
    return this.store.running_jobs(plugin_id);
  }

  // Running jobs launched on a target, for a restarted engine to re-adopt by polling.
  running_jobs_with_pid(plugin_id: string | null = null): JobDict[] {
    return this.store.running_jobs(plugin_id, true);
  }

  job_output(job_id: number, after_seq = -1, limit = 500): JobOutputDict[] {
    return this.store.job_output(job_id, after_seq, limit).map((record) => ({
      seq: record.seq, timestamp: iso_local(record.timestamp), stream: record.stream, message: record.message,
    }));
  }

  // A job's whole output: a running job's from memory, a finished one's from disk.
  job_log(job_id: number): Promise<JobOutputDict[]> {
    const job = this.store.get_job(job_id);
    if (job === null || job.state === "running") return Promise.resolve(this.job_output(job_id, -1, 0));
    return this.persistence.read_job_log(job_id, this.store.buffers.job_output);
  }

  // Fails only jobs with no pid, which never started on their target; the rest are re-adopted by their next poll.
  reconcile_orphaned_jobs(): number {
    const error = "X-Monitor restarted before this job started on the target";
    const failed = this.store.reconcile_orphaned_jobs(error);
    if (failed.length === 0) return 0;
    this.persistence.fail_jobs(failed, new Date(), error);
    CHANGES.publish(changes.JOB);
    return failed.length;
  }

  // ── Settings and snapshots ─────────────────────────────────────────────

  get_setting(key: string, fallback: string | null = null): string | null {
    return this.store.settings.get(key) ?? fallback;
  }

  set_setting(key: string, value: string): void {
    this.store.settings.set(key, value);
    this.persistence.write_setting(key, value);
    CHANGES.publish(changes.SETTING);
  }

  // Takes the decoded object, held as it is and serialised only on the way to disk.
  set_snapshot(plugin_id: string, data: unknown): void {
    this.store.snapshots.set(plugin_id, data);
    this.persistence.write_snapshot(plugin_id, JSON.stringify(data), new Date());
    CHANGES.publish(changes.SNAPSHOT, plugin_id);
  }

  latest_snapshot<Value = unknown>(plugin_id: string, fallback: Value | null = null): Value | null {
    return this.store.snapshots.has(plugin_id) ? (this.store.snapshots.get(plugin_id) as Value) : fallback;
  }

  // Waits for queued persistence to reach disk; only tests and shutdown need this.
  flush(): Promise<void> {
    return this.persistence.flush();
  }

  close(): Promise<void> {
    return this.persistence.close();
  }

  // ── Plugin writes ──────────────────────────────────────────────────────

  // A plugin event, prefixed with the plugin's name for the events feed.
  write_event(target: string, plugin_id: string, plugin_name: string, message: string, level = "INFO", timestamp: Date | null = null): void {
    this.insert_event(level, `[${plugin_name}] ${message}`, target, plugin_id, timestamp);
  }

  // Fans a CollectResult out to the per-datatype writes, each carrying the result's own time when it has one.
  apply_result(target: string, plugin_id: string, plugin_name: string, result: CollectResult): void {
    const when = result.timestamp;
    const metric_records: MetricRecord[] = [];
    for (const [name, value] of Object.entries(result.metrics)) {
      metric_records.push(this.store.add_metric(target, plugin_id, name, value, result.metadata[name] ?? null, when));
    }
    if (metric_records.length > 0) {
      this.persistence.write_metrics(metric_records);
      CHANGES.publish(changes.METRIC, plugin_id);
      if (when !== null) this.persistence.note_late_metric(when);
    }
    for (const [message, level] of result.logs) this.write_event(target, plugin_id, plugin_name, message, level, when);
    for (const [message, level, log_time] of result.log_lines) this.insert_log_line(target, plugin_id, level, message, log_time, when);
    if (result.status !== null) this.insert_status(plugin_id, result.status, when);
    if (result.snapshot !== null && result.snapshot !== undefined) this.set_snapshot(plugin_id, result.snapshot);
    for (const [key, value] of Object.entries(result.settings)) this.set_setting(key, value);
  }
}

function metric_row(record: MetricRecord): MetricModelDict {
  return { timestamp: record.timestamp, target: record.target, plugin_id: record.plugin_id, metric_name: record.metric_name, value: record.value, metadata: record.metadata };
}
