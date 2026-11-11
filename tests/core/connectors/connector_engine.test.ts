import { beforeEach, describe, expect, it } from "vitest";

import { ConnectorEngine, ExecContext } from "../../../src/core/connectors/engine.ts";
import { action_plan, command, COLLECT_TIMEOUT, CONTROL_TIMEOUT, dns_query, dns_result, http_request, http_result, ping_request, ping_result } from "../../../src/core/connectors/types.ts";
import type { TransportConnection } from "../../../src/core/contracts.ts";
import { set_log_sink } from "../../../src/core/logging.ts";

// A transport that records each call and answers with a fixed result.
class Recorder implements TransportConnection {
  readonly host = "test.host";
  calls: [string, number | null | undefined][] = [];
  answer: [number, string, string] = [0, "output", ""];

  async execute(text: string, timeout?: number | null): Promise<[number, string, string]> {
    this.calls.push([text, timeout]);
    return this.answer;
  }
}

let conn: Recorder;
let engine: ConnectorEngine;

function context(timeout = COLLECT_TIMEOUT): ExecContext {
  return new ExecContext(conn, timeout);
}

beforeEach(() => {
  set_log_sink(() => {});
  conn = new Recorder();
  engine = new ConnectorEngine();
});

describe("exec context", () => {
  it("takes its target from the connection's host", () => {
    expect(engine.exec_context({ ssh_config: { host: "test.host" } }).target).toBe("test.host");
  });

  it("pools one connection per target", () => {
    const config = { ssh_config: { host: "test.host" } };
    expect(engine.exec_context(config).conn).toBe(engine.exec_context(config).conn);
    expect(engine.ssh_conns.size).toBe(1);
  });

  it("keeps targets with another port or user apart", () => {
    engine.exec_context({ ssh_config: { host: "h" } });
    engine.exec_context({ ssh_config: { host: "h", port: 2222 } });
    engine.exec_context({ ssh_config: { host: "h", username: "root" } });
    expect(engine.ssh_conns.size).toBe(3);
  });

  it("picks the agent transport for an `agent` key", () => {
    engine.agents.configure([{ id: "node-a", host: "node-a.lan" }]);
    const handle = engine.exec_context({ agent: "node-a" });
    expect(handle.is_agent).toBe(true);
    expect(handle.target).toBe("node-a.lan");
  });

  it("keeps using SSH without an `agent` key", () => {
    const handle = engine.exec_context({ ssh_config: { host: "web-01" } });
    expect(handle.is_agent).toBe(false);
    expect(handle.target).toBe("web-01");
  });

  it("runs commands for its own agent id locally", async () => {
    const local = new ConnectorEngine("self");
    const handle = local.exec_context({ agent: "self" });
    expect(handle.is_agent).toBe(false);
    expect(await handle.conn.execute("echo hello", 5)).toEqual([0, "hello", ""]);
  });

  it("closes only the connections no live handle uses", () => {
    const kept = engine.exec_context({ ssh_config: { host: "a" } }).conn;
    engine.exec_context({ ssh_config: { host: "b" } });
    expect(engine.close_unused([kept])).toBe(1);
    expect([...engine.ssh_conns.values()]).toEqual([kept]);
  });
});

describe("collect commands", () => {
  it("returns a CmdResult on success", async () => {
    const [result] = await engine.dispatch(context(), [command("ls")]);
    expect(result).toEqual({ kind: "cmd", exit_code: 0, stdout: "output", stderr: "" });
  });

  it("passes a nonzero exit through", async () => {
    conn.answer = [1, "", "command not found"];
    const [result] = await engine.dispatch(context(), [command("bad_cmd")]);
    expect(result).toMatchObject({ exit_code: 1, stderr: "command not found" });
  });

  it("passes the transport's failure through", async () => {
    conn.answer = [-1, "", "connection reset"];
    const [result] = await engine.dispatch(context(), [command("cmd")]);
    expect(result).toMatchObject({ exit_code: -1, stderr: "connection reset" });
  });

  it("uses the collect timeout by default", async () => {
    await engine.dispatch(context(), [command("df -h")]);
    expect(conn.calls).toEqual([["df -h", COLLECT_TIMEOUT]]);
  });

  it("takes a configured collect timeout", async () => {
    await engine.dispatch(context(120), [command("slow-command")]);
    expect(conn.calls).toEqual([["slow-command", 120]]);
  });

  it("lets a command's own timeout win", async () => {
    await engine.dispatch(context(30), [command("slow-command", { timeout: 90 })]);
    expect(conn.calls).toEqual([["slow-command", 90]]);
  });

  it("runs an offloaded command on the named agent", async () => {
    const offload = new ConnectorEngine("big-host");
    const [result] = await offload.dispatch(context(), [command("echo there", { agent: "big-host" })]);
    expect(result).toMatchObject({ exit_code: 0, stdout: "there" });
    expect(conn.calls).toEqual([]);
  });
});

describe("action commands", () => {
  it("gives an action command the control timeout", async () => {
    await engine.dispatch(context(), [command("systemctl restart foo", { action: true })]);
    expect(conn.calls).toEqual([["systemctl restart foo", CONTROL_TIMEOUT]]);
  });

  it("keeps the control timeout longer than the collect one", () => {
    expect(CONTROL_TIMEOUT).toBeGreaterThan(COLLECT_TIMEOUT);
  });

  it("runs a plan with the control timeout by default", async () => {
    expect((await engine.execute(context(), action_plan("df -h"))).exit_code).toBe(0);
    expect(conn.calls).toEqual([["df -h", CONTROL_TIMEOUT]]);
  });

  it("lets a plan's own timeout win", async () => {
    await engine.execute(context(), action_plan("slow-command", { timeout: 90 }));
    expect(conn.calls).toEqual([["slow-command", 90]]);
  });

  it("runs a raw command with the control timeout", async () => {
    await engine.execute_raw(context(), "kill 1234");
    expect(conn.calls).toEqual([["kill 1234", CONTROL_TIMEOUT]]);
  });
});

describe("routing", () => {
  it("routes a command to the monitor's transport", async () => {
    const [result] = await engine.dispatch(context(), [command("echo hi")]);
    expect(result).toMatchObject({ kind: "cmd", stdout: "output" });
    expect(conn.calls).toHaveLength(1);
  });

  it("routes each request by its kind, in order", async () => {
    engine.http = { fetch: async () => http_result(200, "ok"), close: () => {} };
    engine.dns = { resolve: async () => dns_result("ok") };
    engine.icmp = { ping: async () => ping_result(null, 0) };
    const results = await engine.dispatch(null, [http_request("https://x/"), dns_query("d"), ping_request("h")]);
    expect(results.map((result) => result.kind)).toEqual(["http", "dns", "ping"]);
  });
});
