import { renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type { AgentConnection } from "../../../src/core/connectors/agent_connector.ts";
import type { SSHConnection } from "../../../src/core/connectors/ssh_connector.ts";
import type { XMonitorEngine } from "../../../src/core/coordination/engine.ts";
import { ReloadResult, restart_required } from "../../../src/core/coordination/reload.ts";
import { root_log_level, set_log_sink, set_root_log_level } from "../../../src/core/logging.ts";
import * as changes from "../../../src/core/state/changes.ts";
import { CHANGES } from "../../../src/core/state/changes.ts";
import type { Plugin } from "../../../src/monitors/base/plugin_base.ts";
import { new_agent_key } from "../connectors/fake_agent.ts";
import { start_engine, write_folder_plugin, type Harness } from "./engine_harness.ts";

const probe = (id: string, extra: Record<string, unknown> = {}) => ({ name: id, id, type: "probe", interval: 60, ...extra });
const ssh = (id: string, host: string, extra: Record<string, unknown> = {}) => probe(id, { ssh_config: { host }, ...extra });

let harness: Harness | null = null;
let engine: XMonitorEngine;

beforeEach(() => set_log_sink(() => {}));

afterEach(async () => {
  await harness?.engine.shutdown();
  harness = null;
  set_root_log_level("INFO");
});

async function start(plugins: unknown[], sections: Record<string, unknown> = {}): Promise<XMonitorEngine> {
  harness = await start_engine({ plugins, ...sections });
  engine = harness.engine;
  return engine;
}

function reload(plugins: unknown[], sections: Record<string, unknown> = {}): Promise<ReloadResult> {
  harness!.write({ plugins, ...sections });
  return engine.reload_config("test");
}

const monitor = (id: string): Plugin => engine.all_monitors().find((plugin) => plugin.id === id)!;
const aborted = (id: string, task = engine.monitor_tasks.get(id)) => task!.signal.aborted;

async function wait_for(check: () => boolean, seconds = 3): Promise<boolean> {
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += 20) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("monitor diff", () => {
  it("keeps an unchanged monitor running untouched", async () => {
    await start([probe("a"), probe("b")]);
    const a = monitor("a");
    const task = engine.monitor_tasks.get("a");
    const result = await reload([probe("a"), probe("b", { interval: 30 })]);
    expect([result.ok, result.changed, result.added, result.removed]).toEqual([true, ["b"], [], []]);
    expect(monitor("a")).toBe(a);
    expect(engine.monitor_tasks.get("a")).toBe(task);
    expect(aborted("a")).toBe(false);
  });

  it("stops a removed monitor", async () => {
    await start([probe("a"), probe("b")]);
    const task = engine.monitor_tasks.get("b")!;
    const result = await reload([probe("a")]);
    expect(result.removed).toEqual(["b"]);
    expect(engine.plugins.map((plugin) => plugin.id)).toEqual(["a"]);
    expect(task.signal.aborted).toBe(true);
    expect(engine.monitor_tasks.has("b")).toBe(false);
    expect(engine.exec_contexts.has("b")).toBe(false);
  });

  it("wires and starts an added monitor", async () => {
    await start([probe("a")]);
    const result = await reload([probe("a"), probe("new")]);
    expect(result.added).toEqual(["new"]);
    const added = monitor("new");
    expect(added.engine).toBe(engine);
    expect(added.data).toBeDefined();
    expect(added.jobs).not.toBeNull();
    expect(aborted("new")).toBe(false);
  });

  it("replaces a changed monitor and keeps its history", async () => {
    await start([probe("a")]);
    const old = monitor("a");
    const task = engine.monitor_tasks.get("a")!;
    engine.db.insert_status("a", "failed");
    const result = await reload([probe("a", { interval: 10 })]);
    expect(result.changed).toEqual(["a"]);
    expect(monitor("a")).not.toBe(old);
    expect(monitor("a").interval).toBe(10);
    expect(task.signal.aborted).toBe(true);
    expect(aborted("a")).toBe(false);
    expect(engine.db.latest_status("a")).toBe("failed");
  });

  it("re-resolves a kept group's children", async () => {
    const group = { name: "g", id: "g", type: "group", children: [probe("a")] };
    await start([group]);
    const kept = monitor("g");
    const result = await reload([{ ...group, children: [probe("a"), probe("b")] }]);
    expect([result.added, result.changed]).toEqual([["b"], []]);
    expect(monitor("g")).toBe(kept);
    expect(kept.children.map((child) => child.id)).toEqual(["a", "b"]);
    expect(engine.plugins).toEqual([kept]);
  });

  it("keeps a monitor's instance when it moves between groups", async () => {
    await start([{ name: "one", id: "one", type: "group", children: [probe("a")] }, { name: "two", id: "two", type: "group", children: [] }]);
    const a = monitor("a");
    const version = engine.monitors_version;
    const result = await reload([{ name: "one", id: "one", type: "group", children: [] }, { name: "two", id: "two", type: "group", children: [probe("a")] }]);
    expect([result.added, result.removed, result.changed]).toEqual([[], [], []]);
    expect(monitor("two").children).toEqual([a]);
    expect(engine.monitors_version).toBe(version + 1);
  });

  it("points a link at the kept instance, and counts a changed label as a tree change", async () => {
    const hosts = { name: "hosts", id: "hosts", type: "group", children: [probe("a")] };
    await start([hosts, { name: "domains", id: "domains", type: "group", children: [{ ref: "a", name: "web" }] }]);
    const a = monitor("a");
    const result = await reload([hosts, { name: "domains", id: "domains", type: "group", children: [{ ref: "a", name: "web" }] }, probe("b")]);
    expect([result.added, result.changed]).toEqual([["b"], []]);
    expect(monitor("domains").children).toEqual([a]);
    expect(engine.all_monitors().filter((plugin) => plugin.id === "a")).toHaveLength(1);
    const version = engine.monitors_version;
    await reload([hosts, { name: "domains", id: "domains", type: "group", children: [{ ref: "a", name: "site" }] }, probe("b")]);
    expect(Object.fromEntries(monitor("domains").links)).toEqual({ a: "site" });
    expect(engine.monitors_version).toBe(version + 1);
  });

  it("lets ssh_defaults decide what changed", async () => {
    await start([ssh("a", "h1"), probe("b")], { ssh_defaults: { username: "one" } });
    const result = await reload([ssh("a", "h1"), probe("b")], { ssh_defaults: { username: "two" } });
    expect(result.changed).toEqual(["a"]);
    expect((monitor("a").config.ssh_config as Record<string, unknown>).username).toBe("two");
  });

  it("writes nothing from an in-flight cycle of a replaced monitor", async () => {
    await start([probe("a")]);
    const old = monitor("a");
    await reload([probe("a", { interval: 10 })]);
    expect(await engine.run_cycle(old)).toBe(false);
  });
});

describe("refused reloads", () => {
  it.each([["plugins: [unclosed", "Failed to parse YAML"], ["", "empty or not a mapping"]])("keeps the running config for %j", async (content, error) => {
    await start([probe("a")]);
    const before = [...engine.plugins];
    writeFileSync(harness!.path, content);
    const result = await engine.reload_config("test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain(error);
    expect(engine.plugins).toEqual(before);
  });

  it("applies nothing with an unknown type", async () => {
    await start([probe("a")]);
    const a = monitor("a");
    const result = await reload([probe("a", { interval: 5 }), { name: "x", id: "x", type: "nope" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no plugin type 'nope'");
    expect(monitor("a")).toBe(a);
    expect(a.interval).toBe(60);
  });

  it("applies nothing with duplicate ids", async () => {
    await start([probe("a")]);
    const result = await reload([probe("a"), probe("b"), { ...probe("b"), name: "other" }]);
    expect(result.error).toContain("duplicate monitor id(s) b");
    expect(engine.plugins.map((plugin) => plugin.id)).toEqual(["a"]);
  });

  it("applies nothing when the file is gone", async () => {
    await start([probe("a")]);
    unlinkSync(harness!.path);
    expect((await engine.reload_config("test")).error).toContain("not found");
  });

  it("records the failure as an event", async () => {
    await start([probe("a")]);
    writeFileSync(harness!.path, "plugins: [unclosed");
    await engine.reload_config("SIGHUP");
    const [event] = engine.db.recent_events(1);
    expect(event.level).toBe("ERROR");
    expect(event.message).toContain("Config reload (SIGHUP) failed, still running the previous config");
  });

  it("reloads nothing before the engine is ready", async () => {
    await start([probe("a")]);
    engine.ready = false;
    expect((await engine.reload_config("test")).error).toBe("X-Monitor is still starting");
  });
});

describe("connections", () => {
  it("closes an SSH connection nobody uses any more", async () => {
    await start([ssh("a", "h1"), ssh("b", "h2"), ssh("c", "h2")]);
    const h1 = engine.exec_contexts.get("a")!.conn as SSHConnection;
    const h2 = engine.exec_contexts.get("b")!.conn as SSHConnection;
    const closed = [vi.spyOn(h1, "close"), vi.spyOn(h2, "close")];
    await reload([ssh("b", "h2")]);
    expect(closed[0]).toHaveBeenCalledOnce();
    expect(closed[1]).not.toHaveBeenCalled();
    expect(engine.exec_contexts.get("b")!.conn).toBe(h2);
  });

  it("reuses the connection for a changed monitor on the same host", async () => {
    await start([ssh("a", "h1")]);
    const conn = engine.exec_contexts.get("a")!.conn as SSHConnection;
    const closed = vi.spyOn(conn, "close");
    await reload([ssh("a", "h1", { interval: 5 })]);
    expect(engine.exec_contexts.get("a")!.conn).toBe(conn);
    expect(closed).not.toHaveBeenCalled();
  });

  it("makes agent streams follow the monitors", async () => {
    const agents = [{ id: "node" }];
    await start([probe("a", { agent: "node", stream: "one" }), probe("b", { agent: "node", stream: "b" })], { agents });
    const conn = engine.connectors.agents.get("node") as AgentConnection;
    const sent: unknown[] = [];
    conn.push_subscriptions = async () => void sent.push(conn.streams.map((spec) => [spec.id, spec.params.unit]).sort());
    await reload([probe("a", { agent: "node", stream: "two" })], { agents });
    expect(sent).toEqual([[], [["a:watch", "two"]]]);
    expect([...engine.event_targets.keys()]).toEqual(["a:watch"]);
    expect(engine.event_targets.get("a:watch")).toBe(monitor("a"));
  });

  it("keeps an agent's connection and drops a removed agent's key", async () => {
    const [first, second, old] = [new_agent_key(), new_agent_key(), new_agent_key()].map((key) => key.public_line);
    await start([probe("a", { agent: "node" })], { agents: [{ id: "node", public_key: first }, { id: "old", public_key: old }] });
    const conn = engine.connectors.agents.get("node");
    await reload([probe("a", { agent: "node" })], { agents: [{ id: "node", public_key: second }] });
    expect(engine.connectors.agents.get("node")).toBe(conn);
    expect(engine.exec_contexts.get("a")!.conn).toBe(conn);
    expect(engine.connectors.agents.public_key_for("node")).toBe(second.trim());
    expect(engine.connectors.agents.public_key_for("old")).toBeNull();
  });
});

describe("global settings", () => {
  it("restarts notifications for a changed tree or section", async () => {
    await start([probe("a")]);
    const before = engine.notifications;
    await reload([probe("a")]);
    expect(engine.notifications).toBe(before);
    await reload([probe("a"), probe("b")]);
    expect(engine.notifications).not.toBe(before);
    const again = engine.notifications;
    await reload([probe("a"), probe("b")], { notifications: { base_url: "https://x-monitor.lan" } });
    expect(engine.notifications).not.toBe(again);
  });

  it("restarts exporters when their section changes", async () => {
    await start([probe("a")]);
    const old = engine.exporters;
    const stopped = vi.spyOn(old, "stop");
    await reload([probe("a")], { exporters: { influxdb: { url: "" } } });
    expect(stopped).toHaveBeenCalledOnce();
    expect(engine.exporters).not.toBe(old);
  });

  it("applies retention and log levels", async () => {
    await start([probe("a")]);
    await reload([probe("a")], { logging: { retention_days: 3, level: "ERROR" } });
    expect(engine.log_retention_days).toBe(3);
    expect(root_log_level()).toBe("ERROR");
  });

  it("reports the settings that need a restart", async () => {
    await start([probe("a")]);
    const result = await reload([probe("a")], { memory: { metric_history: 10 }, theme: { scheme: "dark" }, auth: { username: "u", password: "p" } });
    expect(result.ok).toBe(true);
    expect(result.restart_required).toEqual(["memory", "auth", "theme"]);
    expect(result.summary()).toContain("restart required for: memory, auth, theme");
  });

  it("picks up an edited folder plugin", async () => {
    harness = await start_engine({ plugin_paths: ["plugins"], plugins: [] });
    engine = harness.engine;
    write_folder_plugin(join(harness.folder, "plugins"), "extra", { extra: "class Extra extends Plugin { static MARK = 2; }" });
    await reload([{ name: "e", id: "e", type: "extra" }], { plugin_paths: ["plugins"] });
    expect((monitor("e").constructor as unknown as { MARK: number }).MARK).toBe(2);
  });

  it("ignores the database path when it was overridden", () => {
    expect(restart_required({ database: { path: "a" } }, { database: { path: "b" } }, true)).toEqual([]);
    expect(restart_required({ database: { path: "a" } }, { database: { path: "b" } })).toEqual(["database.path"]);
  });
});

describe("reporting", () => {
  it("records a summary event", async () => {
    await start([probe("a"), probe("b")]);
    await reload([probe("a", { interval: 5 }), probe("c")]);
    const [event] = engine.db.recent_events(1);
    expect(event.level).toBe("INFO");
    expect(event.message).toContain("Config reloaded (test): 1 added, 1 removed, 1 changed");
  });

  it("tells the page when the monitors changed", async () => {
    await start([probe("a")]);
    const seen: string[] = [];
    const unsubscribe = CHANGES.subscribe((kind) => seen.push(kind));
    try {
      const version = engine.monitors_version;
      await reload([probe("a")]);
      expect(engine.monitors_version).toBe(version);
      expect(seen).not.toContain(changes.MONITORS);
      await reload([probe("a"), probe("b")]);
      expect(engine.monitors_version).toBe(version + 1);
      expect(seen).toContain(changes.MONITORS);
    } finally {
      unsubscribe();
    }
  });

  it("runs reloads one at a time", async () => {
    await start([probe("a")]);
    harness!.write({ plugins: [probe("a"), probe("b")] });
    const results = await Promise.all([engine.reload_config("one"), engine.reload_config("two")]);
    expect(results.map((result) => result.added)).toEqual([["b"], []]);
  });

  it("describes itself as the REST API answers", () => {
    const result = new ReloadResult("REST API");
    result.added = ["b"];
    expect(result.as_dict()).toMatchObject({ ok: true, added: ["b"], summary: "Config reloaded (REST API): 1 added, 0 removed, 0 changed" });
  });
});

describe("what starts a reload", () => {
  it("reloads a changed file", async () => {
    await start([probe("a")]);
    engine.config_poll_seconds = 0.02;
    engine.spawn((signal) => engine["watch_config"](signal));
    harness!.write({ plugins: [probe("a"), probe("b")] });
    expect(await wait_for(() => engine.monitor_tasks.has("b"))).toBe(true);
  });

  it("reloads a re-pointed symlink", async () => {
    await start([probe("a")]);
    const one = join(harness!.folder, "one.yaml");
    renameSync(harness!.path, one);
    symlinkSync(one, harness!.path);
    engine.config_poll_seconds = 0.02;
    engine.spawn((signal) => engine["watch_config"](signal));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const two = join(harness!.folder, "two.yaml");
    writeFileSync(two, stringify({ ...(JSON.parse(JSON.stringify(engine.config)) as object), plugins: [probe("a"), probe("b")] }));
    unlinkSync(harness!.path);
    symlinkSync(two, harness!.path);
    expect(await wait_for(() => engine.monitor_tasks.has("b"))).toBe(true);

  });

  it("reloads nothing for a touch without an edit", async () => {
    await start([probe("a")]);
    let reloads = 0;
    engine.reload_config = async (source = "api") => {
      reloads++;
      return new ReloadResult(source);
    };
    engine.config_poll_seconds = 0.02;
    engine.spawn((signal) => engine["watch_config"](signal));
    utimesSync(harness!.path, new Date(1000), new Date(1000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reloads).toBe(0);
  });

  it("reloads on SIGHUP", async () => {
    await start([probe("a")]);
    engine.install_signal_handlers();
    harness!.write({ plugins: [probe("a"), probe("b")] });
    process.emit("SIGHUP", "SIGHUP");
    expect(await wait_for(() => engine.monitor_tasks.has("b"))).toBe(true);
  });
});
