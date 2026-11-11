import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentConnection, AgentRegistry } from "../../../src/core/connectors/agent_connector.ts";
import { code_version } from "../../../src/core/code_version.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import { stream_from_wire } from "../../../src/shared/agent_protocol.ts";
import { connect_agent, new_agent_key, type AgentKey, type FakeAgentSocket } from "./fake_agent.ts";

const key: AgentKey = new_agent_key();
let registry: AgentRegistry;

beforeEach(() => {
  set_log_sink(() => {});
  registry = new AgentRegistry();
  registry.configure([{ id: "node-a", host: "node-a.lan", public_key: key.public_line }]);
});

afterEach(() => registry.close());

function connected(options: { caps?: string[]; code?: string } = {}): [AgentConnection, FakeAgentSocket] {
  const socket = connect_agent(registry, "node-a", key, options);
  return [registry.get("node-a")!, socket];
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("exec rpc", () => {
  it("completes a call with the agent's reply", async () => {
    const [conn, socket] = connected();
    const call = conn.execute("uptime", 5);
    const request = socket.last();
    expect(request.type).toBe("run");
    expect(request.command).toBe("uptime");
    expect(request.timeout_in_seconds).toBe(5);
    socket.reply(request.id, { exit_code: 0, stdout: "up 3 days", stderr: "" });
    expect(await call).toEqual([0, "up 3 days", ""]);
  });

  it("fails without throwing when the agent is not connected", async () => {
    const [code, out, error] = await new AgentConnection("node-a", "node-a.lan").execute("uptime");
    expect([code, out]).toEqual([-1, ""]);
    expect(error).toContain("not connected");
  });

  it("fails calls in flight when the agent disconnects", async () => {
    const [conn, socket] = connected();
    const call = conn.execute("sleep 60", 30);
    socket.close();
    const [code, , error] = await call;
    expect(code).toBe(-1);
    expect(error).toContain("disconnected");
    expect(conn.is_connected).toBe(false);
  });

  it("ignores a reply to an unknown request", () => {
    const [, socket] = connected();
    socket.reply("r999", { exit_code: 0, stdout: "late", stderr: "" });
  });

  it("runs commands side by side rather than one at a time", async () => {
    const [conn, socket] = connected();
    const calls = Array.from({ length: 20 }, (_, index) => conn.execute(`cmd${index}`, 5));
    const runs = socket.of_type("run");
    expect(runs).toHaveLength(20);
    for (const request of runs) socket.reply(request.id, { exit_code: 0, stdout: request.command, stderr: "" });
    expect((await Promise.all(calls)).map((result) => result[1])).toEqual(Array.from({ length: 20 }, (_, index) => `cmd${index}`));
  });
});

describe("login", () => {
  it("refuses an agent whose key is not the declared one", () => {
    const socket = connect_agent(registry, "node-a", new_agent_key(), { announce: false });
    expect(socket.close_code).toBe(4006);
    expect(registry.get("node-a")!.is_connected).toBe(false);
  });

  it("sends the full stream set as soon as an agent connects", () => {
    registry.require("node-a").register_stream({ id: "mon:journal", kind: "journal", params: { unit: "nginx" } });
    const [, socket] = connected();
    expect(socket.of_type("subscribe")).toEqual([{ type: "subscribe", streams: [{ id: "mon:journal", kind: "journal", params: { unit: "nginx" } }] }]);
  });

  it("calls the connect sink once the agent has said what it can do", () => {
    const seen: string[] = [];
    registry.set_connect_sink((agent_id) => seen.push(agent_id));
    const [conn] = connected({ caps: ["engine", "notify"] });
    expect(seen).toEqual(["node-a"]);
    expect(conn.capabilities).toEqual(["engine", "notify"]);
    expect(conn.hostname).toBe("node-a.lan");
  });

  it("replaces an older connection from the same agent", () => {
    const [conn, first] = connected();
    const second = connect_agent(registry, "node-a", key);
    expect(first.close_code).toBe(4003);
    expect(conn.is_connected).toBe(true);
    conn.execute("uptime");
    expect(second.of_type("run")).toHaveLength(1);
  });
});

describe("registry", () => {
  it("builds connections from config", () => {
    expect(registry.get("node-a")!.host).toBe("node-a.lan");
  });

  it("keeps the connection object across a reconfigure", () => {
    const before = registry.get("node-a");
    registry.configure([{ id: "node-a", host: "elsewhere", public_key: key.public_line, run_monitors: true }]);
    expect(registry.get("node-a")).toBe(before);
    expect(before!.host).toBe("elsewhere");
    expect(before!.run_monitors).toBe(true);
  });

  it("never lets an entry without a public key log in", () => {
    registry.configure([{ id: "node-a" }]);
    expect(registry.public_key_for("node-a")).toBeNull();
    expect(registry.hub.has_agent_key("node-a")).toBe(false);
  });

  it("refuses an unreadable public key", () => {
    registry.configure([{ id: "node-a", public_key: "ssh-ed25519 nonsense" }]);
    expect(registry.public_key_for("node-a")).toBeNull();
  });

  it("forgets the key of an agent dropped from config", () => {
    registry.configure([]);
    expect(registry.public_key_for("node-a")).toBeNull();
  });

  it("gives an undeclared agent a failing placeholder", () => {
    expect(registry.require("never-declared").is_connected).toBe(false);
  });

  it("hands events to the sink", () => {
    const seen: unknown[] = [];
    registry.set_event_sink((...args) => seen.push(args));
    registry.dispatch_event("node-a", "stream-1", 123, { message: "boom" });
    expect(seen).toEqual([["node-a", "stream-1", 123, { message: "boom" }]]);
  });

  it("routes an agent's event message to the sink", () => {
    const seen: unknown[] = [];
    registry.set_event_sink((...args) => seen.push(args));
    const [, socket] = connected();
    socket.deliver({ type: "event", stream: "mon:journal", ts: 99, payload: { message: "x" } });
    socket.deliver({ type: "event", stream: "mon:journal", ts: 100, payload: [1] });
    expect(seen).toEqual([["node-a", "mon:journal", 99, { message: "x" }], ["node-a", "mon:journal", 100, {}]]);
  });

  it("routes records and plan acknowledgements to the sync sink", async () => {
    const seen: unknown[] = [];
    registry.set_sync_sink(async (agent_id, message) => {
      seen.push([agent_id, message.type]);
    });
    const [, socket] = connected();
    socket.deliver({ type: "records", records: [] });
    socket.deliver({ type: "plan_ack", version: "v1" });
    socket.deliver({ type: "something_newer" });
    await tick();
    expect(seen).toEqual([["node-a", "records"], ["node-a", "plan_ack"]]);
  });

  it("keeps a throwing sink from escaping", () => {
    registry.set_event_sink(() => {
      throw new Error("plugin bug");
    });
    registry.dispatch_event("node-a", "stream-1", 123, {});
  });
});

describe("messages", () => {
  it("sends notifications only to an agent that supports them", async () => {
    const [conn, socket] = connected({ caps: ["notify", "dismiss"] });
    await conn.notify("Title", "Body", { urgency: "critical", key: "k1" });
    await conn.dismiss("k1");
    expect(socket.of_type("notify")).toEqual([{ type: "notify", title: "Title", body: "Body", urgency: "critical", key: "k1" }]);
    expect(socket.of_type("dismiss")).toEqual([{ type: "dismiss", key: "k1" }]);
  });

  it("refuses a notification an agent cannot show", async () => {
    const [conn] = connected();
    await expect(conn.notify("Title", "Body")).rejects.toThrow("does not support desktop notifications");
    await expect(new AgentConnection("x", "x").notify("t", "b")).rejects.toThrow("not connected");
  });

  it("skips an inhibitor for an agent that cannot hold one", async () => {
    const [conn, socket] = connected();
    await conn.inhibit("backup", true);
    expect(socket.of_type("inhibit")).toEqual([]);
    const [able, able_socket] = connected({ caps: ["inhibit"] });
    await able.inhibit("backup", true);
    expect(able_socket.of_type("inhibit")).toEqual([{ type: "inhibit", key: "backup", hold: true }]);
  });

  it("sends a plan, a records acknowledgement and a poll", async () => {
    const [conn, socket] = connected();
    await conn.send_plan("v1", { plugins: [] });
    await conn.ack_records(7);
    await conn.poll_now("cpu");
    expect(socket.sent.slice(-3)).toEqual([
      { type: "plan", version: "v1", config: { plugins: [] } }, { type: "records_ack", through: 7 }, { type: "poll_now", monitor: "cpu" },
    ]);
  });

  it("runs a monitor action as a request and returns its metadata", async () => {
    const [conn, socket] = connected();
    const call = conn.request_action("cpu", "restart", { hard: true }, 5);
    const request = socket.last();
    expect(request).toMatchObject({ type: "monitor_action", monitor: "cpu", action: "restart", args: { hard: true } });
    socket.reply(request.id, { success: true, metadata: { content: "done", count: 3 } });
    expect(await call).toEqual([true, { content: "done", count: "3" }]);
  });

  it("fails an action the agent does not answer in time", async () => {
    const [conn] = connected();
    expect(await conn.request_action("cpu", "restart", {}, 0.01)).toEqual([false, { content: "Agent 'node-a' did not answer within 0s" }]);
  });

  it("fails an action for an agent that is not connected", async () => {
    const [success, metadata] = await new AgentConnection("x", "x").request_action("m", "a", {}, 1);
    expect(success).toBe(false);
    expect(metadata.content).toContain("is not connected");
  });

  it("fails an action the agent answers with an error", async () => {
    const [conn, socket] = connected();
    const call = conn.request_action("cpu", "restart", {}, 5);
    socket.deliver({ type: "failed", id: socket.last().id, error: "no such monitor" });
    const [success, metadata] = await call;
    expect(success).toBe(false);
    expect(metadata.content).toContain("no such monitor");
  });
});

describe("stream specs", () => {
  it("round-trips through the wire", () => {
    const spec = { id: "mon-1", kind: "journal", params: { unit: "nginx.service" } };
    expect(stream_from_wire(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });

  it("rejects a spec without a kind", () => {
    expect(stream_from_wire({ id: "mon-1" })).toBeNull();
  });
});

describe("code version", () => {
  it("marks an agent on the server's code as the same", () => {
    const [conn] = connected({ code: code_version() });
    expect(conn.same_code).toBe(true);
  });

  it.each(["0000000000000000", ""])("does not mark an agent on code %j as the same", (code) => {
    const [conn] = connected({ code });
    expect(conn.same_code).toBe(false);
  });

  it("runs monitors only for an engine-capable agent on the same code that is set to", () => {
    const [conn] = connected({ caps: ["engine"] });
    expect(conn.runs_engine).toBe(false);
    conn.run_monitors = true;
    expect(conn.runs_engine).toBe(true);
  });
});
