import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generate_agent_key } from "@x-tech-laboratories/x-libs/agent/keys";
import { follow_lines, LineServer } from "@x-tech-laboratories/x-libs/agent/local_socket";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agent_runner, CAPABILITIES, ICON_FILE, idle_inhibitor, NOTIFY_ONLY_REFUSAL, XMonitorAgent } from "../../src/agent/agent.ts";
import { load_config, type AgentConfig } from "../../src/agent/config.ts";
import { LocalRunner, PLAN_FILE, PLAN_VERSION_FILE, type LocalEngineLike } from "../../src/agent/local.ts";
import { notify, OfflineAlerts } from "../../src/agent/local_notify.ts";
import { entry_matches, JournalMux, mangle_unit, supervise } from "../../src/agent/watchers.ts";

function folder(): string {
  return mkdtempSync(join(tmpdir(), "x-monitor-agent-"));
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function config(extra: Partial<AgentConfig> = {}): AgentConfig {
  const where = folder();
  writeFileSync(join(where, "key"), generate_agent_key("a").private_text);
  writeFileSync(join(where, "agent.yaml"), `url: ws://localhost/api/agent/ws\nid: node-a\nkey_file: ${join(where, "key")}\n`);
  return { ...load_config(join(where, "agent.yaml"), {}), ...extra };
}

// ── The idle inhibitor ───────────────────────────────────────────────────────

describe("the agent's holds", () => {
  it("runs a command with the host held awake", async () => {
    const inhibitor = idle_inhibitor(0, () => null);
    const seen: number[] = [];
    const runner = agent_runner(inhibitor, false, { run: async () => { seen.push(inhibitor.holders); return { exit_code: 0, stdout: "", stderr: "" }; }, launch: () => ({ program: "true", args: [] }) });
    await runner.run("true", { timeout_in_seconds: 5 });
    expect(seen).toEqual([1]);
    expect(inhibitor.holders).toBe(0);
  });

  it("refuses commands when it only shows notifications", async () => {
    const result = await agent_runner(idle_inhibitor(0, () => null), true).run("id", { timeout_in_seconds: 5 });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toBe(NOTIFY_ONLY_REFUSAL);
  });

  it("keys the server's holds and drops them with the connection", async () => {
    const agent = new XMonitorAgent(config(), { inhibitor: idle_inhibitor(0, () => null), runner: null });
    await agent.apply_server_hold({ type: "inhibit", key: "scan:1", hold: true });
    await agent.apply_server_hold({ type: "inhibit", key: "scan:1", hold: true });
    await agent.apply_server_hold({ type: "inhibit", key: "scan:2", hold: true });
    expect(agent.inhibitor.holders).toBe(2);
    await agent.apply_server_hold({ type: "inhibit", key: "scan:1", hold: false });
    await agent.apply_server_hold({ type: "inhibit", key: "scan:1", hold: false });
    expect(agent.inhibitor.holders).toBe(1);
    agent.release_server_holds();
    expect(agent.inhibitor.holders).toBe(0);
    await agent.inhibitor.close();
  });

  it("says what it can do, with engine only when it runs monitors", () => {
    const plain = new XMonitorAgent(config(), { runner: null });
    expect(plain.capabilities().caps).toEqual(["dismiss", "inhibit", "journal", "notify", "path", "sample"]);
    expect(new XMonitorAgent(config({ notify_only: true }), { runner: null }).capabilities().caps).toEqual(["dismiss", "notify"]);
    expect(new XMonitorAgent(config(), { runner: new LocalRunner("node-a", folder()) }).capabilities().caps).toContain("engine");
  });
});

// ── Watchers ─────────────────────────────────────────────────────────────────

describe("journal streams", () => {
  it("match an entry by unit, identifier, priority and text", () => {
    expect(mangle_unit("nginx")).toBe("nginx.service");
    const entry = { _SYSTEMD_UNIT: "nginx.service", SYSLOG_IDENTIFIER: "nginx", PRIORITY: "3" };
    expect(entry_matches({ unit: "nginx" }, entry, "boom")).toBe(true);
    expect(entry_matches({ unit: "sshd" }, entry, "boom")).toBe(false);
    expect(entry_matches({ identifier: "nginx", priority: 4 }, entry, "boom")).toBe(true);
    expect(entry_matches({ priority: 2 }, entry, "boom")).toBe(false);
    expect(entry_matches({ grep: "bang" }, entry, "boom")).toBe(false);
  });

  it("share one follower among unit streams and route each its own entries", async () => {
    const spawned: string[][] = [];
    const { PassThrough } = await import("node:stream");
    const { EventEmitter } = await import("node:events");
    const stdout = new PassThrough();
    const mux = new JournalMux((args) => {
      spawned.push(args);
      return Object.assign(new EventEmitter(), { stdout, exitCode: null, kill: () => true }) as never;
    });
    const got: Record<string, unknown[]> = { nginx: [], sshd: [] };
    const controller = new AbortController();
    void mux.follow({ unit: "nginx" }, async (payload) => void got.nginx.push(payload.message), controller.signal);
    void mux.follow({ unit: "sshd.service" }, async (payload) => void got.sshd.push(payload.message), controller.signal);
    await until(() => spawned.length > 0, "the follower to start");
    expect(spawned).toEqual([["journalctl", "--follow", "--lines=0", "--output=json", "--unit", "nginx", "--unit", "sshd.service"]]);
    stdout.write(`${JSON.stringify({ _SYSTEMD_UNIT: "nginx.service", MESSAGE: "started" })}\nnot json\n`);
    await until(() => got.nginx.length === 1, "the entry to arrive");
    expect(got).toEqual({ nginx: ["started"], sshd: [] });
    controller.abort();
  });

  it("restarts a watcher that fails, and stops on abort", async () => {
    let runs = 0;
    const controller = new AbortController();
    const done = supervise("flaky", "s:1", {}, async () => undefined, controller.signal, { flaky: async () => { runs += 1; throw new Error("boom"); } }, 0.01);
    await until(() => runs >= 2, "a restart");
    controller.abort();
    await done;
  });
});

// ── Local notifications ──────────────────────────────────────────────────────

describe("local notifications", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reach a desktop agent following the socket", async () => {
    const path = join(folder(), "notify.sock");
    const notifier = new LineServer(path);
    await notifier.start();
    const received: Record<string, unknown>[] = [];
    const controller = new AbortController();
    void follow_lines(path, (frame) => received.push(frame), controller.signal, { accept: (frame) => frame.type === "notify" || frame.type === "dismiss" });
    try {
      await until(() => notifier.sockets.size > 0, "the follower to connect");
      await notifier.send(notify("Disk is failed", "body", "normal", { key: "local:disk" }) as unknown as Record<string, unknown>);
      await notifier.send({ type: "ping" });
      await until(() => received.length > 0, "the notification");
      expect(received.map((frame) => frame.title)).toEqual(["Disk is failed"]);
    } finally {
      controller.abort();
      notifier.close();
    }
  });

  function alerts(connected: { now: boolean }) {
    const statuses: Record<string, string> = {};
    const engine = { db: { latest_status: (id: string) => statuses[id] }, all_monitors: () => [{ id: "disk", name: "Disk" }] };
    const sent: Record<string, unknown>[] = [];
    const watcher = new OfflineAlerts({ send: async (frame) => void sent.push(frame) }, () => engine, () => connected.now, "odin");
    return { watcher, statuses, sent };
  }

  it("raise one for a change while offline", () => {
    const connected = { now: true };
    const { watcher, statuses, sent } = alerts(connected);
    statuses.disk = "online";
    watcher.observe("disk");
    connected.now = false;
    statuses.disk = "failed";
    watcher.observe("disk");
    expect(sent.map((frame) => [frame.title, frame.urgency])).toEqual([["Disk is failed", "critical"]]);
  });

  it("report a recovery while offline under the same key", () => {
    const { watcher, statuses, sent } = alerts({ now: false });
    for (const status of ["online", "failed", "online"]) {
      statuses.disk = status;
      watcher.observe("disk");
    }
    expect(sent.map((frame) => frame.title)).toEqual(["Disk is failed", "Disk recovered"]);
    expect(new Set(sent.map((frame) => frame.key))).toEqual(new Set(["local:disk"]));
  });

  it("leave it to the server while connected", () => {
    const { watcher, statuses, sent } = alerts({ now: true });
    for (const status of ["online", "failed"]) {
      statuses.disk = status;
      watcher.observe("disk");
    }
    expect(sent).toEqual([]);
  });
});

// ── Running monitors offline ─────────────────────────────────────────────────

// A local engine that records what the runner asks of it.
function fake_engine() {
  const log: unknown[] = [];
  const outbox: [number, string, Record<string, unknown>][] = [[1, "metric", { value: 42 }], [2, "status", { state: "online" }]];
  const engine: LocalEngineLike = {
    setup_modules: () => void log.push("setup"),
    run: async () => void log.push("run"),
    all_monitors: () => [{ id: "answer", name: "Answer" }],
    reload_config: async (source) => { log.push(["reload", source]); return { ok: true }; },
    shutdown: () => void log.push("shutdown"),
    dispatch_action: async (_plugin, action_id) => { log.push(["action", action_id]); return [true, { content: "hello", count: 2 }]; },
    run_cycle_now: async (plugin) => void log.push(["poll", (plugin as { id: string }).id]),
    db: {
      pending: (after) => outbox.filter(([seq]) => seq > after),
      acknowledge: (through) => void log.push(["ack", through]),
      trim: () => void log.push("trim"),
      latest_status: () => "online",
    },
  };
  return { engine, log };
}

describe("the monitors an agent runs itself", () => {
  it("wait for a plan, store it and run it, reloading in place for a newer one", async () => {
    const state = folder();
    const { engine, log } = fake_engine();
    const runner = new LocalRunner("node-a", state, async () => engine);
    await runner.start();
    expect(runner.engine).toBeNull();
    await runner.apply_plan("v1", { plugins: [{ name: "Answer", id: "answer", type: "command" }] });
    expect(readFileSync(join(state, PLAN_FILE), "utf8")).toContain("id: answer");
    expect(readFileSync(join(state, PLAN_VERSION_FILE), "utf8")).toBe("v1");
    expect(runner.plan_version).toBe("v1");
    await runner.apply_plan("v1", {});
    await runner.apply_plan("v2", { plugins: [] });
    expect(log).toEqual(["setup", "run", ["reload", "plan"]]);
  });

  it("sync their records from the first unacknowledged one", async () => {
    const { engine, log } = fake_engine();
    const runner = new LocalRunner("node-a", folder(), async () => engine);
    expect(await runner.pending(0)).toEqual([]);
    runner.engine = engine;
    expect((await runner.pending(1)).map(([seq]) => seq)).toEqual([2]);
    runner.acknowledge(2);
    expect(log).toEqual([["ack", 2], "trim"]);
  });

  it("run an action once per request, with its metadata as text", async () => {
    const { engine, log } = fake_engine();
    const runner = new LocalRunner("node-a", folder(), async () => engine);
    runner.engine = engine;
    expect(await runner.run_action("r1", "answer", "custom:hello", {})).toEqual([true, { content: "hello", count: "2" }]);
    await runner.run_action("r1", "answer", "custom:hello", {});
    expect(log.filter((entry) => Array.isArray(entry) && entry[0] === "action")).toHaveLength(1);
    expect(await runner.run_action("r2", "other", "x", {})).toEqual([false, { content: "This agent does not run monitor \"other\"" }]);
  });

  it("poll a monitor on the server's asking", async () => {
    const { engine, log } = fake_engine();
    const runner = new LocalRunner("node-a", folder(), async () => engine);
    runner.engine = engine;
    await runner.poll_now("answer");
    await runner.poll_now("missing");
    expect(log).toEqual([["poll", "answer"]]);
  });
});

describe("desktop notifications", () => {
  it("advertise notify and dismiss, and show X-Monitor's own icon from the bundled file", () => {
    expect(CAPABILITIES).toEqual(expect.arrayContaining(["notify", "dismiss"]));
    expect(ICON_FILE.endsWith("resources/icon.svg")).toBe(true);
    expect(existsSync(ICON_FILE)).toBe(true);
    expect(new XMonitorAgent(config(), { runner: null }).desktop.command("t", "b", "normal", null, "x-monitor")).toContain(`--icon=${ICON_FILE}`);
  });
});
