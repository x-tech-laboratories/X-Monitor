
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentConnection } from "../../../src/core/connectors/agent_connector.ts";
import { ExecContext } from "../../../src/core/connectors/engine.ts";
import type { SSHConnection } from "../../../src/core/connectors/ssh_connector.ts";
import { CollectResult } from "../../../src/core/connectors/types.ts";
import { POLL_SECONDS } from "../../../src/core/coordination/action_jobs.ts";
import { bare_host, seconds_to_clock_slot, XMonitorEngine } from "../../../src/core/coordination/engine.ts";
import { action_job_kind, WATCHED_POLL_SECONDS } from "../../../src/core/coordination/jobs.ts";
import { root_log_level, set_log_sink, set_own_log_level, set_root_log_level } from "../../../src/core/logging.ts";
import { Cpu } from "../../../src/monitors/cpu.ts";
import { Plugin } from "../../../src/monitors/base/plugin_base.ts";
import { connect_agent, new_agent_key } from "../connectors/fake_agent.ts";
import { Group, make_engine, Probe, start_engine, temp_folder, wire } from "./engine_harness.ts";

beforeEach(() => set_log_sink(() => {}));

const engines: XMonitorEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown();
});

function built(config: Record<string, unknown>): XMonitorEngine {
  const { engine } = make_engine(config);
  engines.push(engine);
  return engine;
}

async function loaded(config: Record<string, unknown>): Promise<XMonitorEngine> {
  const engine = built(config);
  await engine.setup_modules();
  return engine;
}

const ssh_of = (engine: XMonitorEngine, id: string) => engine.exec_contexts.get(id)!.conn as SSHConnection;

describe("initialization", () => {
  it("opens the database", () => {
    expect(built({ plugins: [] }).db).toBeDefined();
  });

  it("takes the database path from config or the override", () => {
    const folder = temp_folder();
    expect(make_engine({ database: { path: join(folder, "custom.db") } }, { folder }).engine.db_path).toBe(join(folder, "custom.db"));
    const override = join(folder, "override.db");
    expect(make_engine({}, { folder, db_path_override: override }).engine.db_path).toBe(override);
  });
});

describe("loading monitors", () => {
  it("loads a monitor of its own class", async () => {
    const engine = await loaded({ plugins: [{ name: "CPU", id: "host-cpu", type: "cpu", warning: 70, threshold: 85 }] });
    expect(engine.plugins).toHaveLength(1);
    expect(engine.plugins[0]).toBeInstanceOf(Cpu);
  });

  it("skips an unknown type and loads the rest", async () => {
    const engine = await loaded({ plugins: [{ name: "Bad", type: "does_not_exist" }, { name: "Good", id: "good", type: "probe", target_host: "127.0.0.1" }] });
    expect(engine.plugins.map((plugin) => plugin.name)).toEqual(["Good"]);
  });

  it("loads a nested group", async () => {
    const engine = await loaded({ plugins: [{ name: "My Group", type: "group", children: [{ name: "Child A", id: "child-a", type: "probe", target_host: "1.2.3.4" }] }] });
    expect(engine.plugins[0].name).toBe("My Group");
    expect(engine.plugins[0].children.map((child) => child.name)).toEqual(["Child A"]);
  });

  it("gives a group's children its agent", async () => {
    const engine = await loaded({ plugins: [{ name: "g", type: "group", agent: "node", children: [{ name: "c", id: "c", type: "probe" }] }] });
    expect(engine.plugins[0].children[0].config.agent).toBe("node");
    expect(engine.exec_contexts.get("c")!.is_agent).toBe(true);
  });

  it("records an event for a duplicate id", async () => {
    const engine = await loaded({ plugins: [{ name: "one", id: "x", type: "probe" }, { name: "two", id: "x", type: "probe" }] });
    expect(engine.db.recent_events(5)[0].message).toBe("[x_monitor_core] Duplicate monitor id 'x' used by: one, two");
  });
});

describe("ssh defaults", () => {
  it("merges defaults into ssh_config", async () => {
    const engine = await loaded({ ssh_defaults: { username: "beatlink", key_path: "/run/x-monitor.key" }, plugins: [{ name: "CPU", id: "cpu", type: "cpu", ssh_config: { host: "server.technet" } }] });
    expect(engine.plugins[0].config.ssh_config).toEqual({ host: "server.technet", username: "beatlink", key_path: "/run/x-monitor.key" });
    expect(ssh_of(engine, "cpu")).toMatchObject({ host: "server.technet", username: "beatlink", key_path: "/run/x-monitor.key" });
  });

  it("lets the monitor's own value win", async () => {
    const engine = await loaded({ ssh_defaults: { username: "beatlink" }, plugins: [{ name: "CPU", id: "cpu", type: "cpu", ssh_config: { host: "server.technet", username: "root" } }] });
    expect(ssh_of(engine, "cpu").username).toBe("root");
  });

  it("leaves a monitor without ssh_config alone", async () => {
    const engine = await loaded({ ssh_defaults: { username: "beatlink" }, plugins: [{ name: "Host", id: "host", type: "probe", target_host: "127.0.0.1" }] });
    expect("ssh_config" in engine.plugins[0].config).toBe(false);
  });
});

describe("retention", () => {
  it("reads the retention days", () => {
    expect(built({ logging: { retention_days: 14 } }).log_retention_days).toBe(14);
  });

  function counting(engine: XMonitorEngine): number[] {
    const calls: number[] = [];
    engine.db.prune_logs = async (days) => {
      calls.push(days ?? 0);
      return 0;
    };
    return calls;
  }

  it("prunes at most once an hour", () => {
    const engine = built({ logging: { retention_days: 30 } });
    const calls = counting(engine);
    engine.maybe_prune_logs();
    engine.maybe_prune_logs();
    expect(calls).toEqual([30]);
  });

  it("prunes right after boot", () => {
    const engine = built({ logging: { retention_days: 30 } });
    const calls = counting(engine);
    engine.monotonic = () => 10;
    engine.maybe_prune_logs();
    expect(calls).toEqual([30]);
  });

  it("does not prune with every window off", () => {
    const engine = built({ logging: { retention_days: 0 } });
    const calls = counting(engine);
    engine.maybe_prune_logs();
    expect(calls).toEqual([]);
  });
});

describe("links", () => {
  const by_host = {
    name: "By host", id: "by-host", type: "group", children: [
      { name: "Host A", id: "a", type: "group", children: [{ name: "Availability", id: "a-up", type: "probe", target_host: "a.lan" }] },
      { name: "Host B", id: "b", type: "group", children: [{ name: "Availability", id: "b-up", type: "probe", target_host: "b.lan" }] },
    ],
  };

  it("groups the same monitors another way under a second root", async () => {
    const engine = await loaded({ plugins: [by_host, { name: "By domain", id: "by-domain", type: "group", children: [{ name: "Availability", id: "availability", type: "group", children: [{ ref: "a-up", name: "Host A" }, { ref: "b-up", name: "Host B" }] }] }] });
    const [hosts, domains] = engine.plugins;
    const domain = domains.children[0];
    expect(domain.children).toEqual([hosts.children[0].children[0], hosts.children[1].children[0]]);
    expect(Object.fromEntries(domain.links)).toEqual({ "a-up": "Host A", "b-up": "Host B" });
  });

  it("runs every monitor once however many groups hold it", async () => {
    const engine = await loaded({ plugins: [by_host, { name: "Flat", id: "flat", type: "group", children: [{ ref: "a-up" }, { ref: "b-up" }] }] });
    expect(engine.all_monitors().map((plugin) => plugin.id)).toEqual(["by-host", "a", "a-up", "b", "b-up", "flat"]);
  });

  it("does not count a link as a duplicate id", async () => {
    const engine = await loaded({ plugins: [by_host, { name: "Flat", id: "flat", type: "group", children: [{ ref: "a-up" }] }] });
    expect(engine.db.recent_events(5).some((event) => event.message.includes("Duplicate"))).toBe(false);
  });
});

describe("per-monitor scheduling", () => {
  function with_saved_status(seconds_ago: number | null): XMonitorEngine {
    const engine = built({});
    if (seconds_ago !== null) engine.db.insert_status("scan", "online", new Date(Date.now() - seconds_ago * 1000));
    return engine;
  }

  const scan = { id: "scan", interval: 86400 } as Plugin;

  it("makes a current result due after the rest of its interval", () => {
    expect(with_saved_status(600).seconds_until_due(scan)).toBeCloseTo(85800, -1);
  });

  it("makes a stale result or none due now", () => {
    expect(with_saved_status(90000).seconds_until_due(scan)).toBe(0);
    expect(with_saved_status(null).seconds_until_due(scan)).toBe(0);
  });

  // Runs the loop with sleeps recorded and the clock fixed, stopping once `stop_after` sleeps have been asked for.
  async function loop(plugin: Partial<Plugin>, options: { hold?: number; stop_after: number; time?: number; woken?: boolean[]; failing?: boolean }): Promise<[number[], number, XMonitorEngine]> {
    const engine = built({});
    const calls: number[] = [];
    const abort = new AbortController();
    let cycles = 0;
    const record = async (seconds: number) => {
      calls.push(seconds);
      if (calls.length >= options.stop_after) abort.abort();
    };
    const woken = [...(options.woken ?? [])];
    engine.sleep = record;
    engine.sleep_unless_watched = async (seconds) => {
      await record(seconds);
      return woken.shift() ?? false;
    };
    engine.monotonic = () => 1000;
    if (options.time !== undefined) engine.time = () => options.time!;
    engine.run_cycle_now = async () => {
      cycles++;
      if (options.failing) throw new Error("boom");
      return true;
    };
    const monitor = { id: "p", name: "p", offset: null, next_cycle_in: () => null, ...plugin } as Plugin;
    await engine.monitor_loop(monitor, options.hold ?? 0, abort.signal);
    return [calls, cycles, engine];
  }

  it("waits out a hold before its first cycle", async () => {
    const [calls, cycles] = await loop({ interval: 86400 }, { hold: 5000, stop_after: 1 });
    expect(calls).toEqual([5000]);
    expect(cycles).toBe(0);
  });

  it("leaves the waiting set once its hold ends", async () => {
    const engine_calls = await loop({ interval: 86400, id: "scan" }, { hold: 5000, stop_after: 2 });
    expect(engine_calls[2].awaiting_due.has("scan")).toBe(false);
  });

  it("sleeps to each next due time", async () => {
    const [calls, cycles] = await loop({ interval: 42 }, { stop_after: 3 });
    expect(cycles).toBe(2);
    expect(calls[1]).toBeCloseTo(42);
    expect(calls[2] - calls[1]).toBeCloseTo(42);
  });

  it("keeps polling a crashing monitor", async () => {
    const [, cycles] = await loop({ interval: 5 }, { stop_after: 3, failing: true });
    expect(cycles).toBe(2);
  });

  it("pins each cycle to the clock with an offset", async () => {
    // 10:15 UTC: the first slot is 30 minutes away, and later cycles keep landing on :45.
    const [calls, cycles] = await loop({ interval: 3600, offset: 2700 }, { stop_after: 3, time: 36900 });
    expect(calls.slice(0, 2)).toEqual([1800, 1800]);
    expect(cycles).toBe(2);
  });

  it("polls a running job sooner without moving the schedule", async () => {
    const sooner = [30, 30, null, null];
    const [calls] = await loop({ interval: 3600, next_cycle_in: () => sooner.shift() ?? null }, { stop_after: 5 });
    expect(calls.slice(1, 3)).toEqual([30, 30]);
    expect(calls[3]).toBeCloseTo(3600);
    expect(calls[4] - calls[3]).toBeCloseTo(3600);
  });

  it("polls a running job sooner on a pinned clock", async () => {
    const sooner = [30, null];
    const [calls] = await loop({ interval: 3600, offset: 2700, next_cycle_in: () => sooner.shift() ?? null }, { stop_after: 3, time: 36900 });
    expect(calls.slice(1)).toEqual([30, 1800]);
  });

  it("does not move the schedule for a watch mid-sleep", async () => {
    const [calls] = await loop({ interval: 3600 }, { stop_after: 4, woken: [true, false, false] });
    expect(calls[1]).toBeCloseTo(3600);
    expect(calls[2]).toBeCloseTo(calls[1]);
    expect(calls[3] - calls[2]).toBeCloseTo(3600);
  });

  it("wraps a clock slot to the next period", () => {
    expect(seconds_to_clock_slot(3600, 2700, 2700)).toBe(0);
    expect(seconds_to_clock_slot(3600, 2700, 2701)).toBe(3599);
    expect(seconds_to_clock_slot(900, 0, 1000)).toBe(800);
  });
});

describe("run", () => {
  it("starts one loop per monitor in the tree", async () => {
    const { engine } = await start_engine({ plugins: [{ name: "g", id: "group", type: "group", children: [{ name: "leaf", id: "leaf", type: "probe" }] }] });
    engines.push(engine);
    expect([...engine.monitor_tasks.keys()]).toEqual(["group", "leaf"]);
  });

  it("starts no loop for a monitor its agent samples for, and one for an agent monitor that polls", async () => {
    const { engine } = await start_engine({ agents: [{ id: "node" }], plugins: [{ name: "c", id: "sampled", type: "cpu", agent: "node" }, { name: "p", id: "polled", type: "probe", agent: "node" }] });
    engines.push(engine);
    expect([...engine.monitor_tasks.keys()]).toEqual(["polled"]);
  });

  it("always polls an SSH monitor", async () => {
    const { engine } = await start_engine({ plugins: [{ name: "c", id: "over-ssh", type: "cpu", ssh_config: { host: "h" } }] });
    engines.push(engine);
    expect([...engine.monitor_tasks.keys()]).toEqual(["over-ssh"]);
  });

  it("restores state and records the start", async () => {
    const { engine } = await start_engine({ plugins: [] });
    engines.push(engine);
    expect(engine.ready).toBe(true);
    expect(engine.db.recent_events(5).map((event) => event.message)).toEqual(["X-Monitor Engine started polling loop.", "X-Monitor Engine initialized."]);
  });

  it("installs no signal handlers unless asked", async () => {
    const { engine } = await start_engine({});
    engines.push(engine);
    expect(engine.signals).toEqual([]);
  });
});

describe("log levels", () => {
  const SSH = "x_monitor.core.connectors.ssh_connector";

  afterEach(() => {
    set_root_log_level("INFO");
    set_own_log_level(SSH, null);
  });

  it("applies config levels at startup", () => {
    built({ logging: { level: "ERROR", levels: { [SSH]: "DEBUG" } } });
    expect(root_log_level()).toBe("ERROR");
  });

  it("sets a level and lists the loggers", () => {
    const engine = built({});
    engine.set_log_level(SSH, "DEBUG");
    expect(engine.log_levels()[SSH]).toBe("DEBUG");
    expect(engine.known_loggers()).toContain(SSH);
  });

  it("steps the root level on SIGUSR1 and SIGUSR2", async () => {
    const engine = make_engine({ logging: { level: "INFO" } }, { handle_signals: true }).engine;
    engine.install_signal_handlers();
    try {
      process.emit("SIGUSR1", "SIGUSR1");
      expect(root_log_level()).toBe("DEBUG");
      process.emit("SIGUSR2", "SIGUSR2");
      process.emit("SIGUSR2", "SIGUSR2");
      expect(root_log_level()).toBe("WARNING");
    } finally {
      engine.remove_signal_handlers();
    }
    expect(engine.signals).toEqual([]);
  });
});

describe("agent events", () => {
  function routed(): [XMonitorEngine, Probe] {
    const engine = built({ agents: [{ id: "node-a" }] });
    engine.ready = true;
    const plugin = wire(engine, Probe, { id: "mon", agent: "node-a", stream: "nginx" });
    return [engine, plugin];
  }

  it("parses and stores an event", () => {
    const [engine, plugin] = routed();
    plugin.parse_event = () => new CollectResult({ logs: [["Out of memory: Killed process 42 (redis)", "ERROR"]] });
    engine.on_agent_event("node-a", "mon:watch", 1234, { message: "x" });
    expect(engine.db.recent_events(5).some((event) => event.message.includes("redis"))).toBe(true);
  });

  it("drops an event for an unknown stream", () => {
    routed()[0].on_agent_event("node-a", "no-such-stream", 1234, {});
  });

  it("keeps a raising plugin from breaking the link", () => {
    const [engine, plugin] = routed();
    plugin.parse_event = () => {
      throw new Error("plugin bug");
    };
    engine.on_agent_event("node-a", "mon:watch", 1234, { message: "x" });
  });

  it("does not let a journal event stand in for the poll", () => {
    const [engine, plugin] = routed();
    engine.on_agent_event("node-a", "mon:watch", 1234, { message: "x" });
    expect(engine.last_collected(plugin.id)).toBe(0);
  });

  it("records a sample event as collected, even when it parses badly", () => {
    const engine = built({ agents: [{ id: "node-a" }] });
    engine.ready = true;
    const plugin = wire(engine, Cpu, { id: "cpu", agent: "node-a" });
    plugin.parse_event = () => {
      throw new Error("plugin bug");
    };
    engine.on_agent_event("node-a", "cpu:sample", 1234, {});
    expect(engine.last_collected("cpu")).toBeGreaterThan(0);
  });

  it("collects an agent's monitors once it connects", async () => {
    const key = new_agent_key();
    const engine = built({ agents: [{ id: "node-a", public_key: key.public_line }] });
    engine.ready = true;
    const plugin = wire(engine, Probe, { id: "mon", agent: "node-a" });
    const held = wire(engine, Probe, { id: "held", agent: "node-a" });
    engine.awaiting_due.add("held");
    connect_agent(engine.connectors.agents, "node-a", key);
    await engine.settle();
    expect(plugin.collections).toBe(1);
    expect(held.collections).toBe(0);
  });
});

describe("hosts held awake", () => {
  it("strips the user and port from a host", () => {
    expect(bare_host("deploy@Thor.technet")).toBe("thor.technet");
    expect(bare_host("thor.technet:22")).toBe("thor.technet");
    expect(bare_host("")).toBe("");
  });

  it("holds the scanned host awake for a cycle and lets it go", async () => {
    const key = new_agent_key();
    const engine = built({ agents: ["heimdall", "thor", "odin"].map((name) => ({ id: name, host: `${name}.technet`, public_key: key.public_line })) });
    engine.ready = true;
    const sockets = Object.fromEntries(["heimdall", "thor", "odin"].map((name) => [name, connect_agent(engine.connectors.agents, name, key, { caps: ["inhibit"] })]));
    const plugin = wire(engine, Probe, { id: "thor-vuln-scan", scan_host: "thor.technet", agent: "heimdall" });
    let during: unknown[] = [];
    plugin.parse = () => {
      during = sockets.thor.of_type("inhibit").map((message) => message.hold);
      return new CollectResult();
    };
    await engine.run_cycle_now(plugin);
    const frames = sockets.thor.of_type("inhibit");
    expect(during).toEqual([true]);
    expect(frames.map((message) => message.hold)).toEqual([true, false]);
    expect(frames[0].key).toBe(frames[1].key);
    expect(sockets.heimdall.of_type("inhibit")).toEqual([]);
    expect(sockets.odin.of_type("inhibit")).toEqual([]);
  });

  it("skips an agent without the capability", async () => {
    const key = new_agent_key();
    const engine = built({ agents: [{ id: "thor", host: "thor.technet", public_key: key.public_line }] });
    const socket = connect_agent(engine.connectors.agents, "thor", key);
    await (engine.connectors.agents.get("thor") as AgentConnection).inhibit("k", true);
    expect(socket.of_type("inhibit")).toEqual([]);
  });
});

describe("the action follower", () => {
  it("polls sooner while a running action's log is open", () => {
    const engine = built({});
    const plugin = wire(engine, Probe, { id: "p" });
    const job_id = plugin.jobs!.create(action_job_kind("prune"), "true", "/tmp/x");
    plugin.jobs!.set_pid(job_id, 7);
    expect(engine.action_jobs.poll_seconds()).toBe(POLL_SECONDS);
    const unwatch = plugin.jobs!.watch(plugin.jobs!.action_job("prune")!);
    expect(plugin.next_cycle_in()).toBeNull();
    expect(engine.action_jobs.poll_seconds()).toBe(WATCHED_POLL_SECONDS);
    unwatch();
    expect(engine.action_jobs.poll_seconds()).toBe(POLL_SECONDS);
  });
});

describe("job contexts", () => {
  it("runs a job on its monitor's transport or a named agent", () => {
    const engine = built({ agents: [{ id: "big" }] });
    const plugin = wire(engine, Group, { id: "g" });
    expect(engine.job_context(plugin)).toBe(engine.exec_contexts.get("g"));
    expect(engine.job_context(plugin, "big")!.is_agent).toBe(true);
    expect(engine.job_context({ id: "nope" } as Plugin)).toBeNull();
    expect(engine.exec_contexts.get("g")).toBeInstanceOf(ExecContext);
  });
});

