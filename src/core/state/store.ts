// The in-memory system of record. Collectors write here and the page reads from here; SQLite is a persistence sink
// behind it, read only once at startup to restore the store.
//
// Current state (statuses, snapshots, settings, jobs) is bounded by the number of monitors and held whole. History
// (metrics, events, log lines, job output) grows over time, so each stream is a bounded buffer sized by `memory:`.
// Node runs one thread, so the store needs none of the Python app's locks.

import { job_as_dict, type EventRecord, type JobDict, type JobFields, type JobOutputRecord, type JobRecord, type LogLineRecord, type MetricRecord, type StatusRecord } from "./records.ts";

// ── Buffer sizes ─────────────────────────────────────────────────────────────

export interface BufferSizes {
  metric_history: number;
  event_history: number;
  log_history: number;
  job_output: number;
  // Finished jobs kept per plugin; running ones are never evicted.
  jobs_per_plugin: number;
  // Output lines kept for a finished job, whose whole log is read from disk when opened.
  finished_job_output: number;
}

export const default_buffer_sizes: BufferSizes = {
  metric_history: 300,
  event_history: 2000,
  log_history: 500,
  job_output: 5000,
  jobs_per_plugin: 25,
  finished_job_output: 50,
};

// ── Bounded buffer ───────────────────────────────────────────────────────────

// An ordered list that drops its oldest entry once full, as Python's deque with a maxlen.
export class BoundedBuffer<Item> {
  readonly items: Item[] = [];
  readonly max_length: number;

  constructor(max_length: number, items: Iterable<Item> = []) {
    this.max_length = max_length;
    for (const item of items) this.append(item);
  }

  get length(): number {
    return this.items.length;
  }

  get full(): boolean {
    return this.items.length >= this.max_length;
  }

  first(): Item | undefined {
    return this.items[0];
  }

  last(): Item | undefined {
    return this.items[this.items.length - 1];
  }

  // Appends, returning the entry pushed out, if any.
  append(item: Item): Item | undefined {
    this.items.push(item);
    return this.items.length > this.max_length ? this.items.shift() : undefined;
  }

  // The newest `limit` entries, oldest first; all of them for a limit of 0.
  tail(limit: number): Item[] {
    return limit ? this.items.slice(-limit) : [...this.items];
  }
}

interface Timed {
  readonly timestamp: Date;
}

// Puts a record into a time-ordered buffer, returning whether it was kept and the record it pushed out. A late record,
// such as an agent's synced after an offline stretch, goes where its time belongs; one older than all a full buffer
// holds is not kept in memory.
export function insert_by_time<Record extends Timed>(buffer: BoundedBuffer<Record>, record: Record): [kept: boolean, evicted: Record | undefined] {
  const items = buffer.items;
  const newest = buffer.last();
  if (newest === undefined || record.timestamp >= newest.timestamp) return [true, buffer.append(record)];
  if (buffer.full && record.timestamp < items[0].timestamp) return [false, undefined];
  const evicted = buffer.full ? items.shift() : undefined;
  let index = items.length;
  while (index > 0 && items[index - 1].timestamp > record.timestamp) index--;
  items.splice(index, 0, record);
  return [true, evicted];
}

// ── Store ────────────────────────────────────────────────────────────────────

export class StateStore {
  readonly buffers: BufferSizes;

  // Current state, read and written directly.
  readonly statuses = new Map<string, StatusRecord>();
  readonly snapshots = new Map<string, unknown>();
  readonly settings = new Map<string, string>();

  // History: one buffer per (plugin id, metric name), indexed again per plugin for the metric table.
  readonly metrics = new Map<string, BoundedBuffer<MetricRecord>>();
  private readonly by_plugin = new Map<string, BoundedBuffer<MetricRecord>[]>();
  readonly events: BoundedBuffer<EventRecord>;
  readonly log_lines = new Map<string, BoundedBuffer<LogLineRecord>>();
  private readonly log_dedup = new Map<string, Set<string>>();

  // Jobs are advanced in place, so they are reached through the job methods.
  readonly jobs = new Map<number, JobRecord>();
  readonly job_output_buffers = new Map<number, BoundedBuffer<JobOutputRecord>>();
  private next_job_id = 1;

  constructor(buffers: Partial<BufferSizes> = {}) {
    this.buffers = { ...default_buffer_sizes, ...buffers };
    this.events = new BoundedBuffer(this.buffers.event_history);
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  add_metric(target: string, plugin_id: string, metric_name: string, value: number, metadata: string | null = null, timestamp: Date | null = null): MetricRecord {
    const record: MetricRecord = { target, plugin_id, metric_name, value, metadata, timestamp: timestamp ?? new Date() };
    insert_by_time(this.series(plugin_id, metric_name), record);
    return record;
  }

  // The buffer for one series, made and indexed on first use.
  private series(plugin_id: string, metric_name: string): BoundedBuffer<MetricRecord> {
    const key = series_key(plugin_id, metric_name);
    let series = this.metrics.get(key);
    if (series === undefined) {
      series = new BoundedBuffer(this.buffers.metric_history);
      this.metrics.set(key, series);
      const list = this.by_plugin.get(plugin_id) ?? [];
      list.push(series);
      this.by_plugin.set(plugin_id, list);
    }
    return series;
  }

  latest_metric(plugin_id: string, metric_name: string): MetricRecord | null {
    return this.metrics.get(series_key(plugin_id, metric_name))?.last() ?? null;
  }

  // Oldest to newest, as the charts plot.
  metric_history(plugin_id: string, metric_name: string, limit = 30): MetricRecord[] {
    return this.metrics.get(series_key(plugin_id, metric_name))?.tail(limit) ?? [];
  }

  // Every series of one plugin, newest first: the metric table.
  collector_metrics(plugin_id: string, limit = 15): MetricRecord[] {
    const records = (this.by_plugin.get(plugin_id) ?? []).flatMap((series) => series.tail(limit));
    records.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return limit ? records.slice(0, limit) : records;
  }

  // The newest point of every series.
  latest_metrics(): MetricRecord[] {
    return [...this.metrics.values()].map((series) => series.last()).filter((record) => record !== undefined);
  }

  // The newest point of each of one plugin's series.
  latest_collector_metrics(plugin_id: string): MetricRecord[] {
    return (this.by_plugin.get(plugin_id) ?? []).map((series) => series.last()).filter((record) => record !== undefined);
  }

  // The newest metrics across every series.
  recent_metrics(limit = 20): MetricRecord[] {
    const records = [...this.metrics.values()].flatMap((series) => series.items);
    records.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return limit ? records.slice(0, limit) : records;
  }

  // ── Events ─────────────────────────────────────────────────────────────

  add_event(level: string, message: string, target: string | null = null, plugin_id: string | null = null, timestamp: Date | null = null): EventRecord {
    const record: EventRecord = { level, message, target, plugin_id, timestamp: timestamp ?? new Date() };
    insert_by_time(this.events, record);
    return record;
  }

  // Newest first, with the events feed's filters; walking stops at `limit`.
  recent_events(limit = 200, level: string | null = null, target: string | null = null, search: string | null = null): EventRecord[] {
    const results: EventRecord[] = [];
    for (let index = this.events.items.length - 1; index >= 0; index--) {
      const record = this.events.items[index];
      if (level && record.level !== level) continue;
      if (target && record.target !== target) continue;
      if (search && !record.message.includes(search)) continue;
      results.push(record);
      if (limit && results.length >= limit) break;
    }
    return results;
  }

  // One plugin's events: by its id when known, else by the "[Plugin Name] " prefix the events feed writes.
  plugin_events(plugin_id = "", prefix = "", target = "", limit = 100): EventRecord[] {
    const results: EventRecord[] = [];
    for (let index = this.events.items.length - 1; index >= 0; index--) {
      const record = this.events.items[index];
      if (plugin_id) {
        if (record.plugin_id !== plugin_id) continue;
      } else {
        if (!record.message.startsWith(prefix)) continue;
        if (target && record.target !== target) continue;
      }
      results.push(record);
      if (limit && results.length >= limit) break;
    }
    return results;
  }

  // ── Log lines ──────────────────────────────────────────────────────────

  // Null for a line already held, so the caller skips persisting it too; log collectors re-read the same tail each poll.
  add_log_line(target: string, plugin_id: string, level: string, message: string, dedup_hash: string, timestamp: Date | null = null): LogLineRecord | null {
    const record: LogLineRecord = { target, plugin_id, level, message, dedup_hash, timestamp: timestamp ?? new Date() };
    let buffer = this.log_lines.get(target);
    if (buffer === undefined) {
      buffer = new BoundedBuffer(this.buffers.log_history);
      this.log_lines.set(target, buffer);
      this.log_dedup.set(target, new Set());
    }
    const seen = this.log_dedup.get(target)!;
    if (seen.has(dedup_hash)) return null;
    const [kept, evicted] = insert_by_time(buffer, record);
    if (kept) seen.add(dedup_hash);
    // The dedup set ages out with the buffer, or it would grow without bound.
    if (evicted !== undefined) seen.delete(evicted.dedup_hash);
    return record;
  }

  // Newest first; `filter_prefix` matches the plugin id exactly.
  recent_log_lines(target: string, filter_prefix = "", limit = 15): LogLineRecord[] {
    const items = this.log_lines.get(target)?.items ?? [];
    const results = [...items].reverse().filter((record) => !filter_prefix || record.plugin_id === filter_prefix);
    return limit ? results.slice(0, limit) : results;
  }

  // ── Jobs ───────────────────────────────────────────────────────────────

  // Ids are assigned here, so a job has one the instant it is made.
  create_job(plugin_id: string, target: string, kind: string, command: string, workdir: string | null = null, state = "running", started: Date | null = null): JobRecord {
    const record: JobRecord = {
      id: this.next_job_id++, plugin_id, target, kind, state, command, started: started ?? new Date(),
      finished: null, exit_code: null, progress: null, error: null, pid: null, workdir, output_seq: 0,
    };
    this.jobs.set(record.id, record);
    return record;
  }

  update_job(job_id: number, fields: JobFields): JobRecord | null {
    const record = this.jobs.get(job_id);
    if (record === undefined) return null;
    const was_running = record.state === "running";
    Object.assign(record, fields);
    // A job that just finished is the only moment eviction can become necessary.
    if (was_running && record.state !== "running") {
      this.trim_finished_output(record.id);
      this.evict_finished_jobs(record.plugin_id);
    }
    return record;
  }

  private trim_finished_output(job_id: number): void {
    const buffer = this.job_output_buffers.get(job_id);
    const keep = this.buffers.finished_job_output;
    if (buffer === undefined || buffer.length <= keep) return;
    this.job_output_buffers.set(job_id, new BoundedBuffer(keep, buffer.tail(keep)));
  }

  // Drops this plugin's oldest finished jobs beyond jobs_per_plugin.
  private evict_finished_jobs(plugin_id: string): void {
    const finished = [...this.jobs.values()].filter((record) => record.plugin_id === plugin_id && record.state !== "running");
    const excess = finished.length - this.buffers.jobs_per_plugin;
    if (excess <= 0) return;
    finished.sort((a, b) => a.started.getTime() - b.started.getTime());
    for (const record of finished.slice(0, excess)) {
      this.jobs.delete(record.id);
      this.job_output_buffers.delete(record.id);
    }
  }

  get_job(job_id: number): JobDict | null {
    const record = this.jobs.get(job_id);
    return record ? job_as_dict(record) : null;
  }

  recent_jobs(plugin_id: string | null = null, limit = 20, kind: string | null = null, exclude_kinds: readonly string[] = []): JobDict[] {
    const records = [...this.jobs.values()].filter(
      (record) => (!plugin_id || record.plugin_id === plugin_id) && (!kind || record.kind === kind) && !exclude_kinds.includes(record.kind),
    );
    records.sort((a, b) => b.started.getTime() - a.started.getTime());
    return records.slice(0, limit).map((record) => job_as_dict(record));
  }

  running_jobs(plugin_id: string | null = null, with_pid = false): JobDict[] {
    const records = [...this.jobs.values()].filter(
      (record) => record.state === "running" && (!plugin_id || record.plugin_id === plugin_id) && (!with_pid || record.pid !== null),
    );
    records.sort((a, b) => b.started.getTime() - a.started.getTime());
    return records.map((record) => job_as_dict(record));
  }

  append_job_output(job_id: number, lines: Iterable<string | null | undefined>, stream = "stdout"): JobOutputRecord[] {
    const kept = [...lines].filter((line): line is string => line !== null && line !== undefined);
    if (kept.length === 0) return [];
    const now = new Date();
    let buffer = this.job_output_buffers.get(job_id);
    if (buffer === undefined) {
      buffer = new BoundedBuffer(this.buffers.job_output);
      this.job_output_buffers.set(job_id, buffer);
    }
    const start = (buffer.last()?.seq ?? -1) + 1;
    const records = kept.map((message, index): JobOutputRecord => ({ seq: start + index, stream, message, timestamp: now }));
    for (const record of records) buffer.append(record);
    return records;
  }

  // A job's output after a sequence number; a finished job keeps only a short tail here.
  job_output(job_id: number, after_seq = -1, limit = 500): JobOutputRecord[] {
    const items = this.job_output_buffers.get(job_id)?.items ?? [];
    const results = items.filter((record) => record.seq > after_seq);
    return limit ? results.slice(0, limit) : results;
  }

  // Fails running jobs with no pid, which never launched; jobs with one are re-adopted by their plugin's next poll.
  reconcile_orphaned_jobs(error: string): number[] {
    const failed: number[] = [];
    const now = new Date();
    for (const record of this.jobs.values()) {
      if (record.state === "running" && record.pid === null) {
        record.state = "failed";
        record.finished = now;
        record.error = error;
        failed.push(record.id);
      }
    }
    return failed;
  }

  // ── Hydration ──────────────────────────────────────────────────────────

  // Bulk-loads metric history, oldest first.
  load_metrics(records: Iterable<MetricRecord>): void {
    for (const record of records) this.series(record.plugin_id, record.metric_name).append(record);
  }

  load_events(records: Iterable<EventRecord>): void {
    for (const record of records) this.events.append(record);
  }

  load_log_lines(records: Iterable<LogLineRecord>): void {
    for (const record of records) {
      let buffer = this.log_lines.get(record.target);
      if (buffer === undefined) {
        buffer = new BoundedBuffer(this.buffers.log_history);
        this.log_lines.set(record.target, buffer);
        this.log_dedup.set(record.target, new Set());
      }
      buffer.append(record);
      this.log_dedup.get(record.target)!.add(record.dedup_hash);
    }
  }

  // Restores jobs and their output, and carries id assignment past the highest restored id.
  load_jobs(jobs: Iterable<JobRecord>, output: Map<number, JobOutputRecord[]>): void {
    const plugin_ids = new Set<string>();
    for (const record of jobs) {
      this.jobs.set(record.id, record);
      plugin_ids.add(record.plugin_id);
      this.next_job_id = Math.max(this.next_job_id, record.id + 1);
    }
    for (const [job_id, records] of output) this.job_output_buffers.set(job_id, new BoundedBuffer(this.buffers.job_output, records));
    for (const plugin_id of plugin_ids) this.evict_finished_jobs(plugin_id);
  }
}

function series_key(plugin_id: string, metric_name: string): string {
  return `${plugin_id}\u001f${metric_name}`;
}
