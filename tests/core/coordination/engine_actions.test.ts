import { beforeEach, describe, expect, it } from "vitest";

import { ExecContext } from "../../../src/core/connectors/engine.ts";
import {
  action_plan, cmd_result, CollectResult, dns_result, http_result, ping_result, unreachable, type ActionPlanResult, type CmdResult, type DispatchResult,
} from "../../../src/core/connectors/types.ts";
import type { TransportConnection } from "../../../src/core/contracts.ts";
import { settle_result, type XMonitorEngine } from "../../../src/core/coordination/engine.ts";
import { parse_schedule } from "../../../src/core/coordination/schedule.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import { Plugin } from "../../../src/monitors/base/plugin_base.ts";
import { worst_status } from "../../../src/shared/status.ts";
import { make_engine, Probe, wire } from "./engine_harness.ts";

beforeEach(() => set_log_sink(() => {}));

// A transport that records each command and answers with a fixed result.
class Recorder implements TransportConnection {
  readonly host: string;
  calls: string[] = [];
  answer: [number, string, string] = [0, "ok", ""];

  constructor(host = "test.host") {
    this.host = host;
  }

  async execute(text: string): Promise<[number, string, string]> {
    this.calls.push(text);
    return this.answer;
  }
}

class RemoteProbe extends Probe {
  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    if (action_id === "remote") return action_plan("echo hi", { via: (args.via as string | undefined) ?? null });
    if (action_id === "poke") return new CollectResult({ logs: [[`poked ${JSON.stringify(args)}`, "INFO"]], success: true });
    return super.plan_action(action_id);
  }
}

function engine_with_probe(config: Record<string, unknown> = {}): [XMonitorEngine, RemoteProbe, Recorder] {
  const { engine } = make_engine();
  engine.ready = true;
  const plugin = wire(engine, RemoteProbe, { interval: 3600, ...config });
  const own = new Recorder();
  engine.exec_contexts.set(plugin.id, new ExecContext(own));
  return [engine, plugin, own];
}

function record_dispatch(engine: XMonitorEngine, answer: () => Promise<DispatchResult> = async () => [true, null]): [string, Record<string, unknown>][] {
  const calls: [string, Record<string, unknown>][] = [];
  engine.dispatch_action = async (_plugin, action_id, args = {}) => {
    calls.push([action_id, args]);
    return answer();
  };
  return calls;
}

// ── Via ──────────────────────────────────────────────────────────────────────

describe("running through another monitor", () => {
  it("runs on the named monitor's transport", async () => {
    const [engine, plugin, own] = engine_with_probe();
    const other = new Recorder("host1");
    engine.exec_contexts.set("host1-ssh", new ExecContext(other));
    const [ok] = await engine.dispatch_action(plugin, "remote", { via: "host1-ssh" });
    expect(ok).toBe(true);
    expect(other.calls).toEqual(["echo hi"]);
    expect(own.calls).toEqual([]);
  });

  it("uses its own transport without via", async () => {
    const [engine, plugin, own] = engine_with_probe();
    await engine.dispatch_action(plugin, "remote");
    expect(own.calls).toEqual(["echo hi"]);
  });

  it("fails for an unknown monitor without running anything", async () => {
    const [engine, plugin, own] = engine_with_probe();
    const [ok] = await engine.dispatch_action(plugin, "remote", { via: "nowhere" });
    expect(ok).toBe(false);
    expect(own.calls).toEqual([]);
    expect((plugin.outcomes[0] as CmdResult).stderr).toContain("No monitor 'nowhere'");
  });

  it("answers an unhandled action with failure", async () => {
    const [engine, plugin] = engine_with_probe();
    expect(await engine.dispatch_action(plugin, "unknown")).toEqual([false, null]);
  });

  it("applies a CollectResult plan and returns its metadata", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.plan_action = () => new CollectResult({ metadata: { content: "x" }, success: true, logs: [["did it", "INFO"]] });
    expect(await engine.dispatch_action(plugin, "any")).toEqual([true, { content: "x" }]);
    expect(engine.db.plugin_events(plugin.id).map((event) => event.message)).toContain("[test-plugin] did it");
  });

  it("runs an io action and a connector request plan", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.plan_action = (action_id) => (action_id === "io" ? { kind: "io_action", call: () => cmd_result(0) } : { kind: "ping", host: "h", count: 1, timeout: 1 });
    engine.connectors.icmp = { ping: async () => ping_result(null, 0) };
    plugin.interpret_action = () => true;
    expect(await engine.dispatch_action(plugin, "io")).toEqual([true, null]);
    expect(await engine.dispatch_action(plugin, "ping")).toEqual([true, null]);
  });
});

// ── Custom actions ───────────────────────────────────────────────────────────

describe("custom actions", () => {
  const actions = [{ name: "Clear Cache", command: "rm -rf /tmp/cache" }];

  it("runs the command and logs it", async () => {
    const [engine, plugin, own] = engine_with_probe({ actions });
    let planned = false;
    plugin.plan_action = () => {
      planned = true;
      return null;
    };
    const [success, metadata] = await engine.dispatch_action(plugin, "custom:clear_cache");
    expect(success).toBe(true);
    expect(metadata).toEqual({ content: "ok" });
    expect(own.calls).toEqual(["rm -rf /tmp/cache"]);
    expect(engine.db.plugin_events(plugin.id)[0].message).toBe("[test-plugin] Clear Cache ran: ok");
    expect(planned).toBe(false);
  });

  it("reports a failure", async () => {
    const [engine, plugin, own] = engine_with_probe({ actions });
    own.answer = [1, "", ""];
    expect((await engine.dispatch_action(plugin, "custom:clear_cache"))[0]).toBe(false);
  });

  it("still sends other ids to the plugin", async () => {
    const [engine, plugin, own] = engine_with_probe({ actions });
    expect(await engine.dispatch_action(plugin, "unknown")).toEqual([false, null]);
    expect(own.calls).toEqual([]);
  });
});

// ── Status reactions ─────────────────────────────────────────────────────────

describe("status reactions", () => {
  it("offers each cycle's status", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.status = "failed";
    await engine.run_cycle_now(plugin);
    expect(plugin.seen).toEqual(["failed"]);
  });

  it("runs the action asked for", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.status = "failed";
    plugin.reaction = ["poke", { automatic: true, attempt: 1 }];
    const calls = record_dispatch(engine);
    await engine.run_cycle_now(plugin);
    await engine.settle();
    expect(calls).toEqual([["poke", { automatic: true, attempt: 1 }]]);
  });

  it("runs nothing without a reaction", async () => {
    const [engine, plugin] = engine_with_probe();
    const calls = record_dispatch(engine);
    await engine.run_cycle_now(plugin);
    await engine.settle();
    expect(calls).toEqual([]);
  });

  it("does not offer a cycle without a status", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.status = null;
    await engine.run_cycle_now(plugin);
    expect(plugin.seen).toEqual([]);
  });

  it("keeps a broken on_status from failing the cycle", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.on_status = () => {
      throw new Error("boom");
    };
    expect(await engine.run_cycle_now(plugin)).toBe(true);
  });

  it("contains a failing reaction", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.reaction = ["poke", {}];
    record_dispatch(engine, async () => {
      throw new Error("boom");
    });
    await engine.run_cycle_now(plugin);
    await engine.settle();
  });
});

// ── Triggers ─────────────────────────────────────────────────────────────────

describe("triggered actions", () => {
  const triggers = [{ action: "heal", status: "failed", args: { hard: true } }];

  it("runs the action once while the condition shows", async () => {
    const [engine, plugin] = engine_with_probe({ triggers });
    plugin.status = "failed";
    const calls = record_dispatch(engine);
    await engine.run_cycle_now(plugin);
    await engine.run_cycle_now(plugin);
    await engine.settle();
    expect(calls).toEqual([["heal", { hard: true }]]);
  });

  it("runs again after the condition clears", async () => {
    const [engine, plugin] = engine_with_probe({ triggers });
    const calls = record_dispatch(engine);
    for (const status of ["failed", "online", "failed"]) {
      plugin.status = status;
      await engine.run_cycle_now(plugin);
    }
    await engine.settle();
    expect(calls).toHaveLength(2);
  });

  it("does not repeat the episode after a restart", async () => {
    const [engine, plugin] = engine_with_probe({ triggers });
    plugin.status = "failed";
    const calls = record_dispatch(engine);
    await engine.run_cycle_now(plugin);
    engine.trigger_states.clear();
    await engine.run_cycle_now(plugin);
    await engine.settle();
    expect(calls).toHaveLength(1);
  });

  it("records and logs the outcome", async () => {
    const [engine, plugin] = engine_with_probe({ triggers });
    plugin.status = "failed";
    await engine.run_cycle_now(plugin);
    await engine.settle();
    const record = JSON.parse(engine.db.get_setting(plugin.triggered_actions[0].result_key(plugin.id))!);
    expect(record.ok).toBe(true);
    expect(engine.db.plugin_events(plugin.id, "", "", 10).some((event) => event.message.endsWith("Triggered heal (when status is failed) ran"))).toBe(true);
  });

  it("contains and records a failing action", async () => {
    const [engine, plugin] = engine_with_probe({ triggers });
    plugin.status = "failed";
    record_dispatch(engine, async () => {
      throw new Error("boom");
    });
    await engine.run_cycle_now(plugin);
    await engine.settle();
    const record = JSON.parse(engine.db.get_setting(plugin.triggered_actions[0].result_key(plugin.id))!);
    expect(record.ok).toBe(false);
    expect(record.message).toContain("boom");
  });

  it("stores the state as the Python app wrote it", async () => {
    const [engine, plugin] = engine_with_probe({ triggers });
    plugin.status = "failed";
    engine.time = () => 100;
    record_dispatch(engine);
    await engine.run_cycle_now(plugin);
    expect(engine.db.get_setting(plugin.triggered_actions[0].state_key(plugin.id))).toBe('{"since": 100, "fired": true}');
  });
});

// ── Schedules ────────────────────────────────────────────────────────────────

describe("the schedule loop", () => {
  const at = (...parts: number[]) => new Date(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0).getTime() / 1000;

  function scheduled(cron = "0 3 * * *", args: Record<string, unknown> = {}): [XMonitorEngine, Probe] {
    const [engine, plugin] = engine_with_probe({ id: "borg", schedule: [{ action: "run_backup", cron, args }] });
    return [engine, plugin];
  }

  it("waits for a new schedule's next time", async () => {
    const [engine, plugin] = scheduled();
    const calls = record_dispatch(engine);
    engine.start_due_schedules(at(2026, 10, 21, 4, 0));
    await engine.settle();
    expect(calls).toEqual([]);
    expect(engine.db.get_setting(plugin.scheduled_actions[0].state_key("borg"))).toBe(String(Math.trunc(at(2026, 10, 21, 4, 0))));
  });

  it("runs once its time comes", async () => {
    const [engine, plugin] = scheduled("0 3 * * *", { note: "nightly" });
    const calls = record_dispatch(engine);
    engine.start_due_schedules(at(2026, 10, 21, 2, 0));
    engine.start_due_schedules(at(2026, 10, 21, 2, 59));
    await engine.settle();
    expect(calls).toEqual([]);
    engine.start_due_schedules(at(2026, 10, 21, 3, 0, 10));
    engine.start_due_schedules(at(2026, 10, 21, 3, 0, 40));
    await engine.settle();
    expect(calls).toEqual([["run_backup", { note: "nightly" }]]);
    expect(engine.db.plugin_events(plugin.id)[0].message).toBe("[test-plugin] Scheduled run_backup (0 3 * * *) ran");
  });

  it("collapses missed runs into one", async () => {
    const [engine] = scheduled();
    const calls = record_dispatch(engine);
    engine.start_due_schedules(at(2026, 10, 18, 4, 0));
    // Down for three nights: one run on return, none on the next check.
    engine.start_due_schedules(at(2026, 10, 21, 12, 0));
    engine.start_due_schedules(at(2026, 10, 21, 12, 0, 30));
    await engine.settle();
    expect(calls).toHaveLength(1);
  });

  it("does not start a running action again", async () => {
    const [engine] = scheduled("* * * * *");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = record_dispatch(engine, async () => {
      await gate;
      return [true, null];
    });
    engine.start_due_schedules(at(2026, 10, 21, 3, 0));
    engine.start_due_schedules(at(2026, 10, 21, 3, 1));
    engine.start_due_schedules(at(2026, 10, 21, 3, 2));
    expect(calls).toHaveLength(1);
    release();
    await engine.settle();
  });

  it("logs a failure on the monitor and records it", async () => {
    const [engine, plugin] = scheduled();
    record_dispatch(engine, async () => {
      throw new Error("agent gone");
    });
    engine.start_due_schedules(at(2026, 10, 21, 2, 0));
    engine.start_due_schedules(at(2026, 10, 21, 3, 0));
    await engine.settle();
    expect(engine.db.plugin_events(plugin.id)[0]).toMatchObject({ level: "ERROR", message: "[test-plugin] Scheduled run_backup (0 3 * * *) failed: agent gone" });
    expect(engine.scheduled_running.size).toBe(0);
    const record = JSON.parse(engine.db.get_setting(parse_schedule([{ action: "run_backup", cron: "0 3 * * *" }])[0].result_key("borg"))!);
    expect(record.ok).toBe(false);
    expect(record.message).toContain("agent gone");
  });

  it("records when a run started and how it went", async () => {
    const [engine] = scheduled();
    record_dispatch(engine);
    engine.start_due_schedules(at(2026, 10, 21, 2, 0));
    engine.start_due_schedules(at(2026, 10, 21, 3, 0));
    await engine.settle();
    const record = JSON.parse(engine.db.get_setting(parse_schedule([{ action: "run_backup", cron: "0 3 * * *" }])[0].result_key("borg"))!);
    expect(record).toMatchObject({ ok: true, message: "Scheduled run_backup (0 3 * * *) ran" });
  });
});

// ── Poll guard ───────────────────────────────────────────────────────────────

describe("the poll guard", () => {
  it("collects on the first tick and again on the next", async () => {
    const [engine, plugin] = engine_with_probe();
    expect(await engine.run_cycle_now(plugin)).toBe(true);
    await engine.run_cycle_now(plugin);
    expect(plugin.collections).toBe(2);
    expect(engine.collecting.get(plugin.id)).toBe(false);
  });

  it("skips a tick while a cycle runs", async () => {
    const [engine, plugin] = engine_with_probe();
    engine.collecting.set(plugin.id, true);
    expect(await engine.run_cycle_now(plugin)).toBe(false);
    expect(plugin.collections).toBe(0);
  });

  it("skips an overlapping poll", async () => {
    const [engine, plugin] = engine_with_probe();
    let release!: () => void;
    plugin.io_call = () => () => new Promise((resolve) => {
      release = () => resolve(cmd_result(0));
    });
    const first = engine.run_cycle_now(plugin);
    expect(await engine.run_cycle_now(plugin)).toBe(false);
    release();
    await first;
    expect(plugin.collections).toBe(1);
  });

  it("releases the guard after an exception", async () => {
    const [engine, plugin] = engine_with_probe();
    plugin.parse = () => {
      throw new Error("boom");
    };
    await expect(engine.run_cycle_now(plugin)).rejects.toThrow("boom");
    expect(engine.collecting.get(plugin.id)).toBe(false);
  });

  it("reads the timeout from config", () => {
    const [, plugin] = engine_with_probe();
    expect(plugin.timeout).toBe(30);
    expect(engine_with_probe({ timeout: "3m" })[1].timeout).toBe(180);
    expect(engine_with_probe({ timeout: 45 })[1].timeout).toBe(45);
  });
});

// ── Unavailable status ───────────────────────────────────────────────────────

describe("unavailable status", () => {
  const monitor = (availability = false) => ({ AVAILABILITY: availability }) as Plugin;

  it("ranks unavailable between online and warning and info below it", () => {
    expect(worst_status(["online", "unavailable"])).toBe("unavailable");
    expect(worst_status(["unavailable", "warning"])).toBe("warning");
    expect(worst_status(["online", "info"])).toBe("info");
    expect(worst_status(["info", "unavailable"])).toBe("unavailable");
    expect(worst_status(["online", "offline"])).toBe("unavailable");
    expect(worst_status(["online", "bogus"])).toBe("unavailable");
  });

  it("carries the status on an unavailable result", () => {
    const result = CollectResult.unavailable("no answer");
    expect(result.status).toBe("unavailable");
    expect(result.logs).toEqual([["no answer", "WARNING"]]);
  });

  it("knows each transport's failure shape", () => {
    expect(unreachable(cmd_result(-1, "", "Agent 'x' is not connected"))).toBe(true);
    expect(unreachable(http_result(null, "", { error: "refused" }))).toBe(true);
    expect(unreachable(dns_result("timeout"))).toBe(true);
    expect(unreachable(ping_result("boom", null))).toBe(true);
    expect(unreachable(cmd_result(1, "", "command failed"))).toBe(false);
    expect(unreachable(http_result(503, ""))).toBe(false);
    expect(unreachable(dns_result("nxdomain"))).toBe(false);
    expect(unreachable(ping_result(null, 1))).toBe(false);
    expect(unreachable("an io_call value")).toBe(false);
  });

  it("makes a cycle that never reached its host unavailable", () => {
    const result = settle_result(monitor(), [cmd_result(-1, "", "not connected")], CollectResult.failed("x"));
    expect(result.status).toBe("unavailable");
    expect(result.logs).toEqual([["x", "ERROR"]]);
  });

  it("keeps the verdict of a partly reached cycle", () => {
    expect(settle_result(monitor(), [cmd_result(-1), cmd_result(0, "ok")], CollectResult.failed("x")).status).toBe("failed");
  });

  it("keeps an availability monitor's failure", () => {
    expect(settle_result(monitor(true), [ping_result("boom", null)], CollectResult.failed("x")).status).toBe("failed");
  });

  it("settles nothing without requests", () => {
    expect(settle_result(monitor(), [], CollectResult.failed("x")).status).toBe("failed");
  });
});

// ── Children ─────────────────────────────────────────────────────────────────

describe("child monitors", () => {
  class Parent extends Plugin {}

  it("polls a monitor's children before itself", async () => {
    const [engine] = engine_with_probe();
    const order: string[] = [];
    const parent = wire(engine, Parent, { id: "parent" });
    const child = (id: string) => Object.assign(new Parent(id, { id }), { run_cycle: async () => { order.push(id); return true; } });
    parent.children = [child("a"), child("b")];
    engine.run_cycle_now = async () => {
      order.push("parent");
      return true;
    };
    expect(await parent.run_cycle()).toBe(true);
    expect(order.at(-1)).toBe("parent");
    expect(order.slice(0, -1).sort()).toEqual(["a", "b"]);
  });

  it("maps each child to its latest status", () => {
    const [engine] = engine_with_probe();
    const parent = wire(engine, Parent, { id: "parent" });
    engine.db.insert_status("a", "failed");
    parent.children = [new Parent("a", { id: "a" }), new Parent("never-polled", { id: "never-polled" })];
    expect(parent.child_statuses()).toEqual({ a: "failed", "never-polled": "unavailable" });
    expect(parent.restates_children).toBe(false);
  });
});
