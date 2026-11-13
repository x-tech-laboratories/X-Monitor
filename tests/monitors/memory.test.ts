import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Memory } from "../../src/monitors/memory.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-memory", id: "test-memory", ssh_config: { host: "test.host" } };
const mem_total_kb = 16_000_000;

const meminfo = (avail_kb: number): string => `MemTotal:       ${mem_total_kb} kB\nMemAvailable:   ${avail_kb} kB\n`;
const memory = (extra: PluginConfig = {}): Memory => make_plugin(Memory, { ...config, ...extra });
const latest_status = (plugin: Memory) => store_of(plugin).latest_status("test-memory");
const latest_metric = (plugin: Memory, name: string) => store_of(plugin).latest_metric("test-memory", name)?.value ?? null;

describe("collection", () => {
  it("counts the share that is unavailable as used", () => {
    const plugin = memory();
    run_cycle(plugin, () => cmd_result(0, meminfo(8_000_000), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "memory_pct")).toBeCloseTo(50.0);
  });

  it("takes configurable thresholds", () => {
    const plugin = memory({ warning: 40, threshold: 90 });
    run_cycle(plugin, () => cmd_result(0, meminfo(8_000_000), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails exhausted memory", () => {
    const plugin = memory();
    run_cycle(plugin, () => cmd_result(0, meminfo(400_000), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a failed command unavailable", () => {
    const plugin = memory();
    run_cycle(plugin, () => cmd_result(1, "", "boom"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls incomplete output unavailable", () => {
    const plugin = memory();
    run_cycle(plugin, () => cmd_result(0, "MemTotal:  100 kB\n", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("page", () => {
  it("draws the percent card as a gauge banded by the thresholds", () => {
    const card = memory({ warning: 60, threshold: 85 }).UI_SPEC.cards!.mem_pct_card;
    expect(card.kind).toBe("gauge");
    expect(card.metric).toBe("memory_pct");
    expect(card.color).toEqual({ warning: 60, threshold: 85 });
  });

  it("puts the used card beside the gauge", () => {
    expect(memory().UI_SPEC.layout![0]).toEqual(["host_card", "mem_pct_card", "mem_used_card"]);
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = memory({ warning: 75, threshold: null });
    run_cycle(plugin, () => cmd_result(0, meminfo(0), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = memory({ warning: null, threshold: 90 });
    run_cycle(plugin, () => cmd_result(0, meminfo(2_400_000), ""));
    expect(latest_status(plugin)).toBe("online");
    run_cycle(plugin, () => cmd_result(0, meminfo(400_000), ""));
    expect(latest_status(plugin)).toBe("failed");
  });
});
