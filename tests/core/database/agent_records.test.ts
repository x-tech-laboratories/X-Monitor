import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalConnection } from "../../../src/core/connectors/local_connector.ts";
import { CollectResult } from "../../../src/core/connectors/types.ts";
import { open_agent_database, type AgentDatabase } from "../../../src/core/database/agent_database.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import * as records from "../../../src/core/sync/records.ts";

let folder: string;
let agent_db: AgentDatabase;
const open: AgentDatabase[] = [];

function agent(path = join(folder, "agent.db"), outbox_limit?: number): AgentDatabase {
  const made = open_agent_database(path, { write_batch_seconds: 0, outbox_limit });
  open.push(made);
  return made;
}

beforeEach(() => {
  set_log_sink(() => {});
  folder = mkdtempSync(join(tmpdir(), "x-monitor-agent-db-"));
  agent_db = agent();
});

afterEach(async () => {
  for (const each of open.splice(0)) await each.close();
});

async function pending(database = agent_db, after = 0): Promise<[number, string, Record<string, unknown>][]> {
  await database.flush();
  return database.pending(after);
}

describe("encoding", () => {
  it("keeps a result and its time through the round trip", () => {
    const when = new Date(2026, 9, 23, 2, 10);
    const result = new CollectResult({
      metrics: { used_pct: 41.5 }, metadata: { used_pct: "x" }, logs: [["hi", "INFO"]], log_lines: [["boom", "WARNING", "02:09"]],
      status: "failed", snapshot: [{ pid: 1 }], settings: { k: "v" }, timestamp: when,
    });
    const [kind, payload] = records.encode_result("odin", "disk", "Disk", result);
    const [target, plugin_id, name, back] = records.decode_result(JSON.parse(JSON.stringify(payload)));
    expect([kind, target, plugin_id, name]).toEqual([records.RESULT, "odin", "disk", "Disk"]);
    expect(back).toEqual(result);
  });

  it("stamps a result without a time when it is recorded", () => {
    const now = new Date(2026, 9, 23, 3, 0);
    const [, payload] = records.encode_result("odin", "disk", "Disk", new CollectResult({ status: "online" }), now);
    expect(payload.ts).toBe("2026-10-23T03:00:00");
    expect(records.decode_result(payload)[3].timestamp).toEqual(now);
  });

  it("writes a fraction of a second as Python did", () => {
    expect(records.python_isoformat(new Date(2026, 9, 23, 3, 0, 0, 5))).toBe("2026-10-23T03:00:00.005000");
  });
});

describe("outbox", () => {
  it("records every kind of write in order", async () => {
    agent_db.apply_result("odin", "borg", "Borg", new CollectResult({ status: "online" }));
    const job_id = agent_db.create_job("borg", "odin", "backup", "borg create");
    agent_db.set_job_pid(job_id, 42);
    agent_db.append_job_output(job_id, ["line"]);
    agent_db.finish_job(job_id, "succeeded", 0);
    agent_db.set_setting("schedule-result:borg", "{}");
    const kinds = (await pending()).map(([, kind, payload]) => [kind, payload.step ?? null]);
    expect(kinds).toEqual([["result", null], ["job", "create"], ["job", "pid"], ["job", "output"], ["job", "finish"], ["setting", null]]);
  });

  it("still writes to the agent's own store", () => {
    agent_db.apply_result("odin", "borg", "Borg", new CollectResult({ metrics: { archives: 3 } }));
    expect(agent_db.store.latest_metric("borg", "archives")?.value).toBe(3);
  });

  it("forgets acknowledged records", async () => {
    for (let value = 0; value < 3; value++) agent_db.apply_result("odin", "p", "P", new CollectResult({ metrics: { v: value } }));
    const seqs = (await pending()).map(([seq]) => seq);
    agent_db.acknowledge(seqs[1]);
    expect((await pending()).map(([seq]) => seq)).toEqual(seqs.slice(2));
  });

  it("reads past a sequence number", async () => {
    for (let value = 0; value < 3; value++) agent_db.apply_result("odin", "p", "P", new CollectResult({ metrics: { v: value } }));
    const first = (await pending())[0][0];
    expect(await pending(agent_db, first)).toHaveLength(2);
  });

  it("carries the numbering on after a restart", async () => {
    const path = join(folder, "restart.db");
    const first = agent(path);
    first.apply_result("odin", "p", "P", new CollectResult({ status: "online" }));
    const last = (await pending(first)).at(-1)![0];
    await first.close();
    const second = agent(path);
    second.apply_result("odin", "p", "P", new CollectResult({ status: "online" }));
    expect((await pending(second)).at(-1)![0]).toBe(last + 1);
  });

  it("trims the oldest results and keeps job records", async () => {
    const manager = agent(join(folder, "trim.db"), 2);
    manager.create_job("borg", "odin", "backup", "borg create");
    for (let value = 0; value < 3; value++) {
      manager.apply_result("odin", "p", "P", new CollectResult({ metrics: { v: value }, timestamp: new Date(Date.now() - (3 - value) * 60_000) }));
    }
    await manager.flush();
    expect(manager.trim()).toBe(2);
    expect((await pending(manager)).map(([, kind]) => kind)).toEqual(["job", "result"]);
  });
});

describe("local connection", () => {
  it("runs a command here", async () => {
    expect(await new LocalConnection("odin").execute("echo hi; echo err >&2; exit 3")).toEqual([3, "hi", "err"]);
  });

  it("maps a timeout to the shared failure shape", async () => {
    const [code, out, error] = await new LocalConnection("odin").execute("sleep 5", 0.2);
    expect([code, out]).toEqual([-1, ""]);
    expect(error).toContain("Timed out");
  });
});
