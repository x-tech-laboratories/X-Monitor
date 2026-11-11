import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parse_private_key, sign_challenge } from "@x-tech-laboratories/x-libs/agent/keys";
import { key_host_header } from "@x-tech-laboratories/x-libs/agent/protocol";

import { code_version } from "../../src/core/code_version.ts";
import { AgentRegistry } from "../../src/core/connectors/agent_connector.ts";
import { set_log_sink } from "../../src/core/logging.ts";
import { AGENT_PATH, register_agent_endpoint } from "../../src/server/agent_endpoint.ts";
import { agent_app } from "../../src/shared/agent_protocol.ts";
import { new_agent_key, type AgentKey } from "../core/connectors/fake_agent.ts";

const key: AgentKey = new_agent_key();
let app: FastifyInstance;
let registry: AgentRegistry;
let url: string;

beforeEach(async () => {
  set_log_sink(() => {});
  registry = new AgentRegistry();
  registry.configure([{ id: "node-a", public_key: key.public_line, host: "node-a.lan" }]);
  app = fastify();
  await register_agent_endpoint(app, registry);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  url = `ws://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}${AGENT_PATH}`;
});

afterEach(async () => {
  await app.close();
});

// A hand-driven agent on a real loopback socket.
class Agent {
  readonly socket: WebSocket;
  readonly received: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];

  constructor(agent_id: string) {
    this.socket = new WebSocket(url, { headers: { [key_host_header(agent_app.name)]: agent_id } } as unknown as string[]);
    this.socket.addEventListener("message", (event) => {
      this.received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      this.wake();
    });
    this.socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.wake();
    });
    this.socket.addEventListener("error", () => this.wake());
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async until<Value>(check: () => Value | undefined | null | false, timeout = 3000): Promise<Value> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  message(type: string): Promise<Record<string, unknown>> {
    return this.until(() => this.received.find((each) => each.type === type));
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  // Answers the challenge as `agent_id` with `signing_key`, then says what it can do.
  async log_in(agent_id: string, signing_key: AgentKey = key, nonce?: string): Promise<void> {
    const challenge = await this.message("challenge");
    const signature = sign_challenge(parse_private_key(signing_key.private_text), agent_app.name, agent_id, nonce ?? String(challenge.nonce));
    this.send({ type: "hello", protocol: agent_app.protocol_version, host: "node-a.lan", agent_version: "1.0.0", runs: [], signature });
    this.send({ type: "capabilities", hostname: "node-a.lan", version: "1.0.0", caps: ["engine"], code: code_version() });
  }
}

async function connected(): Promise<Agent> {
  const agent = new Agent("node-a");
  await agent.log_in("node-a");
  await agent.until(() => registry.get("node-a")!.is_connected);
  return agent;
}

describe("handshake", () => {
  it("connects a valid signature", async () => {
    const agent = await connected();
    expect(registry.get("node-a")!.hostname).toBe("node-a.lan");
    agent.socket.close();
  });

  it("refuses a wrong key", async () => {
    const agent = new Agent("node-a");
    await agent.log_in("node-a", new_agent_key());
    await agent.until(() => agent.closed);
    expect(agent.closed!.code).toBe(4006);
    expect(registry.get("node-a")!.is_connected).toBe(false);
  });

  it("refuses an unknown agent before any socket opens", async () => {
    const agent = new Agent("stranger");
    await agent.until(() => agent.closed);
    expect(agent.received).toEqual([]);
  });

  it("refuses a signature over another nonce", async () => {
    const agent = new Agent("node-a");
    await agent.log_in("node-a", key, "some-other-nonce");
    await agent.until(() => agent.closed);
    expect(agent.closed!.code).toBe(4006);
  });

  it("refuses a hello without a signature", async () => {
    const agent = new Agent("node-a");
    await agent.message("challenge");
    agent.send({ type: "hello", protocol: agent_app.protocol_version, host: "node-a.lan", agent_version: "1.0.0", runs: [] });
    await agent.until(() => agent.closed);
    expect(agent.closed!.code).toBe(4006);
  });

  it("refuses an agent on another protocol version", async () => {
    const agent = new Agent("node-a");
    await agent.message("challenge");
    agent.send({ type: "hello", protocol: 2, host: "node-a.lan", agent_version: "1.0.0", runs: [] });
    await agent.until(() => agent.closed);
    expect(agent.closed!.code).toBe(4002);
  });
});

describe("over the wire", () => {
  it("round-trips a command", async () => {
    const agent = await connected();
    const call = registry.get("node-a")!.execute("echo hi", 5);
    const request = await agent.message("run");
    expect(request.command).toBe("echo hi");
    agent.send({ type: "reply", id: request.id, value: { exit_code: 0, stdout: "hi", stderr: "" } });
    expect(await call).toEqual([0, "hi", ""]);
  });

  it("lets a fast command finish before a slow one", async () => {
    const agent = await connected();
    const conn = registry.get("node-a")!;
    const slow = conn.execute("sleep 1", 5);
    const fast = conn.execute("echo fast", 5);
    const [slow_request, fast_request] = await agent.until(() => {
      const runs = agent.received.filter((each) => each.type === "run");
      return runs.length === 2 ? runs : null;
    });
    agent.send({ type: "reply", id: fast_request.id, value: { exit_code: 0, stdout: "fast", stderr: "" } });
    expect(await fast).toEqual([0, "fast", ""]);
    agent.send({ type: "reply", id: slow_request.id, value: { exit_code: 0, stdout: "", stderr: "" } });
    await slow;
  });

  it("brings a watcher's event to the server", async () => {
    const seen: unknown[] = [];
    registry.set_event_sink((...args) => seen.push(args));
    const agent = await connected();
    agent.send({ type: "event", stream: "mon:journal", ts: 1234, payload: { message: "boom" } });
    await agent.until(() => seen.length > 0);
    expect(seen).toEqual([["node-a", "mon:journal", 1234, { message: "boom" }]]);
  });

  it("pushes subscriptions to a live agent", async () => {
    const agent = await connected();
    const conn = registry.get("node-a")!;
    conn.register_stream({ id: "mon:journal", kind: "journal", params: { unit: "nginx" } });
    await conn.push_subscriptions();
    const pushed = await agent.until(() => agent.received.filter((each) => each.type === "subscribe" && (each.streams as unknown[]).length > 0).at(-1)?.streams as unknown[] | undefined);
    expect(pushed).toEqual([{ id: "mon:journal", kind: "journal", params: { unit: "nginx" } }]);
  });
});

describe("collect on connect", () => {
  it("fires the registry's connect sink", async () => {
    const seen: string[] = [];
    registry.set_connect_sink((agent_id) => seen.push(agent_id));
    const agent = await connected();
    await agent.until(() => seen.length > 0);
    expect(seen).toEqual(["node-a"]);
  });

  it("keeps a throwing connect sink from breaking the login", async () => {
    registry.set_connect_sink(() => {
      throw new Error("engine bug");
    });
    const agent = await connected();
    const call = registry.get("node-a")!.execute("true", 5);
    const request = await agent.message("run");
    agent.send({ type: "reply", id: request.id, value: { exit_code: 0, stdout: "", stderr: "" } });
    expect((await call)[0]).toBe(0);
  });
});
