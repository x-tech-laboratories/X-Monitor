import { beforeEach, describe, expect, it } from "vitest";

import type { EngineLike } from "../../src/core/contracts.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { format_uptime, read_cpu_seconds, read_rss_mb, XMonitorSelfPlugin, type CycleRow, type CycleTiming } from "../../src/monitors/x_monitor_self.ts";
import { DatabaseManager } from "../../src/core/database/database.ts";
import { make_plugin, run_io_cycle as harness_io_cycle } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-self",
  id: "test-self",
  memory_warning: 256,
  memory_threshold: 512,
  stale_warning: 3,
  stale_threshold: 10,
};

interface FakeMonitor {
  id: string;
  name: string;
  interval: number;
  children: FakeMonitor[];
}

// The store each test's monitors share, read by the helpers below and written by each cycle.
let db = new DatabaseManager();

beforeEach(() => {
  db = new DatabaseManager();
});

function fake_engine(plugins: unknown[], last_collected: Record<string, number> = {}, timings: Record<string, CycleTiming> = {}): EngineLike {
  return {
    db,
    plugins,
    last_collected: (plugin_id: string) => last_collected[plugin_id] ?? 0.0,
    cycle_timing: (plugin_id: string) => timings[plugin_id] ?? null,
  } as unknown as EngineLike;
}

function timing(avg: number, options: { last?: number; peak?: number; wait?: number } = {}): CycleTiming {
  const wait = options.wait ?? 0.0;
  return { last_seconds: options.last ?? avg, avg_seconds: avg, max_seconds: options.peak ?? avg, last_wait_seconds: wait, avg_wait_seconds: wait, cycles: 3 };
}

function fake_monitor(monitor_id: string, interval: number, children: FakeMonitor[] = []): FakeMonitor {
  return { id: monitor_id, name: monitor_id, interval, children };
}

function self_monitor(extra: PluginConfig = {}): XMonitorSelfPlugin {
  const plugin = make_plugin(XMonitorSelfPlugin, { ...base_config, ...extra }, db);
  plugin.engine = fake_engine([]);
  return plugin;
}

const monotonic = () => performance.now() / 1000;
const latest_status = (_plugin: XMonitorSelfPlugin) => db.store.statuses.get("test-self")?.state ?? null;
const latest_metric = (_plugin: XMonitorSelfPlugin, name: string) => db.latest_metric("test-self", name)?.value ?? null;

// Runs one cycle and writes it to the shared store, which works with no engine wired too.
async function run_io_cycle(plugin: XMonitorSelfPlugin) {
  if (plugin.engine !== null) return harness_io_cycle(plugin);
  const result = plugin.parse_results([(await plugin.io_call()()) as never]);
  db.apply_result(plugin.target, plugin.id, plugin.name, result);
  return result;
}
const snapshot = (plugin: XMonitorSelfPlugin) => plugin.data.latest_snapshot<CycleRow[]>()!;

describe("format uptime", () => {
  it("writes minutes only", () => {
    expect(format_uptime(300)).toBe("5m");
  });

  it("writes hours and minutes", () => {
    expect(format_uptime(3900)).toBe("1h 5m");
  });

  it("writes days and hours", () => {
    expect(format_uptime(280800)).toBe("3d 6h");
  });
});

describe("proc readers", () => {
  it("reads a positive rss", () => {
    expect(read_rss_mb()!).toBeGreaterThan(0);
  });

  it("reads non-negative cpu seconds", () => {
    expect(read_cpu_seconds()!).toBeGreaterThanOrEqual(0);
  });

  it("reads no rss when proc is unreadable", () => {
    expect(read_rss_mb("/nonexistent/status")).toBeNull();
  });

  it("reads no cpu when proc is unreadable", () => {
    expect(read_cpu_seconds("/nonexistent/stat")).toBeNull();
  });
});

describe("self collection", () => {
  it("calls a healthy process online", async () => {
    const plugin = self_monitor();
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("online");
  });

  it("records the uptime", async () => {
    const plugin = self_monitor();
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "uptime_seconds")).not.toBeNull();
  });

  it("records the memory", async () => {
    const plugin = self_monitor();
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "memory_mb")!).toBeGreaterThan(0);
  });

  it("calls a sample that throws unavailable", async () => {
    const plugin = self_monitor();
    plugin.read_rss_mb = () => {
      throw new Error("boom");
    };
    const result = await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "uptime_seconds")).toBeNull();
    expect(result.logs[0][0]).toBe("Self sample could not be taken: Error: boom");
  });

  it("fails memory above the threshold", async () => {
    const plugin = self_monitor();
    plugin.read_rss_mb = () => 600.0;
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("warns on memory above the warning", async () => {
    const plugin = self_monitor();
    plugin.read_rss_mb = () => 300.0;
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("does not fail on unreadable memory", async () => {
    const plugin = self_monitor();
    plugin.read_rss_mb = () => null;
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("online");
  });

  it("records no cpu on the first collection", async () => {
    const plugin = self_monitor();
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "cpu_pct")).toBeNull();
  });

  it("records cpu on the second collection", async () => {
    const plugin = self_monitor();
    await run_io_cycle(plugin);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "cpu_pct")).not.toBeNull();
  });
});

describe("collection health", () => {
  it("counts only leaf monitors", async () => {
    const plugin = self_monitor();
    const now = monotonic();
    const leaf = fake_monitor("leaf", 60);
    plugin.engine = fake_engine([fake_monitor("group", 60, [leaf])], { leaf: now, group: now });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_total")).toBe(1.0);
  });

  it("calls fresh monitors not late", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("fresh", 60)], { fresh: monotonic() });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_late")).toBe(0.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("warns on a late monitor", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("late", 60)], { late: monotonic() - 60 * 4 });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_late")).toBe(1.0);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails on a stalled monitor", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("stalled", 60)], { stalled: monotonic() - 60 * 12 });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_stalled")).toBe(1.0);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("keeps the default late bound past the quiet window", async () => {
    const { stale_warning: _stale_warning, ...rest } = base_config;
    const plugin = make_plugin(XMonitorSelfPlugin, rest, db);
    plugin.engine = fake_engine([fake_monitor("quiet", 60)], { quiet: monotonic() - 60 * plugin.SAMPLE_MAX_QUIET_INTERVALS });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_late")).toBe(0.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("never calls a monitor not yet collected stalled", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("new", 3600)], { new: 0.0 });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_stalled")).toBe(0.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("judges staleness against each interval", async () => {
    const plugin = self_monitor();
    const ten_minutes_ago = monotonic() - 600;
    plugin.engine = fake_engine([fake_monitor("hourly", 3600), fake_monitor("frequent", 30)], { hourly: ten_minutes_ago, frequent: ten_minutes_ago });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_total")).toBe(2.0);
    expect(latest_metric(plugin, "monitors_stalled")).toBe(1.0);
  });

  it("ranks stalled above healthy memory", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("stalled", 60)], { stalled: monotonic() - 60 * 12 });
    plugin.read_rss_mb = () => 10.0;
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("reports zero monitors without an engine", async () => {
    const plugin = self_monitor();
    plugin.engine = null;
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_total")).toBe(0.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("leaves itself out of the count", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([plugin]);
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_total")).toBe(0.0);
  });

  it("names the worst offenders in the log", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("stalled", 60)], { stalled: monotonic() - 60 * 12 });
    const result = await run_io_cycle(plugin);
    expect(result.logs[0][0]).toContain("0 late, 1 stalled | worst: stalled (12x)");
  });
});

describe("cycle timings", () => {
  it("sorts rows slowest first", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("fast", 60), fake_monitor("slow", 60)], {}, { fast: timing(0.2), slow: timing(4.0) });
    await run_io_cycle(plugin);
    expect(snapshot(plugin).map((row) => row.id)).toEqual(["slow", "fast"]);
  });

  it("carries last, avg, max, wait and share on a row", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("host-cpu", 20)], {}, { "host-cpu": timing(2.0, { last: 1.0, peak: 5.0, wait: 0.5 }) });
    await run_io_cycle(plugin);
    const row = snapshot(plugin)[0];
    expect([row.last, row.avg, row.max, row.wait]).toEqual([1.0, 2.0, 5.0, 0.5]);
    expect(row.share).toBe(10.0);
    expect(row.slow).toBe(false);
  });

  it("leaves out a monitor without a timed cycle", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("pushed", 60)]);
    await run_io_cycle(plugin);
    expect(snapshot(plugin)).toEqual([]);
    expect(latest_metric(plugin, "slowest_cycle_seconds")).toBeNull();
  });

  it("leaves out groups", async () => {
    const plugin = self_monitor();
    const leaf = fake_monitor("leaf", 60);
    plugin.engine = fake_engine([fake_monitor("group", 60, [leaf])], {}, { leaf: timing(1.0), group: timing(1.0) });
    await run_io_cycle(plugin);
    expect(snapshot(plugin).map((row) => row.id)).toEqual(["leaf"]);
  });

  it("calls a cycle past half the interval slow", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("crawl", 10)], {}, { crawl: timing(6.0) });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_slow")).toBe(1.0);
    expect(latest_metric(plugin, "slowest_cycle_seconds")).toBe(6.0);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("takes a configured slow fraction", async () => {
    const plugin = self_monitor({ slow_cycle_fraction: 0.9 });
    plugin.engine = fake_engine([fake_monitor("crawl", 10)], {}, { crawl: timing(6.0) });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_slow")).toBe(0.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("flags a long cycle on a long interval by slow seconds", async () => {
    const plugin = self_monitor({ slow_cycle_seconds: 5 });
    plugin.engine = fake_engine([fake_monitor("hourly", 3600)], {}, { hourly: timing(8.0) });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_slow")).toBe(1.0);
    expect(snapshot(plugin)[0].slow).toBe(true);
  });

  it("keeps slow seconds off by default", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("hourly", 3600)], {}, { hourly: timing(60.0) });
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_slow")).toBe(0.0);
  });

  it("names a slow monitor in the log", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("crawl", 10)], {}, { crawl: timing(6.0) });
    const result = await run_io_cycle(plugin);
    expect(result.logs[0][0]).toContain("slow: crawl (6.0s of 10s)");
  });

  it("ranks stalled above slow", async () => {
    const plugin = self_monitor();
    plugin.engine = fake_engine([fake_monitor("both", 60)], { both: monotonic() - 60 * 12 }, { both: timing(50.0) });
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("colors a slow row warning", () => {
    expect(XMonitorSelfPlugin.slow_row_color({ slow: true })).toBe("warning");
    expect(XMonitorSelfPlugin.slow_row_color({ slow: false })).toBeNull();
  });

  it("lays out the timings table", () => {
    const spec = self_monitor().UI_SPEC;
    expect(spec.layout).toContainEqual(["timings"]);
    expect(spec.tables!.timings.columns!.map((column) => column.field)).toEqual(["name", "interval", "last", "avg", "max", "wait", "share"]);
  });
});

describe("cards", () => {
  it("writes the monitors card from its counts", () => {
    expect(XMonitorSelfPlugin.monitors_text({})).toBe("--");
    expect(XMonitorSelfPlugin.monitors_text({ monitors_total: 4, monitors_late: 1, monitors_stalled: 0 })).toBe("4 (1 late)");
    expect(XMonitorSelfPlugin.monitors_text({ monitors_total: 4, monitors_late: 1, monitors_stalled: 2 })).toBe("4 (2 stalled)");
    expect(XMonitorSelfPlugin.monitors_text({ monitors_total: 4 })).toBe("4 OK");
    expect(XMonitorSelfPlugin.monitors_color({ monitors_total: 4, monitors_stalled: 1 })).toBe("failed");
    expect(XMonitorSelfPlugin.monitors_color({ monitors_total: 4, monitors_late: 1 })).toBe("warning");
    expect(XMonitorSelfPlugin.monitors_color({})).toBeNull();
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(self_monitor().plan_action("anything")).toBeNull();
  });
});

describe("optional limits", () => {
  it("never fails with a memory warning only", async () => {
    const plugin = self_monitor({ memory_threshold: null });
    plugin.read_rss_mb = () => 100_000.0;
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a memory failure only", async () => {
    const plugin = self_monitor({ memory_warning: null });
    plugin.read_rss_mb = () => 500.0;
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("online");
    plugin.read_rss_mb = () => 600.0;
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("never stalls with a stale warning only", async () => {
    const plugin = self_monitor({ stale_threshold: null });
    plugin.engine = fake_engine([fake_monitor("old", 60)], { old: monotonic() - 60 * 1000 });
    plugin.read_rss_mb = () => 100.0;
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_stalled")).toBe(0.0);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("is never late with a stale failure only", async () => {
    const plugin = self_monitor({ stale_warning: null });
    plugin.engine = fake_engine([fake_monitor("slow", 60)], { slow: monotonic() - 60 * 9 });
    plugin.read_rss_mb = () => 100.0;
    await run_io_cycle(plugin);
    expect(latest_metric(plugin, "monitors_late")).toBe(0.0);
    expect(latest_status(plugin)).toBe("online");
    plugin.engine = fake_engine([fake_monitor("slow", 60)], { slow: monotonic() - 60 * 12 });
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });
});
