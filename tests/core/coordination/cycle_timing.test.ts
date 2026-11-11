import { beforeEach, describe, expect, it } from "vitest";

import { SSHConnection } from "../../../src/core/connectors/ssh_connector.ts";
import { ExecContext } from "../../../src/core/connectors/engine.ts";
import { cmd_result, command, CollectResult, type Command } from "../../../src/core/connectors/types.ts";
import { CycleStats } from "../../../src/core/coordination/cycle_stats.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import { Plugin } from "../../../src/monitors/base/plugin_base.ts";
import { fake_dialer, make_engine } from "./engine_harness.ts";

beforeEach(() => set_log_sink(() => {}));

describe("cycle stats", () => {
  it("has nothing recorded as null", () => {
    expect(new CycleStats().get("cpu")).toBeNull();
  });

  it("gives the last, average and maximum", () => {
    const stats = new CycleStats();
    for (const seconds of [1, 3, 2]) stats.record("cpu", seconds, seconds / 10);
    const timing = stats.get("cpu")!;
    expect(timing.last_seconds).toBe(2);
    expect(timing.avg_seconds).toBeCloseTo(2);
    expect(timing.max_seconds).toBe(3);
    expect(timing.last_wait_seconds).toBeCloseTo(0.2);
    expect(timing.avg_wait_seconds).toBeCloseTo(0.2);
    expect(timing.cycles).toBe(3);
  });

  it("drops the oldest past its window", () => {
    const stats = new CycleStats(2);
    for (const seconds of [10, 1, 1]) stats.record("cpu", seconds);
    expect(stats.get("cpu")!.max_seconds).toBe(1);
  });

  it("forgets a monitor", () => {
    const stats = new CycleStats();
    stats.record("cpu", 1);
    stats.forget("cpu");
    expect(stats.get("cpu")).toBeNull();
  });
});

class TimedProbe extends Plugin {
  with_requests = true;

  override commands(): Command[] {
    return this.with_requests ? [command("true")] : [];
  }

  override parse(): CollectResult {
    return new CollectResult({ status: "online" });
  }
}

function probe(): TimedProbe {
  const plugin = new TimedProbe("probe", { id: "probe" });
  plugin.target = "host";
  return plugin;
}

describe("the engine records cycles", () => {
  it("times a cycle with IO", async () => {
    const { engine } = make_engine();
    engine.connectors.dispatch = async () => [cmd_result(0)];
    await engine.run_cycle(probe());
    const timing = engine.cycle_timing("probe");
    expect(timing?.cycles).toBe(1);
    expect(timing!.last_seconds).toBeGreaterThanOrEqual(0);
  });

  it("does not time a cycle without IO", async () => {
    const { engine } = make_engine();
    const plugin = probe();
    plugin.with_requests = false;
    await engine.run_cycle(plugin);
    expect(engine.cycle_timing("probe")).toBeNull();
  });

  it("keeps timing when the timing metrics are off", async () => {
    const { engine } = make_engine();
    engine.cycle_timings = false;
    engine.connectors.dispatch = async () => [cmd_result(0)];
    await engine.run_cycle(probe());
    expect(engine.cycle_timing("probe")).not.toBeNull();
    expect(engine.db.latest_metric("probe", "cycle_collect_seconds")).toBeNull();
  });

  it("records the timing metrics when on", async () => {
    const { engine } = make_engine();
    engine.connectors.dispatch = async () => [cmd_result(0)];
    await engine.run_cycle(probe());
    expect(engine.db.latest_metric("probe", "cycle_collect_seconds")).not.toBeNull();
    expect(engine.db.latest_metric("probe", "cycle_parse_seconds")).not.toBeNull();
  });

  it("carries the channel wait into the timing", async () => {
    const { engine } = make_engine();
    const conn = new SSHConnection("host", { dialer: fake_dialer() });
    conn.channel_semaphore.value = 0;
    engine.exec_contexts.set("probe", new ExecContext(conn, 30));
    setTimeout(() => conn.channel_semaphore.release(), 100);
    await engine.run_cycle(probe());
    expect(engine.cycle_timing("probe")!.last_wait_seconds).toBeGreaterThanOrEqual(0.09);
  });
});
