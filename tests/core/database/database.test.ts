import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectResult } from "../../../src/core/connectors/types.ts";
import { DatabaseManager } from "../../../src/core/database/database.ts";
import { db_time, distinct_keys, open_sqlite_persistence, parse_db_time, type SqlitePersistence } from "../../../src/core/database/sqlite_persistence.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import { CHANGES } from "../../../src/core/state/changes.ts";
import { StateStore, type BufferSizes } from "../../../src/core/state/store.ts";

let folder: string;
let path: string;
let mgr: DatabaseManager;
let sqlite: SqlitePersistence;
const open: DatabaseManager[] = [];

function manager(file = path, buffers: Partial<BufferSizes> = {}, write_batch_seconds = 0): [DatabaseManager, SqlitePersistence] {
  const persistence = open_sqlite_persistence(file, { write_batch_seconds });
  const made = new DatabaseManager({ persistence, store: new StateStore(buffers) });
  open.push(made);
  return [made, persistence];
}

beforeEach(async () => {
  set_log_sink(() => {});
  folder = mkdtempSync(join(tmpdir(), "x-monitor-db-"));
  path = join(folder, "test.db");
  [mgr, sqlite] = manager();
  await mgr.hydrate();
});

afterEach(async () => {
  for (const each of open.splice(0)) await each.close();
});

// Every row of a table, as SQLite holds it.
function rows(sql: string, ...params: (string | number)[]): Record<string, unknown>[] {
  return sqlite.database.prepare(sql).all(...params) as Record<string, unknown>[];
}

function index_names(table: string): string[] {
  return rows(`PRAGMA index_list("${table}")`).map((row) => String(row.name));
}

async function restart(buffers: Partial<BufferSizes> = {}): Promise<DatabaseManager> {
  await mgr.close();
  const [next] = manager(path, buffers);
  await next.hydrate();
  return next;
}

const days_ago = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("opening", () => {
  it("creates every table", () => {
    const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
    for (const table of ["metric", "event", "setting", "statushistory", "job", "joboutput", "pluginsnapshot", "logline"]) expect(tables).toContain(table);
  });

  it("has only the series index on a fresh database's metric columns", () => {
    const names = index_names("metric");
    expect(names.filter((name) => name === "metric_series_tail")).toHaveLength(1);
    expect(names).not.toContain("metric_plugin_id_metric_name_timestamp");
  });

  it("replaces the narrow index with the series index on hydration", async () => {
    const legacy = join(folder, "legacy.db");
    const raw = new DatabaseSync(legacy);
    raw.exec("CREATE TABLE metric (id INTEGER PRIMARY KEY, timestamp DATETIME, target VARCHAR, plugin_id VARCHAR, metric_name VARCHAR, value REAL, metadata TEXT)");
    raw.exec("CREATE INDEX metric_plugin_id_metric_name_timestamp ON metric (plugin_id, metric_name, timestamp)");
    raw.close();
    const [old, persistence] = manager(legacy);
    const list = () => (persistence.database.prepare('PRAGMA index_list("metric")').all() as { name: string }[]).map((row) => row.name);
    const before = list();
    await old.hydrate();
    const after = list();
    expect(before).not.toContain("metric_series_tail");
    expect(after).toContain("metric_series_tail");
    expect(after).not.toContain("metric_plugin_id_metric_name_timestamp");
  });

  it("reads a series' tail from the index alone", () => {
    const plan = rows("EXPLAIN QUERY PLAN SELECT timestamp, value, target FROM metric WHERE plugin_id = 'a' AND metric_name = 'b' ORDER BY timestamp DESC LIMIT 300");
    expect(plan.some((row) => String(row.detail).includes("COVERING INDEX metric_series_tail"))).toBe(true);
  });

  it("renames the legacy collector columns", async () => {
    const legacy = join(folder, "legacy-names.db");
    const raw = new DatabaseSync(legacy);
    raw.exec("CREATE TABLE metric (id INTEGER PRIMARY KEY, timestamp DATETIME, target VARCHAR, collector VARCHAR, metric_name VARCHAR, value REAL, metadata TEXT)");
    raw.exec("CREATE TABLE event (id INTEGER PRIMARY KEY, timestamp DATETIME, level VARCHAR, message TEXT, target VARCHAR, source_id VARCHAR)");
    raw.exec("CREATE TABLE statushistory (id INTEGER PRIMARY KEY, timestamp DATETIME, collector_id VARCHAR, state VARCHAR)");
    raw.exec("CREATE TABLE logline (id INTEGER PRIMARY KEY, timestamp DATETIME, target VARCHAR, source VARCHAR, level VARCHAR, message TEXT, dedup_hash VARCHAR UNIQUE)");
    raw.exec("INSERT INTO metric (target, collector, metric_name, value) VALUES ('h', 'cpu-odin', 'cpu_pct', 12.5)");
    raw.close();
    const [, persistence] = manager(legacy);
    for (const table of ["metric", "event", "statushistory", "logline"]) {
      const columns = (persistence.database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name);
      expect(columns, table).toContain("plugin_id");
    }
    expect((persistence.database.prepare("SELECT value FROM metric WHERE plugin_id = 'cpu-odin'").get() as { value: number }).value).toBe(12.5);
  });

  it("adds the job columns a database from before detached jobs lacks", () => {
    const legacy = join(folder, "legacy-jobs.db");
    const raw = new DatabaseSync(legacy);
    raw.exec('CREATE TABLE "job" ("id" INTEGER NOT NULL PRIMARY KEY, "plugin_id" VARCHAR(255) NOT NULL, "target" VARCHAR(255) NOT NULL, "kind" VARCHAR(255) NOT NULL, "state" VARCHAR(255) NOT NULL, "command" TEXT NOT NULL, "started" DATETIME NOT NULL, "finished" DATETIME, "exit_code" INTEGER, "progress" TEXT, "error" TEXT)');
    raw.close();
    const [, persistence] = manager(legacy);
    const columns = (persistence.database.prepare('PRAGMA table_info("job")').all() as { name: string }[]).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["pid", "workdir", "output_seq"]));
  });

  it("opens a database the Python app wrote, timestamps and all", async () => {
    const python = join(folder, "python.db");
    const [first, persistence] = manager(python);
    persistence.database.exec("INSERT INTO statushistory (timestamp, plugin_id, state) VALUES ('2026-10-01 10:00:00.250000', 'cpu', 'offline')");
    persistence.database.exec("INSERT INTO metric (timestamp, target, plugin_id, metric_name, value) VALUES ('2026-10-01 10:00:00', 'h', 'cpu', 'cpu_pct', 3.5)");
    await first.close();
    const [second] = manager(python);
    await second.hydrate();
    expect(second.latest_status("cpu")).toBe("unavailable");
    expect(second.latest_status_time("cpu")).toEqual(new Date(2026, 9, 1, 10, 0, 0, 250));
    expect(second.latest_metric("cpu", "cpu_pct")?.timestamp).toEqual(new Date(2026, 9, 1, 10, 0, 0));
  });
});

describe("timestamps", () => {
  it("writes times as peewee did", () => {
    expect(db_time(new Date(2026, 10, 11, 9, 30, 5))).toBe("2026-11-11 09:30:05");
    expect(db_time(new Date(2026, 10, 11, 9, 30, 5, 120))).toBe("2026-11-11 09:30:05.120000");
  });

  it("reads them back", () => {
    expect(parse_db_time("2026-11-11 09:30:05.120000")).toEqual(new Date(2026, 10, 11, 9, 30, 5, 120));
    expect(parse_db_time("2026-11-11")).toEqual(new Date(2026, 10, 11));
    expect(parse_db_time(null)).toBeNull();
  });
});

describe("writes", () => {
  it("stores a metric", async () => {
    mgr.insert_metric("host1", "ping", "latency_ms", 12.3);
    await mgr.flush();
    const [row] = rows("SELECT * FROM metric WHERE target = 'host1' AND metric_name = 'latency_ms'");
    expect(row.value).toBeCloseTo(12.3);
    expect(row.plugin_id).toBe("ping");
  });

  it("keeps the newest metric last by time", async () => {
    mgr.insert_metric("h", "c", "cpu", 10);
    mgr.insert_metric("h", "c", "cpu", 20);
    await mgr.flush();
    expect(rows("SELECT value FROM metric WHERE metric_name = 'cpu' ORDER BY timestamp DESC, id DESC LIMIT 1")[0].value).toBe(20);
  });

  it("stores metric metadata", async () => {
    mgr.insert_metric("h", "c", "m", 1, '{"key": "val"}');
    await mgr.flush();
    expect(rows("SELECT metadata FROM metric WHERE metric_name = 'm'")[0].metadata).toBe('{"key": "val"}');
  });

  it("stores an event, with or without a target", async () => {
    mgr.insert_event("ERROR", "disk failed", "host1");
    mgr.insert_event("INFO", "engine started");
    await mgr.flush();
    expect(rows("SELECT target FROM event WHERE level = 'ERROR'")[0].target).toBe("host1");
    expect(rows("SELECT target FROM event WHERE message = 'engine started'")[0].target).toBeNull();
  });

  it("stores every status", async () => {
    mgr.insert_status("plugin-b", "online");
    mgr.insert_status("plugin-b", "failed");
    await mgr.flush();
    expect(rows("SELECT state FROM statushistory WHERE plugin_id = 'plugin-b' ORDER BY id").map((row) => row.state)).toEqual(["online", "failed"]);
  });

  it("returns the latest status per monitor", () => {
    expect(mgr.latest_statuses()).toEqual({});
    for (let index = 0; index < 20; index++) {
      mgr.insert_status(`m${index}`, "online");
      mgr.insert_status(`m${index}`, "failed");
    }
    const result = mgr.latest_statuses();
    expect(Object.keys(result)).toHaveLength(20);
    expect(Object.values(result).every((state) => state === "failed")).toBe(true);
    expect("nonexistent" in result).toBe(false);
  });

  it("stores a log line once", async () => {
    mgr.insert_log_line("host1", "nginx", "INFO", "started ok");
    mgr.insert_log_line("h", "svc", "INFO", "same line", "2024-01-01T00:00:00");
    mgr.insert_log_line("h", "svc", "INFO", "same line", "2024-01-01T00:00:00");
    mgr.insert_log_line("h", "svc", "INFO", "tick", "2024-01-01T00:00:00");
    mgr.insert_log_line("h", "svc", "INFO", "tick", "2024-01-01T00:00:01");
    mgr.insert_log_line("hostA", "svc", "INFO", "boot");
    mgr.insert_log_line("hostB", "svc", "INFO", "boot");
    mgr.insert_log_line("h", "svc", "INFO", "repeated");
    mgr.insert_log_line("h", "svc", "INFO", "repeated");
    await mgr.flush();
    expect(rows("SELECT plugin_id, level FROM logline WHERE message = 'started ok'")).toEqual([{ plugin_id: "nginx", level: "INFO" }]);
    const count = (message: string) => rows("SELECT id FROM logline WHERE message = ?", message).length;
    expect([count("same line"), count("tick"), count("boot"), count("repeated")]).toEqual([1, 2, 2, 1]);
  });

  it("writes a log line from a result", async () => {
    mgr.apply_result("host1", "my-plugin", "my-plugin", new CollectResult({ log_lines: [["a log message", "ERROR", "2024-01-01T00:00:00"]] }));
    await mgr.flush();
    expect(rows("SELECT message, level, target FROM logline WHERE plugin_id = 'my-plugin'")).toEqual([{ message: "a log message", level: "ERROR", target: "host1" }]);
  });

  it("reads settings with their default", async () => {
    expect(mgr.get_setting("nonexistent", "fallback")).toBe("fallback");
    expect(mgr.get_setting("nonexistent")).toBeNull();
    mgr.set_setting("k", "v1");
    mgr.set_setting("k", "v2");
    await mgr.flush();
    expect(mgr.get_setting("k")).toBe("v2");
    expect(rows("SELECT value FROM setting WHERE key = 'k'")).toEqual([{ value: "v2" }]);
  });
});

describe("apply_result", () => {
  it("prefixes a plugin event with its name", async () => {
    mgr.write_event("host1", "test-plugin", "test-plugin", "something happened", "WARNING");
    await mgr.flush();
    expect(rows("SELECT message, target FROM event WHERE level = 'WARNING'")).toEqual([{ message: "[test-plugin] something happened", target: "host1" }]);
  });

  it("writes a metric", async () => {
    mgr.apply_result("host1", "test-plugin", "test-plugin", new CollectResult({ metrics: { cpu_pct: 42.5 } }));
    await mgr.flush();
    expect(rows("SELECT value, target FROM metric WHERE plugin_id = 'test-plugin' AND metric_name = 'cpu_pct'")).toEqual([{ value: 42.5, target: "host1" }]);
  });

  it("fans out the status, log and prefixed event", async () => {
    mgr.apply_result("host1", "p", "My Plugin", new CollectResult({ metrics: { v: 1 }, logs: [["hi", "INFO"]], status: "online" }));
    await mgr.flush();
    expect(rows("SELECT id FROM metric WHERE plugin_id = 'p'")).toHaveLength(1);
    expect(rows("SELECT id FROM statushistory WHERE plugin_id = 'p' AND state = 'online'")).toHaveLength(1);
    expect(rows("SELECT message FROM event WHERE plugin_id = 'p'")[0].message).toBe("[My Plugin] hi");
  });

  it("writes a snapshot", () => {
    const snapshot = [{ pid: 1, command: "init" }];
    mgr.apply_result("host1", "svc-list", "svc-list", new CollectResult({ snapshot }));
    expect(mgr.latest_snapshot("svc-list")).toEqual(snapshot);
    expect(mgr.latest_snapshot("never", [])).toEqual([]);
    expect(mgr.latest_snapshot("never")).toBeNull();
  });
});

describe("snapshots", () => {
  it("upserts rather than appends", async () => {
    mgr.set_snapshot("p", ["first"]);
    await mgr.flush();
    mgr.set_snapshot("p", ["second"]);
    await mgr.flush();
    expect(rows("SELECT id FROM (SELECT plugin_id AS id FROM pluginsnapshot WHERE plugin_id = 'p')")).toHaveLength(1);
    expect(mgr.latest_snapshot("p")).toEqual(["second"]);
  });

  it("keeps snapshots per plugin", () => {
    mgr.set_snapshot("a", ["from-a"]);
    mgr.set_snapshot("b", ["from-b"]);
    expect([mgr.latest_snapshot("a"), mgr.latest_snapshot("b")]).toEqual([["from-a"], ["from-b"]]);
  });

  it("persists as JSON and reloads", async () => {
    const snapshot = [{ pid: 1, name: "sshd" }];
    mgr.set_snapshot("probe", snapshot);
    await mgr.flush();
    expect(JSON.parse(String(rows("SELECT data FROM pluginsnapshot WHERE plugin_id = 'probe'")[0].data))).toEqual(snapshot);
    expect((await restart()).latest_snapshot("probe")).toEqual(snapshot);
  });
});

describe("retention", () => {
  const aged_log = (days: number, message: string) => sqlite.database.prepare("INSERT INTO logline (timestamp, target, plugin_id, level, message, dedup_hash) VALUES (?, 'h', 'svc', 'INFO', ?, ?)").run(db_time(days_ago(days)), message, `hash-${message}`);
  const aged_metric = (days: number, name: string) => sqlite.database.prepare("INSERT INTO metric (timestamp, target, plugin_id, metric_name, value) VALUES (?, 'h', 'c', ?, 1.0)").run(db_time(days_ago(days)), name);
  const aged_status = (days: number, plugin_id: string, state: string) => sqlite.database.prepare("INSERT INTO statushistory (timestamp, plugin_id, state) VALUES (?, ?, ?)").run(db_time(days_ago(days)), plugin_id, state);

  it("prunes old log lines and keeps recent ones", async () => {
    aged_log(40, "old");
    aged_log(1, "fresh");
    aged_log(5, "recent");
    expect(await mgr.prune_logs(30)).toBe(1);
    expect(rows("SELECT message FROM logline ORDER BY id").map((row) => row.message)).toEqual(["fresh", "recent"]);
  });

  it.each([0, -1])("keeps every log line with a retention of %d", async (days) => {
    aged_log(400, "ancient");
    await mgr.prune_logs(days);
    await mgr.flush();
    expect(rows("SELECT id FROM logline")).toHaveLength(1);
  });

  it("prunes old metrics and keeps recent ones", async () => {
    aged_metric(40, "old");
    aged_metric(1, "fresh");
    await mgr.prune_metrics(30);
    expect(rows("SELECT metric_name FROM metric").map((row) => row.metric_name)).toEqual(["fresh"]);
  });

  it.each([0, -1])("keeps every metric with a retention of %d", async (days) => {
    aged_metric(400, "ancient");
    await mgr.prune_metrics(days);
    await mgr.flush();
    expect(rows("SELECT id FROM metric")).toHaveLength(1);
  });

  it("prunes old status rows but each monitor's newest", async () => {
    aged_status(40, "a", "online");
    aged_status(1, "a", "failed");
    aged_status(400, "stale", "unavailable");
    await mgr.prune_status(30);
    expect(rows("SELECT plugin_id, state FROM statushistory ORDER BY id")).toEqual([{ plugin_id: "a", state: "failed" }, { plugin_id: "stale", state: "unavailable" }]);
  });

  it("keeps every status with a retention of zero", async () => {
    aged_status(400, "a", "online");
    aged_status(300, "a", "failed");
    await mgr.prune_status(0);
    await mgr.flush();
    expect(rows("SELECT id FROM statushistory")).toHaveLength(2);
  });

  it("prunes only finished old jobs", async () => {
    const old = mgr.create_job("p", "h", "k", "cmd");
    mgr.finish_job(old, "succeeded", 0);
    mgr.create_job("p", "h", "k", "cmd");
    await mgr.flush();
    sqlite.database.prepare("UPDATE job SET started = ?").run(db_time(days_ago(40)));
    expect(await mgr.prune_jobs(30)).toBe(1);
    expect(rows("SELECT state FROM job")).toEqual([{ state: "running" }]);
  });
});

describe("downsampling", () => {
  const insert_at = (when: Date, name = "usage", value = 1.0) =>
    sqlite.database.prepare("INSERT INTO metric (timestamp, target, plugin_id, metric_name, value) VALUES (?, 'h', 'c', ?, ?)").run(db_time(when), name, value);
  const metric_rows = () => rows("SELECT metric_name, value FROM metric ORDER BY id");
  const hour_of = (days: number) => {
    const moment = days_ago(days);
    return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours());
  };
  const plus = (moment: Date, minutes: number) => new Date(moment.getTime() + minutes * 60_000);

  it("keeps the first row of each hour past the window", async () => {
    const hour = hour_of(10);
    for (const [minute, value] of [[5, 1], [20, 2], [40, 3]]) insert_at(plus(hour, minute), "usage", value);
    insert_at(plus(hour, 65), "usage", 4);
    mgr.downsample_metrics(7);
    await mgr.flush();
    expect(metric_rows().map((row) => row.value)).toEqual([1, 4]);
  });

  it("leaves rows inside the window alone", async () => {
    const recent = days_ago(2);
    for (let minute = 0; minute < 3; minute++) insert_at(plus(recent, minute));
    mgr.downsample_metrics(7);
    await mgr.flush();
    expect(metric_rows()).toHaveLength(3);
  });

  it("keeps a row per hour for each series", async () => {
    const hour = hour_of(9);
    for (const name of ["usage", "load"]) for (const minute of [1, 2]) insert_at(plus(hour, minute), name);
    mgr.downsample_metrics(7);
    await mgr.flush();
    expect(metric_rows().map((row) => row.metric_name).sort()).toEqual(["load", "usage"]);
  });

  it("thins a late metric in a thinned day on the next pass", async () => {
    const hour = hour_of(10);
    insert_at(plus(hour, 5), "usage", 1);
    mgr.downsample_metrics(7);
    await mgr.flush();
    mgr.apply_result("h", "c", "c", new CollectResult({ metrics: { usage: 2 }, timestamp: plus(hour, 30) }));
    await mgr.flush();
    mgr.downsample_metrics(7);
    await mgr.flush();
    expect(metric_rows().map((row) => row.value)).toEqual([1]);
  });

  it("thins a span of many days day by day", async () => {
    const start = hour_of(20);
    for (let day = 0; day < 12; day++) for (const minute of [1, 2, 3]) insert_at(plus(start, day * 1440 + minute));
    mgr.downsample_metrics(7);
    await mgr.flush();
    expect(metric_rows()).toHaveLength(12);
  });

  it("works through every day on the batching writer", async () => {
    const [batched, persistence] = manager(join(folder, "batched.db"), {}, 0.01);
    const start = hour_of(15);
    for (let day = 0; day < 6; day++) for (const minute of [1, 2]) persistence.database.prepare("INSERT INTO metric (timestamp, target, plugin_id, metric_name, value) VALUES (?, 'h', 'c', 'usage', 1)").run(db_time(plus(start, day * 1440 + minute)));
    batched.downsample_metrics(7);
    while (persistence.thinning) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(persistence.database.prepare("SELECT id FROM metric").all()).toHaveLength(6);
  });

  it("lets flush return before a stopped pass's remaining days", async () => {
    const [batched, persistence] = manager(join(folder, "stopped.db"), {}, 0.2);
    const start = hour_of(30);
    for (let day = 0; day < 20; day++) for (const minute of [1, 2]) persistence.database.prepare("INSERT INTO metric (timestamp, target, plugin_id, metric_name, value) VALUES (?, 'h', 'c', 'usage', 1)").run(db_time(plus(start, day * 1440 + minute)));
    batched.downsample_metrics(7);
    batched.stop_downsampling();
    const began = performance.now();
    await batched.flush();
    expect(performance.now() - began).toBeLessThan(1000);
    expect(persistence.thinning).toBe(false);
    batched.downsample_metrics(7);
    expect(persistence.thinning).toBe(false);
  });

  it("starts a later pass where the last one stopped", async () => {
    const old = days_ago(12);
    insert_at(old);
    mgr.downsample_metrics(7);
    await mgr.flush();
    const through = sqlite.thinned_through;
    expect(through).not.toBeNull();
    expect(through! > old).toBe(true);
    mgr.downsample_metrics(7);
    await mgr.flush();
    expect(sqlite.thinned_through! >= through!).toBe(true);
    expect(sqlite.thinning).toBe(false);
  });

  it("does nothing with zero", async () => {
    const old = days_ago(30);
    for (const minute of [1, 2]) insert_at(plus(old, minute));
    mgr.downsample_metrics(0);
    await mgr.flush();
    expect(metric_rows()).toHaveLength(2);
  });
});

describe("hydration", () => {
  it("restores metrics and their history", async () => {
    for (const value of [1, 2, 3]) mgr.insert_metric("h", "cpu", "usage", value);
    const next = await restart();
    expect(next.latest_metric("cpu", "usage")?.value).toBe(3);
    expect(next.metric_history("cpu", "usage").map((record) => record.value)).toEqual([1, 2, 3]);
  });

  it("restores only each monitor's newest status", async () => {
    mgr.insert_status("cpu", "online");
    mgr.insert_status("cpu", "failed");
    mgr.insert_status("disk", "online");
    expect((await restart()).latest_statuses()).toEqual({ cpu: "failed", disk: "online" });
  });

  it("restores a status stored under its old name as unavailable", async () => {
    sqlite.database.prepare("INSERT INTO statushistory (timestamp, plugin_id, state) VALUES (?, 'zfs', 'offline')").run(db_time(new Date()));
    expect((await restart()).latest_statuses().zfs).toBe("unavailable");
  });

  it("writes an old status name as the current one", () => {
    mgr.insert_status("zfs", "offline");
    expect(mgr.latest_status("zfs")).toBe("unavailable");
  });

  it("restores events newest first", async () => {
    for (let index = 0; index < 3; index++) mgr.insert_event("INFO", `m${index}`);
    expect((await restart()).recent_events().map((event) => event.message)).toEqual(["m2", "m1", "m0"]);
  });

  it("restores settings", async () => {
    mgr.set_setting("k", "v");
    expect((await restart()).get_setting("k")).toBe("v");
  });

  it("restores log lines with their dedup intact", async () => {
    mgr.insert_log_line("h", "nginx", "INFO", "line", "t1");
    const next = await restart();
    expect(next.log_lines("h", "", 0)).toHaveLength(1);
    next.insert_log_line("h", "nginx", "INFO", "line", "t1");
    expect(next.log_lines("h", "", 0)).toHaveLength(1);
  });

  it("restores a running job with its output", async () => {
    const job_id = mgr.create_job("p", "h", "backup", "cmd", "/tmp/x");
    mgr.set_job_pid(job_id, 4242);
    mgr.append_job_output(job_id, ["a", "b"]);
    const next = await restart();
    expect(next.get_job(job_id)).toMatchObject({ state: "running", pid: 4242, workdir: "/tmp/x" });
    expect(next.job_output(job_id).map((line) => line.message)).toEqual(["a", "b"]);
  });

  it("gives new jobs ids past the restored ones", async () => {
    const first = mgr.create_job("p", "h", "k", "cmd");
    expect((await restart()).create_job("p", "h", "k", "cmd")).toBeGreaterThan(first);
  });

  it("loads only as deep as the buffers", async () => {
    for (let value = 0; value < 50; value++) mgr.insert_metric("h", "cpu", "usage", value);
    const history = (await restart({ metric_history: 5 })).metric_history("cpu", "usage", 0);
    // The newest points are the ones kept, and still oldest to newest.
    expect(history.map((record) => record.value)).toEqual([45, 46, 47, 48, 49]);
  });

  it("restores every series when keys interleave", async () => {
    const pairs = [["cpu", "usage"], ["cpu", "load"], ["cpu-2", "usage"], ["a b", "x'y"], ["disk", "usage"]];
    for (const [plugin_id, name] of pairs) {
      mgr.insert_metric("h", plugin_id, name, 1);
      mgr.insert_metric("h", plugin_id, name, 2);
    }
    const next = await restart();
    for (const [plugin_id, name] of pairs) expect(next.metric_history(plugin_id, name).map((record) => record.value)).toEqual([1, 2]);
  });

  it("restores the log lines of every target", async () => {
    for (const target of ["h1", "h2", "h10"]) mgr.insert_log_line(target, "p", "INFO", `from ${target}`, "t1");
    const next = await restart();
    for (const target of ["h1", "h2", "h10"]) expect(next.log_lines(target, "", 0).map((line) => line.message)).toEqual([`from ${target}`]);
  });

  it("steps through each distinct key once, in order", async () => {
    for (const [plugin_id, name] of [["b", "y"], ["a", "z"], ["b", "x"], ["a", "z"], ["b", "y"]]) mgr.insert_metric("h", plugin_id, name, 1);
    await mgr.flush();
    expect([...distinct_keys(sqlite.database, "metric", "plugin_id", "metric_name")]).toEqual([["a", "z"], ["b", "x"], ["b", "y"]]);
    expect([...distinct_keys(sqlite.database, "statushistory", "plugin_id")]).toEqual([]);
  });

  it("gives metadata only to a series' newest point", async () => {
    mgr.insert_metric("h", "borg", "archive_list", 1, '{"old": 1}');
    mgr.insert_metric("h", "borg", "archive_list", 2, '{"new": 1}');
    const next = await restart();
    expect(next.latest_metric("borg", "archive_list")?.metadata).toBe('{"new": 1}');
    expect(next.metric_history("borg", "archive_list").map((record) => record.metadata)).toEqual([null, '{"new": 1}']);
  });
});

describe("job log", () => {
  it("reads a finished job's whole log from disk", async () => {
    const [small] = manager(join(folder, "small.db"), { finished_job_output: 2 });
    const job_id = small.create_job("p", "h", "switch", "cmd", "/tmp/x");
    small.append_job_output(job_id, ["a", "b", "c", "d"]);
    small.finish_job(job_id, "succeeded", 0);
    expect(small.job_output(job_id).map((line) => line.message)).toEqual(["c", "d"]);
    const log = small.job_log(job_id);
    await small.flush();
    expect((await log).map((line) => line.message)).toEqual(["a", "b", "c", "d"]);
  });

  it("reads a running job's log from memory", async () => {
    const job_id = mgr.create_job("p", "h", "switch", "cmd", "/tmp/x");
    mgr.append_job_output(job_id, ["a", "b"]);
    expect((await mgr.job_log(job_id)).map((line) => line.message)).toEqual(["a", "b"]);
  });

  it("waits for lines still queued before reading", async () => {
    const [batched] = manager(join(folder, "queued.db"), {}, 0.01);
    const job_id = batched.create_job("p", "h", "reboot", "cmd");
    batched.append_job_output(job_id, ["queued"], "stderr");
    batched.finish_job(job_id, "failed", 1);
    expect((await batched.job_log(job_id)).map((line) => [line.stream, line.message])).toEqual([["stderr", "queued"]]);
  });
});

describe("orphaned jobs", () => {
  it("fails and persists a job without a pid", async () => {
    const job_id = mgr.create_job("p", "h", "k", "cmd");
    expect(mgr.reconcile_orphaned_jobs()).toBe(1);
    expect(mgr.get_job(job_id)?.state).toBe("failed");
    await mgr.flush();
    expect(rows("SELECT state FROM job WHERE id = ?", job_id)[0].state).toBe("failed");
  });

  it("leaves a job with a pid running", () => {
    const job_id = mgr.create_job("p", "h", "k", "cmd");
    mgr.set_job_pid(job_id, 99);
    expect(mgr.reconcile_orphaned_jobs()).toBe(0);
    expect(mgr.get_job(job_id)?.state).toBe("running");
  });
});

describe("result timestamps", () => {
  let published: string[];
  let unsubscribe: () => void;

  beforeEach(() => {
    published = [];
    unsubscribe = CHANGES.subscribe((kind) => published.push(kind));
  });

  afterEach(() => unsubscribe());

  it("stores every write at the result's time", async () => {
    const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * 3_600_000);
    mgr.apply_result("host1", "p", "P", new CollectResult({ metrics: { v: 1 }, logs: [["hi", "INFO"]], log_lines: [["boom", "WARNING", null]], status: "failed", timestamp: when }));
    await mgr.flush();
    for (const table of ["metric", "event", "statushistory", "logline"]) expect(parse_db_time(rows(`SELECT timestamp FROM ${table} WHERE plugin_id = 'p'`)[0].timestamp), table).toEqual(when);
  });

  it("does not let a late status replace the current one", async () => {
    mgr.apply_result("host1", "p", "P", new CollectResult({ status: "online" }));
    mgr.apply_result("host1", "p", "P", new CollectResult({ status: "failed", timestamp: new Date(Date.now() - 3_600_000) }));
    await mgr.flush();
    expect(mgr.latest_status("p")).toBe("online");
    expect(rows("SELECT id FROM statushistory WHERE plugin_id = 'p'")).toHaveLength(2);
  });

  it("does not announce a late status", () => {
    mgr.apply_result("host1", "p", "P", new CollectResult({ status: "online" }));
    published.length = 0;
    mgr.apply_result("host1", "p", "P", new CollectResult({ status: "failed", timestamp: new Date(Date.now() - 3_600_000) }));
    expect(published).not.toContain("status");
  });

  it("makes a status from long ago current without announcing it", () => {
    mgr.apply_result("host1", "p", "P", new CollectResult({ status: "failed", timestamp: new Date(Date.now() - 3_600_000) }));
    expect(mgr.latest_status("p")).toBe("failed");
    expect(published).not.toContain("status");
  });

  it("still announces a status a moment old", () => {
    mgr.apply_result("host1", "p", "P", new CollectResult({ status: "failed", timestamp: new Date(Date.now() - 20_000) }));
    expect(published).toContain("status");
  });
});
