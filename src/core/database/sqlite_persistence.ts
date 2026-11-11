// The SQLite persistence sink behind the Database Engine. Nothing in the running system reads it: hydrate() restores
// the store once at startup, and every write is queued, batched into one transaction per `write_batch_seconds`, and
// mirrored to disk, so a slow disk never makes a reader wait.
//
// The tables, columns, indexes and text timestamps are the Python app's (peewee's models.py), so an existing
// X-Monitor database opens in place: the legacy column renames and every additive migration run on open, as they did.
// Row ids stay SQLite integers, since these tables are append-only logs that never sync between hosts.

import { DatabaseSync } from "node:sqlite";

import { migrate, type SqlDatabase, type SqlValue } from "@x-tech-laboratories/x-libs/sql";

import { status_of } from "../../shared/status.ts";
import { create_logger_for } from "../logging.ts";
import type { EventRecord, JobFields, JobOutputRecord, JobRecord, LogLineRecord, MetricRecord, StatusRecord } from "../state/records.ts";
import type { StateStore } from "../state/store.ts";
import type { JobOutputDict, Persistence } from "./database.ts";
import { iso_local } from "../../shared/time.ts";

const log = create_logger_for("x_monitor.core.database.database");

// ── Timestamps ───────────────────────────────────────────────────────────────

function two(value: number): string {
  return String(value).padStart(2, "0");
}

// A time as peewee stored it: local "YYYY-MM-DD HH:MM:SS", with ".ffffff" when it has a fraction of a second.
export function db_time(moment: Date): string {
  const base = `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())} ${two(moment.getHours())}:${two(moment.getMinutes())}:${two(moment.getSeconds())}`;
  const milliseconds = moment.getMilliseconds();
  return milliseconds ? `${base}.${String(milliseconds).padStart(3, "0")}000` : base;
}

// Reads a stored time back as a local Date, keeping milliseconds; null for text that is not a time.
export function parse_db_time(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return new Date(value * 1000);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?/.exec(String(value).trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const milliseconds = fraction ? Math.floor(Number(fraction.padEnd(6, "0")) / 1000) : 0;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0), milliseconds);
}

function midnight(moment: Date): Date {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
}

function hour_start(moment: Date): Date {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours());
}

function days_ago(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

// ── Schema ───────────────────────────────────────────────────────────────────

// The tables as peewee's create_tables made them, each statement safe to run against a database that already has them.
const create_tables = [
  'CREATE TABLE IF NOT EXISTS "metric" ("id" INTEGER NOT NULL PRIMARY KEY, "timestamp" DATETIME NOT NULL, "target" VARCHAR(255) NOT NULL, "plugin_id" VARCHAR(255) NOT NULL, "metric_name" VARCHAR(255) NOT NULL, "value" REAL NOT NULL, "metadata" TEXT)',
  'CREATE INDEX IF NOT EXISTS "metric_timestamp" ON "metric" ("timestamp")',
  'CREATE TABLE IF NOT EXISTS "event" ("id" INTEGER NOT NULL PRIMARY KEY, "timestamp" DATETIME NOT NULL, "level" VARCHAR(255) NOT NULL, "message" TEXT NOT NULL, "target" VARCHAR(255), "plugin_id" VARCHAR(255))',
  'CREATE INDEX IF NOT EXISTS "event_timestamp" ON "event" ("timestamp")',
  'CREATE INDEX IF NOT EXISTS "event_plugin_id" ON "event" ("plugin_id")',
  'CREATE TABLE IF NOT EXISTS "setting" ("key" VARCHAR(255) NOT NULL PRIMARY KEY, "value" TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "statushistory" ("id" INTEGER NOT NULL PRIMARY KEY, "timestamp" DATETIME NOT NULL, "plugin_id" VARCHAR(255) NOT NULL, "state" VARCHAR(255) NOT NULL)',
  'CREATE INDEX IF NOT EXISTS "statushistory_timestamp" ON "statushistory" ("timestamp")',
  'CREATE INDEX IF NOT EXISTS "statushistory_plugin_id" ON "statushistory" ("plugin_id")',
  'CREATE TABLE IF NOT EXISTS "job" ("id" INTEGER NOT NULL PRIMARY KEY, "plugin_id" VARCHAR(255) NOT NULL, "target" VARCHAR(255) NOT NULL, "kind" VARCHAR(255) NOT NULL, "state" VARCHAR(255) NOT NULL, "command" TEXT NOT NULL, "started" DATETIME NOT NULL, "finished" DATETIME, "exit_code" INTEGER, "progress" TEXT, "error" TEXT, "pid" INTEGER, "workdir" TEXT, "output_seq" INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS "job_started" ON "job" ("started")',
  'CREATE TABLE IF NOT EXISTS "joboutput" ("id" INTEGER NOT NULL PRIMARY KEY, "job_id" INTEGER NOT NULL, "seq" INTEGER NOT NULL, "timestamp" DATETIME NOT NULL, "stream" VARCHAR(255) NOT NULL, "message" TEXT NOT NULL, FOREIGN KEY ("job_id") REFERENCES "job" ("id") ON DELETE CASCADE)',
  'CREATE INDEX IF NOT EXISTS "joboutput_job_id" ON "joboutput" ("job_id")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "joboutput_job_id_seq" ON "joboutput" ("job_id", "seq")',
  'CREATE TABLE IF NOT EXISTS "pluginsnapshot" ("plugin_id" VARCHAR(255) NOT NULL PRIMARY KEY, "updated" DATETIME NOT NULL, "data" TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "logline" ("id" INTEGER NOT NULL PRIMARY KEY, "timestamp" DATETIME NOT NULL, "target" VARCHAR(255) NOT NULL, "plugin_id" VARCHAR(255) NOT NULL, "level" VARCHAR(255) NOT NULL, "message" TEXT NOT NULL, "dedup_hash" VARCHAR(255) NOT NULL)',
  'CREATE INDEX IF NOT EXISTS "logline_timestamp" ON "logline" ("timestamp")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "logline_dedup_hash" ON "logline" ("dedup_hash")',
  'CREATE INDEX IF NOT EXISTS "logline_target_timestamp" ON "logline" ("target", "timestamp")',
];

// Only an agent's database holds an outbox.
export const create_agent_tables = [
  'CREATE TABLE IF NOT EXISTS "outboxrecord" ("seq" INTEGER NOT NULL PRIMARY KEY, "created" DATETIME NOT NULL, "kind" VARCHAR(255) NOT NULL, "payload" TEXT NOT NULL)',
];

export const SCHEMA_OWNER = "x-monitor";

// The metric index hydration reads each series' newest rows from without touching the table.
export const SERIES_INDEX = "metric_series_tail";

const pragmas: [string, string | number][] = [
  ["journal_mode", "wal"],
  // NORMAL: under WAL it syncs only at checkpoint; OFF risks corruption on power loss.
  ["synchronous", 1],
  ["cache_size", -262144],
  ["mmap_size", 268435456],
  ["temp_store", 2],
  ["wal_autocheckpoint", 2000],
  ["busy_timeout", 5000],
  ["foreign_keys", 1],
];

function columns_of(database: SqlDatabase, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name));
}

// Renames each table's historical spelling of the monitor id to plugin_id, before the indexes that name it are made.
function migrate_renames(database: SqlDatabase): void {
  for (const [table, old] of [["metric", "collector"], ["event", "source_id"], ["statushistory", "collector_id"], ["logline", "source"]]) {
    const columns = columns_of(database, table);
    if (columns.has(old) && !columns.has("plugin_id")) {
      database.exec(`ALTER TABLE ${table} RENAME COLUMN ${old} TO plugin_id`);
      log.info(`Migrated: renamed ${table}.${old} -> plugin_id`);
    }
  }
}

// The additive migrations: columns later versions added, indexes no read uses any more, and the plugin_id indexes.
function migrate_columns(database: SqlDatabase): void {
  if (!columns_of(database, "event").has("plugin_id")) {
    database.exec("ALTER TABLE event ADD COLUMN plugin_id VARCHAR(255)");
    log.info("Migrated: added event.plugin_id");
  }
  const job_columns = columns_of(database, "job");
  for (const [column, ddl] of [
    ["pid", "ALTER TABLE job ADD COLUMN pid INTEGER"],
    ["workdir", "ALTER TABLE job ADD COLUMN workdir TEXT"],
    ["output_seq", "ALTER TABLE job ADD COLUMN output_seq INTEGER DEFAULT 0"],
  ]) {
    if (!job_columns.has(column)) {
      database.exec(ddl);
      log.info(`Migrated: added job.${column}`);
    }
  }
  for (const index of [
    "metric_target", "metric_metric_name", "logline_source", "job_plugin_id", "job_target", "job_kind", "job_state",
    "metric_collector_metric_name_timestamp", "event_source_id", "statushistory_collector_id",
  ]) {
    database.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  database.exec("CREATE INDEX IF NOT EXISTS event_plugin_id ON event (plugin_id)");
  database.exec("CREATE INDEX IF NOT EXISTS statushistory_plugin_id ON statushistory (plugin_id)");
}

// Each distinct value of an indexed, non-null column prefix, found by stepping along the index one key at a time:
// SELECT DISTINCT reads every row of the index, while each step here is one seek.
export function* distinct_keys(database: SqlDatabase, table: string, ...columns: string[]): Generator<SqlValue[]> {
  const list = columns.join(", ");
  const first = database.prepare(`SELECT ${list} FROM ${table} ORDER BY ${list} LIMIT 1`);
  const after = database.prepare(`SELECT ${list} FROM ${table} WHERE (${list}) > (${columns.map(() => "?").join(", ")}) ORDER BY ${list} LIMIT 1`);
  const values = (row: unknown): SqlValue[] => columns.map((column) => (row as Record<string, SqlValue>)[column]);
  let row = first.get();
  while (row !== undefined) {
    const key = values(row);
    yield key;
    row = after.get(...key);
  }
}

function sql_value(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return db_time(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SqlValue;
}

const yield_to_loop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── Persistence ──────────────────────────────────────────────────────────────

export interface SqlitePersistenceOptions {
  // Seconds a write waits for others to share its transaction.
  write_batch_seconds?: number;
  // Extra tables to make, as an agent's outbox.
  extra_tables?: readonly string[];
}

export class SqlitePersistence implements Persistence {
  readonly path: string;
  readonly database: SqlDatabase;
  batch_window: number;
  private queue: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  // How far downsampling has thinned, and whether a pass is still working through its days.
  thinned_through: Date | null = null;
  thinning = false;
  private stop_thinning = false;

  constructor(path: string, options: SqlitePersistenceOptions = {}) {
    this.path = path;
    this.batch_window = options.write_batch_seconds ?? 1.0;
    try {
      this.database = new DatabaseSync(path) as unknown as SqlDatabase;
      for (const [name, value] of pragmas) this.database.exec(`PRAGMA ${name} = ${value}`);
      // Renames come first: on a legacy database the tables' indexes name plugin_id, which exists only once renamed.
      migrate_renames(this.database);
      migrate(this.database, [[...create_tables, ...(options.extra_tables ?? [])]], { owner: SCHEMA_OWNER });
      // An agent database made before its outbox existed still gets one.
      for (const statement of options.extra_tables ?? []) this.database.exec(statement);
      migrate_columns(this.database);
      log.info(`Database initialized and connected at ${path}`);
    } catch (error) {
      log.error(`Failed to connect or initialize database at ${path}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── Writer ─────────────────────────────────────────────────────────────

  // Queues one piece of disk work; whatever arrives within the batch window commits in one transaction.
  submit(work: () => void): void {
    if (this.closed) return;
    this.queue.push(work);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.run_batch();
    }, this.batch_window * 1000);
  }

  // Runs everything queued as one transaction; a failed item is logged and skipped while the rest commit.
  private run_batch(): void {
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;
    try {
      this.database.exec("BEGIN");
      for (const work of batch) {
        try {
          work();
        } catch (error) {
          log.error(`DB write failed: ${(error as Error).message}`);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      log.error(`DB batch commit failed, dropping ${batch.length} write(s): ${(error as Error).message}`);
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // No transaction was left open.
      }
    }
    if (this.queue.length > 0 && this.timer === null && !this.closed) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.run_batch();
      }, this.batch_window * 1000);
    }
  }

  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.run_batch();
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.database.close();
  }

  private run(sql: string, ...params: unknown[]): number {
    return Number(this.database.prepare(sql).run(...params.map(sql_value)).changes);
  }

  // A queued write whose row count comes back once it has run.
  private counted(work: () => number): Promise<number> {
    return new Promise((resolve) => {
      this.submit(() => {
        try {
          resolve(work());
        } catch (error) {
          resolve(0);
          throw error;
        }
      });
    });
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  write_metrics(records: MetricRecord[]): void {
    const rows = records.map((record) => ({ ...record }));
    this.submit(() => {
      const insert = this.database.prepare('INSERT INTO "metric" ("timestamp", "target", "plugin_id", "metric_name", "value", "metadata") VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of rows) insert.run(db_time(row.timestamp), row.target, row.plugin_id, row.metric_name, row.value, row.metadata);
    });
  }

  write_status(record: StatusRecord): void {
    this.submit(() => this.run('INSERT INTO "statushistory" ("timestamp", "plugin_id", "state") VALUES (?, ?, ?)', record.timestamp, record.plugin_id, record.state));
  }

  write_event(record: EventRecord): void {
    this.submit(() =>
      this.run('INSERT INTO "event" ("timestamp", "level", "message", "target", "plugin_id") VALUES (?, ?, ?, ?, ?)', record.timestamp, record.level, record.message, record.target, record.plugin_id),
    );
  }

  write_log_line(record: LogLineRecord): void {
    this.submit(() =>
      this.run(
        'INSERT OR IGNORE INTO "logline" ("timestamp", "target", "plugin_id", "level", "message", "dedup_hash") VALUES (?, ?, ?, ?, ?, ?)',
        record.timestamp, record.target, record.plugin_id, record.level, record.message, record.dedup_hash,
      ),
    );
  }

  // Mirrors the store's id into the row's key, keeping the two in step across a restart.
  write_job(record: JobRecord): void {
    const row = { ...record };
    this.submit(() =>
      this.run(
        'INSERT OR REPLACE INTO "job" ("id", "plugin_id", "target", "kind", "state", "command", "started", "finished", "exit_code", "progress", "error", "pid", "workdir", "output_seq") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        row.id, row.plugin_id, row.target, row.kind, row.state, row.command, row.started, row.finished, row.exit_code, row.progress, row.error, row.pid, row.workdir, row.output_seq ?? 0,
      ),
    );
  }

  update_job(job_id: number, fields: JobFields): void {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    this.submit(() => this.run(`UPDATE "job" SET ${entries.map(([name]) => `"${name}" = ?`).join(", ")} WHERE "id" = ?`, ...entries.map(([, value]) => value), job_id));
  }

  write_job_output(job_id: number, records: JobOutputRecord[]): void {
    const rows = records.map((record) => ({ ...record }));
    this.submit(() => {
      const insert = this.database.prepare('INSERT OR IGNORE INTO "joboutput" ("job_id", "seq", "timestamp", "stream", "message") VALUES (?, ?, ?, ?, ?)');
      for (const row of rows) insert.run(job_id, row.seq, db_time(row.timestamp), row.stream, row.message);
    });
  }

  fail_jobs(job_ids: number[], finished: Date, error: string): void {
    const ids = [...job_ids];
    this.submit(() => this.run(`UPDATE "job" SET "state" = 'failed', "finished" = ?, "error" = ? WHERE "id" IN (${ids.map(() => "?").join(", ")})`, finished, error, ...ids));
  }

  write_setting(key: string, value: string): void {
    this.submit(() => this.run('INSERT OR REPLACE INTO "setting" ("key", "value") VALUES (?, ?)', key, value));
  }

  write_snapshot(plugin_id: string, json: string, updated: Date): void {
    this.submit(() => this.run('INSERT OR REPLACE INTO "pluginsnapshot" ("plugin_id", "updated", "data") VALUES (?, ?, ?)', plugin_id, updated, json));
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  // Reads on the writer's queue, so the lines still queued for disk are written first.
  read_job_log(job_id: number, keep: number): Promise<JobOutputDict[]> {
    return new Promise((resolve, reject) => {
      this.submit(() => {
        try {
          const rows = this.database.prepare('SELECT "seq", "timestamp", "stream", "message" FROM "joboutput" WHERE "job_id" = ? ORDER BY "seq" DESC LIMIT ?').all(job_id, keep) as Record<string, SqlValue>[];
          resolve(rows.reverse().map((row) => ({
            seq: Number(row.seq), timestamp: iso_local(parse_db_time(row.timestamp) ?? new Date(0)), stream: String(row.stream), message: String(row.message),
          })));
        } catch (error) {
          reject(error as Error);
        }
      });
    });
  }

  // ── Hydration ──────────────────────────────────────────────────────────

  // Builds the index hydration reads each series' tail from, replacing the narrower one it covers. It runs here, not
  // on open, so its one-off build on a large database happens while the dashboard already answers.
  ensure_series_index(): void {
    const exists = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(SERIES_INDEX);
    if (exists !== undefined) return;
    log.info("Building the metric series index; this runs once and can take minutes");
    const started = performance.now();
    this.database.exec(`CREATE INDEX IF NOT EXISTS ${SERIES_INDEX} ON metric (plugin_id, metric_name, timestamp, value, target)`);
    this.database.exec("DROP INDEX IF EXISTS metric_plugin_id_metric_name_timestamp");
    log.info(`Built the metric series index in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }

  // Restores the store from disk; each history stream loads only as deep as its buffer, so startup is bounded by the
  // configured sizes rather than by how large the database has grown.
  async hydrate(store: StateStore): Promise<void> {
    try {
      this.ensure_series_index();
      this.hydrate_statuses(store);
      await this.hydrate_metrics(store);
      this.hydrate_events(store);
      this.hydrate_log_lines(store);
      this.hydrate_snapshots(store);
      this.hydrate_settings(store);
      this.hydrate_jobs(store);
      log.info("State store hydrated from database");
    } catch (error) {
      // An unreadable database on a fresh install is not fatal: the store starts empty and collectors fill it.
      log.error(`Failed to hydrate state from ${this.path}: ${(error as Error).message}`);
    }
  }

  private hydrate_statuses(store: StateStore): void {
    const newest = this.database.prepare('SELECT "plugin_id", "state", "timestamp" FROM "statushistory" WHERE "plugin_id" = ? ORDER BY "id" DESC LIMIT 1');
    for (const [plugin_id] of distinct_keys(this.database, "statushistory", "plugin_id")) {
      const row = newest.get(plugin_id) as Record<string, SqlValue>;
      // History written under an old status name reads as its current one.
      store.statuses.set(String(row.plugin_id), { plugin_id: String(row.plugin_id), state: status_of(row.state), timestamp: parse_db_time(row.timestamp) ?? new Date(0) });
    }
  }

  private async hydrate_metrics(store: StateStore): Promise<void> {
    const depth = store.buffers.metric_history;
    // These columns are all in the series index, so the tail is read from it alone.
    const tail = this.database.prepare('SELECT "timestamp", "value", "target" FROM "metric" WHERE "plugin_id" = ? AND "metric_name" = ? ORDER BY "timestamp" DESC LIMIT ?');
    // Only a series' newest metadata is ever read, and fetching it costs one table lookup.
    const metadata = this.database.prepare('SELECT "metadata" FROM "metric" WHERE "plugin_id" = ? AND "metric_name" = ? ORDER BY "timestamp" DESC LIMIT 1');
    let series_count = 0;
    for (const [plugin_id, metric_name] of distinct_keys(this.database, "metric", "plugin_id", "metric_name")) {
      const rows = tail.all(plugin_id, metric_name, depth) as Record<string, SqlValue>[];
      if (rows.length === 0) continue;
      const newest = metadata.get(plugin_id, metric_name) as Record<string, SqlValue> | undefined;
      const records: MetricRecord[] = rows.map((row, index) => ({
        target: String(row.target), plugin_id: String(plugin_id), metric_name: String(metric_name), value: Number(row.value),
        metadata: index === 0 && newest?.metadata !== undefined && newest.metadata !== null ? String(newest.metadata) : null,
        timestamp: parse_db_time(row.timestamp) ?? new Date(0),
      }));
      store.load_metrics(records.reverse());
      // A large database has many series; letting the loop breathe keeps the dashboard answering meanwhile.
      if (++series_count % 200 === 0) await yield_to_loop();
    }
  }

  private hydrate_events(store: StateStore): void {
    const rows = this.database.prepare('SELECT "level", "message", "target", "plugin_id", "timestamp" FROM "event" ORDER BY "timestamp" DESC LIMIT ?').all(store.buffers.event_history) as Record<string, SqlValue>[];
    store.load_events(rows.reverse().map((row) => ({
      level: String(row.level), message: String(row.message), target: row.target === null ? null : String(row.target),
      plugin_id: row.plugin_id === null ? null : String(row.plugin_id), timestamp: parse_db_time(row.timestamp) ?? new Date(0),
    })));
  }

  private hydrate_log_lines(store: StateStore): void {
    const lines = this.database.prepare('SELECT "target", "plugin_id", "level", "message", "dedup_hash", "timestamp" FROM "logline" WHERE "target" = ? ORDER BY "timestamp" DESC LIMIT ?');
    for (const [target] of distinct_keys(this.database, "logline", "target")) {
      const rows = lines.all(target, store.buffers.log_history) as Record<string, SqlValue>[];
      store.load_log_lines(rows.reverse().map((row) => ({
        target: String(row.target), plugin_id: String(row.plugin_id), level: String(row.level), message: String(row.message),
        dedup_hash: String(row.dedup_hash), timestamp: parse_db_time(row.timestamp) ?? new Date(0),
      })));
    }
  }

  private hydrate_snapshots(store: StateStore): void {
    for (const row of this.database.prepare('SELECT "plugin_id", "data" FROM "pluginsnapshot"').all() as Record<string, SqlValue>[]) {
      try {
        store.snapshots.set(String(row.plugin_id), JSON.parse(String(row.data)));
      } catch {
        log.warn(`Discarding unreadable snapshot for ${String(row.plugin_id)}`);
      }
    }
  }

  private hydrate_settings(store: StateStore): void {
    for (const row of this.database.prepare('SELECT "key", "value" FROM "setting"').all() as Record<string, SqlValue>[]) store.settings.set(String(row.key), String(row.value));
  }

  // Only the newest 200 jobs come back, and output only for the running ones; nothing reads an old finished job live.
  private hydrate_jobs(store: StateStore): void {
    const rows = this.database.prepare('SELECT * FROM "job" ORDER BY "started" DESC LIMIT 200').all() as Record<string, SqlValue>[];
    const optional_number = (value: SqlValue): number | null => (value === null || value === undefined ? null : Number(value));
    const optional_text = (value: SqlValue): string | null => (value === null || value === undefined ? null : String(value));
    const jobs: JobRecord[] = rows.map((row) => ({
      id: Number(row.id), plugin_id: String(row.plugin_id), target: String(row.target), kind: String(row.kind), state: String(row.state),
      command: String(row.command), started: parse_db_time(row.started) ?? new Date(0), finished: parse_db_time(row.finished),
      exit_code: optional_number(row.exit_code), progress: optional_text(row.progress), error: optional_text(row.error),
      pid: optional_number(row.pid), workdir: optional_text(row.workdir), output_seq: Number(row.output_seq ?? 0) || 0,
    }));
    const output = new Map<number, JobOutputRecord[]>();
    const running = jobs.filter((job) => job.state === "running").map((job) => job.id);
    if (running.length > 0) {
      const statement = this.database.prepare(`SELECT "job_id", "seq", "stream", "message", "timestamp" FROM "joboutput" WHERE "job_id" IN (${running.map(() => "?").join(", ")}) ORDER BY "seq"`);
      for (const row of statement.all(...running) as Record<string, SqlValue>[]) {
        const job_id = Number(row.job_id);
        const list = output.get(job_id) ?? [];
        list.push({ seq: Number(row.seq), stream: String(row.stream), message: String(row.message), timestamp: parse_db_time(row.timestamp) ?? new Date(0) });
        output.set(job_id, list);
      }
    }
    store.load_jobs(jobs, output);
  }

  // ── Retention ──────────────────────────────────────────────────────────

  // The store's buffers bound themselves, so these prunes only keep the database file from growing without bound.

  prune_logs(retention_days: number): Promise<number> {
    const cutoff = days_ago(retention_days);
    return this.counted(() => {
      const deleted = this.run('DELETE FROM "logline" WHERE "timestamp" < ?', cutoff);
      if (deleted) log.info(`Pruned ${deleted} log line(s) older than ${retention_days}d`);
      return deleted;
    });
  }

  prune_metrics(retention_days: number): Promise<number> {
    const cutoff = days_ago(retention_days);
    return this.counted(() => {
      const deleted = this.run('DELETE FROM "metric" WHERE "timestamp" < ?', cutoff);
      if (deleted) log.info(`Pruned ${deleted} metric(s) older than ${retention_days}d`);
      return deleted;
    });
  }

  // Keeps the newest row of each monitor whatever its age, so a restart still restores every last known status.
  prune_status(retention_days: number): Promise<number> {
    const cutoff = days_ago(retention_days);
    return this.counted(() => {
      const deleted = this.run('DELETE FROM "statushistory" WHERE "timestamp" < ? AND "id" NOT IN (SELECT MAX("id") FROM "statushistory" GROUP BY "plugin_id")', cutoff);
      if (deleted) log.info(`Pruned ${deleted} status row(s) older than ${retention_days}d`);
      return deleted;
    });
  }

  prune_jobs(retention_days: number): Promise<number> {
    const cutoff = days_ago(retention_days);
    return this.counted(() => {
      const deleted = this.run(`DELETE FROM "job" WHERE "state" != 'running' AND "started" < ?`, cutoff);
      if (deleted) log.info(`Pruned ${deleted} job(s) older than ${retention_days}d`);
      return deleted;
    });
  }

  // ── Downsampling ───────────────────────────────────────────────────────

  // Lets a running pass finish its current day and queue no more, so a flush at shutdown returns promptly.
  stop_downsampling(): void {
    this.stop_thinning = true;
  }

  // A metric landed at a time a pass may already have thinned, so the next pass starts from that day again.
  note_late_metric(timestamp: Date): void {
    if (this.thinned_through !== null && timestamp < this.thinned_through) this.thinned_through = midnight(timestamp);
  }

  // Thins metrics older than the window to one row per series per hour, one day per writer batch, each queueing the
  // next, so a first pass over weeks of rows never holds the writer long; days already thinned are skipped.
  downsample_metrics(older_than_days: number): void {
    if (!older_than_days || older_than_days <= 0 || this.thinning || this.stop_thinning) return;
    const cutoff = hour_start(days_ago(older_than_days));
    this.thinning = true;
    let deleted = 0;
    const finish = () => {
      this.thinning = false;
      if (deleted) log.info(`Downsampled ${deleted} metric row(s) older than ${older_than_days}d to one per hour`);
    };
    const thin_from = (from: Date | null): void => {
      let end: Date;
      try {
        let start = from;
        if (start === null) {
          const oldest = (this.database.prepare('SELECT min("timestamp") AS oldest FROM "metric"').get() as { oldest: SqlValue }).oldest;
          const parsed = parse_db_time(oldest);
          if (parsed === null) return finish();
          start = midnight(parsed);
        }
        if (start >= cutoff) return finish();
        end = new Date(Math.min(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()).getTime(), cutoff.getTime()));
        const low = db_time(start);
        const high = db_time(end);
        deleted += this.run(
          'DELETE FROM metric WHERE timestamp >= ? AND timestamp < ? AND id NOT IN (SELECT MIN(id) FROM metric WHERE timestamp >= ? AND timestamp < ? GROUP BY plugin_id, metric_name, strftime(\'%Y%m%d%H\', timestamp))',
          low, high, low, high,
        );
        this.thinned_through = end;
      } catch (error) {
        this.thinning = false;
        throw error;
      }
      // A pass paces at one day per writer batch, so shutdown's flush would otherwise wait out every day still to come.
      if (end < cutoff && !this.stop_thinning) this.submit(() => thin_from(end));
      else finish();
    };
    const start = this.thinned_through;
    this.submit(() => thin_from(start));
  }
}

// Opens (or creates) the database at `path`, ready to hydrate a store and take its writes.
export function open_sqlite_persistence(path: string, options: SqlitePersistenceOptions = {}): SqlitePersistence {
  return new SqlitePersistence(path, options);
}
