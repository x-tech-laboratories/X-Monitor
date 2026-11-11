// The database an agent runs its monitors on: the server's own, plus an outbox of every write for the server to
// collect. Monitors and the engine use it as they use the server's database; each result, job step and setting also
// lands in the outbox as a numbered record, in the order the writes happened, until the server acknowledges it.

import type { CollectResult } from "../connectors/types.ts";
import type { StateStore } from "../state/store.ts";
import * as records from "../sync/records.ts";
import { DatabaseManager } from "./database.ts";
import { create_agent_tables, db_time, SqlitePersistence, type SqlitePersistenceOptions } from "./sqlite_persistence.ts";

// How many unacknowledged records an agent keeps before it drops the oldest result records to make room.
export const DEFAULT_OUTBOX_LIMIT = 200_000;

export type OutboxEntry = [seq: number, kind: string, payload: records.RecordPayload];

export class AgentDatabase extends DatabaseManager {
  readonly outbox_limit: number;
  private readonly sqlite: SqlitePersistence;
  private next_seq: number;

  constructor(sqlite: SqlitePersistence, options: { outbox_limit?: number; store?: StateStore } = {}) {
    super({ persistence: sqlite, store: options.store });
    this.sqlite = sqlite;
    this.outbox_limit = options.outbox_limit ?? DEFAULT_OUTBOX_LIMIT;
    const last = sqlite.database.prepare('SELECT "seq" FROM "outboxrecord" ORDER BY "seq" DESC LIMIT 1').get() as { seq: number } | undefined;
    this.next_seq = (last ? Number(last.seq) : 0) + 1;
  }

  // ── Recording ──────────────────────────────────────────────────────────

  // Queues one record behind the write it describes, numbered in the order the writes happened.
  private record([kind, payload]: [string, records.RecordPayload]): number {
    const seq = this.next_seq++;
    const body = JSON.stringify(payload);
    const created = new Date();
    this.sqlite.submit(() => {
      this.sqlite.database.prepare('INSERT INTO "outboxrecord" ("seq", "created", "kind", "payload") VALUES (?, ?, ?, ?)').run(seq, db_time(created), kind, body);
    });
    return seq;
  }

  override apply_result(target: string, plugin_id: string, plugin_name: string, result: CollectResult): void {
    super.apply_result(target, plugin_id, plugin_name, result);
    this.record(records.encode_result(target, plugin_id, plugin_name, result));
  }

  override create_job(plugin_id: string, target: string, kind: string, command: string, workdir: string | null = null): number {
    const job_id = super.create_job(plugin_id, target, kind, command, workdir);
    this.record(records.encode_job(records.JOB_CREATE, job_id, { plugin_id, target, kind, command, workdir }));
    return job_id;
  }

  override set_job_pid(job_id: number, pid: number): void {
    super.set_job_pid(job_id, pid);
    this.record(records.encode_job(records.JOB_PID, job_id, { pid }));
  }

  override set_job_progress(job_id: number, progress: string): void {
    super.set_job_progress(job_id, progress);
    this.record(records.encode_job(records.JOB_PROGRESS, job_id, { progress }));
  }

  override append_job_output(job_id: number, lines: Iterable<string | null | undefined>, stream = "stdout"): void {
    const list = [...lines];
    super.append_job_output(job_id, list, stream);
    this.record(records.encode_job(records.JOB_OUTPUT, job_id, { lines: list, stream }));
  }

  override bump_job_output_seq(job_id: number, new_seq: number): void {
    super.bump_job_output_seq(job_id, new_seq);
    this.record(records.encode_job(records.JOB_OUTPUT_SEQ, job_id, { output_seq: new_seq }));
  }

  override finish_job(job_id: number, state: string, exit_code: number | null = null, error: string | null = null): void {
    super.finish_job(job_id, state, exit_code, error);
    this.record(records.encode_job(records.JOB_FINISH, job_id, { state, exit_code, error }));
  }

  override set_setting(key: string, value: string): void {
    super.set_setting(key, value);
    this.record(records.encode_setting(key, value));
  }

  // ── Collecting ─────────────────────────────────────────────────────────

  // The stored records numbered past `after`, oldest first; call flush() first to include ones still queued.
  pending(after = 0, limit = 500): OutboxEntry[] {
    const rows = this.sqlite.database.prepare('SELECT "seq", "kind", "payload" FROM "outboxrecord" WHERE "seq" > ? ORDER BY "seq" LIMIT ?').all(after, limit) as { seq: number; kind: string; payload: string }[];
    return rows.map((row) => [Number(row.seq), row.kind, JSON.parse(row.payload) as records.RecordPayload]);
  }

  // Forgets every record up to and including `through`, which the server has stored.
  acknowledge(through: number): void {
    this.sqlite.submit(() => {
      this.sqlite.database.prepare('DELETE FROM "outboxrecord" WHERE "seq" <= ?').run(through);
    });
  }

  // Drops the oldest result records past the outbox limit, keeping job and setting records; returns how many went.
  trim(): number {
    const count = Number((this.sqlite.database.prepare('SELECT count(*) AS count FROM "outboxrecord"').get() as { count: number }).count);
    const excess = count - this.outbox_limit;
    if (excess <= 0) return 0;
    return Number(this.sqlite.database.prepare(`DELETE FROM "outboxrecord" WHERE "seq" IN (SELECT "seq" FROM "outboxrecord" WHERE "kind" = ? ORDER BY "seq" LIMIT ?)`).run(records.RESULT, excess).changes);
  }
}

// Opens an agent's database at `path`, with its outbox.
export function open_agent_database(path: string, options: SqlitePersistenceOptions & { outbox_limit?: number; store?: StateStore } = {}): AgentDatabase {
  const sqlite = new SqlitePersistence(path, { ...options, extra_tables: create_agent_tables });
  return new AgentDatabase(sqlite, { outbox_limit: options.outbox_limit, store: options.store });
}
