import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Load } from "../../src/monitors/load.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-load", id: "test-load", ssh_config: { host: "test.host" } };

function loadavg(one: number, { five = 0.5, fifteen = 0.5, cpus = 4 } = {}): string {
  return `LOAD:${one} ${five} ${fifteen} 1/500 12345\nCPUS:${cpus}\n`;
}

const load = (extra: PluginConfig = {}): Load => make_plugin(Load, { ...config, ...extra });
const latest_status = (plugin: Load) => store_of(plugin).latest_status("test-load");
const latest_metric = (plugin: Load, name: string) => store_of(plugin).latest_metric("test-load", name)?.value ?? null;

describe("collection", () => {
  it("scales load by core count", () => {
    const plugin = load();
    run_cycle(plugin, () => cmd_result(0, loadavg(1.0, { cpus: 4 }), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "load_pct_1m")).toBeCloseTo(25.0);
  });

  it("stays online at any load without thresholds", () => {
    const plugin = load();
    run_cycle(plugin, () => cmd_result(0, loadavg(16.0, { cpus: 4 }), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "load_pct_1m")).toBeCloseTo(400.0);
  });

  it("takes configurable thresholds", () => {
    const plugin = load({ warning: 100, threshold: 200 });
    run_cycle(plugin, () => cmd_result(0, loadavg(12.0, { cpus: 4 }), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a failed command unavailable", () => {
    const plugin = load();
    run_cycle(plugin, () => cmd_result(1, "", "boom"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls unparseable output unavailable", () => {
    const plugin = load();
    run_cycle(plugin, () => cmd_result(0, "LOAD:garbage\nCPUS:4\n", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("page", () => {
  it("draws the 1m load as a gauge banded by the thresholds", () => {
    const cards = load({ warning: 70, threshold: 90 }).UI_SPEC.cards!;
    expect(Object.keys(cards)).toEqual(["load_1m_card"]);
    expect(cards.load_1m_card.kind).toBe("gauge");
    expect(cards.load_1m_card.color).toEqual({ warning: 70, threshold: 90 });
  });

  it("draws all three averages as lines on one chart", () => {
    const chart = load().UI_SPEC.charts!.load_chart;
    expect(chart.style).toBe("lines");
    expect(chart.series!.map((series) => series.metric)).toEqual(["load_pct_1m", "load_pct_5m", "load_pct_15m"]);
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = load({ warning: 200 });
    run_cycle(plugin, () => cmd_result(0, loadavg(400.0, { cpus: 4 }), ""));
    expect(latest_status(plugin)).toBe("warning");
    expect(plugin.UI_SPEC.cards!.load_1m_card.color).toEqual({ warning: 200, threshold: null });
  });

  it("never warns with a failure only", () => {
    const plugin = load({ threshold: 300 });
    run_cycle(plugin, () => cmd_result(0, loadavg(11.0, { cpus: 4 }), ""));
    expect(latest_status(plugin)).toBe("online");
    run_cycle(plugin, () => cmd_result(0, loadavg(12.0, { cpus: 4 }), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("draws the gauge without bands when no limit is set", () => {
    expect("color" in load().UI_SPEC.cards!.load_1m_card).toBe(false);
  });
});
