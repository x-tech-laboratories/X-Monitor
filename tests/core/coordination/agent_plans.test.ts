import { beforeEach, describe, expect, it } from "vitest";

import { CollectResult } from "../../../src/core/connectors/types.ts";
import type { XMonitorEngine } from "../../../src/core/coordination/engine.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import * as records from "../../../src/core/sync/records.ts";
import type { Plugin } from "../../../src/monitors/base/plugin_base.ts";
import { connect_agent, new_agent_key } from "../connectors/fake_agent.ts";
import { make_engine } from "./engine_harness.ts";

beforeEach(() => set_log_sink(() => {}));

const key = new_agent_key();

async function engine_for(run_monitors = true): Promise<XMonitorEngine> {
  const { engine } = make_engine({
    agents: [{ id: "node-a", run_monitors, public_key: key.public_line }, { id: "node-b" }],
    plugins: [
      { name: "Disk", id: "disk", type: "probe", agent: "node-a" },
      { name: "Site", id: "site", type: "cpu", agent: "node-a" },
      { name: "Other", id: "other", type: "probe", agent: "node-b" },
      { name: "Host", id: "host", type: "group", agent: "node-a", children: [{ name: "Load", id: "load", type: "probe" }] },
    ],
  });
  await engine.setup_modules();
  // A monitor that cannot run on its agent's own host stays with the server.
  Object.defineProperty(engine.all_monitors().find((plugin) => plugin.id === "site"), "RUNS_ON_AGENT", { value: false });
  await engine.load_state();
  engine.ready = true;
  return engine;
}

const monitor = (engine: XMonitorEngine, id: string) => engine.all_monitors().find((plugin) => plugin.id === id)!;
const take = (engine: XMonitorEngine, agent_id: string, ids: string[]) => engine.agent_plans["acked"].set(agent_id, ["v", new Set(ids)]);

function result_record(monitor_id: string, status: string, minutes_ago: number): records.RecordPayload {
  return records.encode_result("node-a", monitor_id, monitor_id, new CollectResult({ status, timestamp: new Date(Date.now() - minutes_ago * 60_000) }))[1];
}

describe("plans", () => {
  it("holds the agent's host-local monitors, inherited ones too", async () => {
    const [, config, ids] = (await engine_for()).agent_plans.compile("node-a");
    expect([...ids].sort()).toEqual(["disk", "load"]);
    expect(new Set((config.plugins as { id: string }[]).map((entry) => entry.id))).toEqual(new Set(["disk", "load"]));
  });

  it("versions a plan by its content", async () => {
    const engine = await engine_for();
    expect(engine.agent_plans.compile("node-a")[0]).toBe(engine.agent_plans.compile("node-a")[0]);
    expect(engine.agent_plans.compile("node-a")[0]).not.toBe(engine.agent_plans.compile("node-b")[0]);
  });
});

describe("who runs what", () => {
  it("runs everything on the server until an agent acknowledges a plan", async () => {
    const engine = await engine_for();
    expect(engine.agent_plans.runs(monitor(engine, "disk"))).toBe(false);
  });

  it("gives an acknowledged monitor to the agent", async () => {
    const engine = await engine_for();
    take(engine, "node-a", ["disk"]);
    expect(engine.agent_plans.runs(monitor(engine, "disk"))).toBe(true);
    expect(engine.agent_plans.runs(monitor(engine, "site"))).toBe(false);
  });

  it("gives the monitors back when run_monitors is off", async () => {
    const engine = await engine_for(false);
    take(engine, "node-a", ["disk"]);
    expect(engine.agent_plans.runs(monitor(engine, "disk"))).toBe(false);
  });

  it("does not run an agent-run monitor's schedule", async () => {
    const engine = await engine_for();
    take(engine, "node-a", ["disk"]);
    monitor(engine, "disk").scheduled_actions = [{ state_key: () => "k" } as never];
    engine.start_due_schedules(Date.now() / 1000);
    expect(engine.scheduled_running.size).toBe(0);
  });
});

describe("silence", () => {
  it("marks a quiet agent's monitor unavailable once", async () => {
    const engine = await engine_for();
    take(engine, "node-a", ["disk"]);
    engine.agent_plans["last_record"].set("disk", performance.now() / 1000 - 3600);
    engine.agent_plans.check_silence(monitor(engine, "disk"));
    engine.agent_plans.check_silence(monitor(engine, "disk"));
    expect(engine.db.latest_status("disk")).toBe("unavailable");
    expect(engine.db.store.recent_events().filter((event) => event.message.includes("has sent nothing"))).toHaveLength(1);
  });

  it("leaves a monitor with a recent record as it is", async () => {
    const engine = await engine_for();
    take(engine, "node-a", ["disk"]);
    engine.agent_plans["last_record"].set("disk", performance.now() / 1000);
    engine.agent_plans.check_silence(monitor(engine, "disk"));
    expect(engine.agent_plans["silent"].has("disk")).toBe(false);
  });
});

describe("the summary after an offline stretch", () => {
  async function quiet(): Promise<[XMonitorEngine, unknown[][]]> {
    const engine = await engine_for();
    take(engine, "node-a", ["disk", "load"]);
    engine.db.insert_status("disk", "online");
    engine.agent_plans["last_record"].set("disk", performance.now() / 1000 - 3600);
    engine.agent_plans.check_silence(monitor(engine, "disk"));
    const sent: unknown[][] = [];
    engine.notifications.send_summary = (...args) => void sent.push(args);
    return [engine, sent];
  }

  const apply = (engine: XMonitorEngine, payload: records.RecordPayload) => engine.agent_plans["apply_record"]("node-a", records.RESULT, payload);

  it("lists what changed once live records resume", async () => {
    const [engine, sent] = await quiet();
    apply(engine, result_record("disk", "online", 50));
    apply(engine, result_record("disk", "failed", 40));
    apply(engine, result_record("disk", "online", 30));
    expect(sent).toEqual([]);
    apply(engine, result_record("disk", "online", 0));
    expect(sent).toHaveLength(1);
    const [title, body, ids, status] = sent[0] as [string, string, string[], string];
    expect(title.startsWith("node-a is back after")).toBe(true);
    expect(body.startsWith("Disk: failed at")).toBe(true);
    expect(body).toContain(", online at");
    expect(ids).toEqual(["disk", "load"]);
    expect(status).toBe("failed");
  });

  it("still says the agent is back with no changes", async () => {
    const [engine, sent] = await quiet();
    apply(engine, result_record("disk", "online", 20));
    apply(engine, result_record("disk", "online", 0));
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toContain("No monitor changed status");
  });

  it("sends nothing for an agent that never went quiet", async () => {
    const engine = await engine_for();
    take(engine, "node-a", ["disk"]);
    const sent: unknown[] = [];
    engine.notifications.send_summary = (...args) => void sent.push(args);
    apply(engine, result_record("disk", "failed", 20));
    apply(engine, result_record("disk", "online", 0));
    expect(sent).toEqual([]);
  });
});

describe("an agent running its monitors, over the link", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("takes a plan, syncs records in order and answers actions", async () => {
    const engine = await engine_for();
    const disk = monitor(engine, "disk") as Plugin;
    const socket = connect_agent(engine.connectors.agents, "node-a", key, { caps: ["engine"] });
    await engine.agent_plans.refresh();
    const plan = socket.of_type("plan").at(-1)!;
    socket.deliver({ type: "plan_ack", version: plan.version });
    await tick();
    expect(engine.agent_plans.runs(disk)).toBe(true);

    const [, payload] = records.encode_result("node-a", "disk", "Disk", new CollectResult({ metrics: { used_pct: 42 }, timestamp: new Date(Date.now() - 600_000) }));
    const [, job] = records.encode_job(records.JOB_CREATE, 9, { plugin_id: "disk", target: "node-a", kind: "backup", command: "x" });
    socket.deliver({ type: "records", records: [[1, records.RESULT, payload], [2, records.JOB, job], [3, records.SETTING, { key: "k", value: "v" }]] });
    await tick();
    expect(engine.db.latest_metric("disk", "used_pct")?.value).toBe(42);
    expect(engine.db.recent_jobs("disk")).toHaveLength(1);
    expect(engine.db.get_setting("k")).toBe("v");
    expect(socket.of_type("records_ack").at(-1)).toEqual({ type: "records_ack", through: 3 });

    // A batch sent again is acknowledged without being stored twice.
    socket.deliver({ type: "records", records: [[1, records.RESULT, payload]] });
    await tick();
    expect(engine.db.metric_history("disk", "used_pct", 0)).toHaveLength(1);

    const absorbed: unknown[] = [];
    disk.absorb_remote_action = (action_id, metadata, args) => void absorbed.push([action_id, metadata, args]);
    const call = engine.dispatch_action(disk, "browse_archive", { archive: "a1" });
    const request = socket.last();
    expect(request).toMatchObject({ type: "monitor_action", monitor: "disk", action: "browse_archive", args: { archive: "a1" } });
    socket.reply(request.id, { success: true, metadata: { content: "listed" } });
    expect(await call).toEqual([true, { content: "listed" }]);
    expect(absorbed).toEqual([["browse_archive", { content: "listed" }, { archive: "a1" }]]);

    expect(await engine.run_cycle_now(disk)).toBe(true);
    expect(socket.of_type("poll_now")).toEqual([{ type: "poll_now", monitor: "disk" }]);
  });

  it("sends the current plan to an agent acknowledging another", async () => {
    const engine = await engine_for();
    const socket = connect_agent(engine.connectors.agents, "node-a", key, { caps: ["engine"] });
    socket.deliver({ type: "plan_ack", version: "stale" });
    await tick();
    expect(socket.of_type("plan")).toHaveLength(1);
    expect(engine.agent_plans.runs(monitor(engine, "disk"))).toBe(false);
  });
});
