import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Temperature } from "../../src/monitors/temperature.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-temperature", id: "test-temperature", ssh_config: { host: "test.host" } };

const sensors = (...temps_mc: number[]): string => temps_mc.map((temp, index) => `SENSOR:x86_pkg_temp_${index}:${temp}\n`).join("");
const temperature = (extra: PluginConfig = {}): Temperature => make_plugin(Temperature, { ...config, ...extra });
const latest_status = (plugin: Temperature) => store_of(plugin).latest_status("test-temperature");
const latest_metric = (plugin: Temperature, name: string) => store_of(plugin).latest_metric("test-temperature", name)?.value ?? null;

describe("collection", () => {
  it("takes the hottest zone as the status and keeps every zone", () => {
    const plugin = temperature();
    run_cycle(plugin, () => cmd_result(0, sensors(42_000, 55_000), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "temp_c")).toBeCloseTo(55.0);
    expect(latest_metric(plugin, "temp_zone_x86_pkg_temp_1")).toBeCloseTo(55.0);
  });

  it("takes configurable thresholds", () => {
    const plugin = temperature({ warning: 50, threshold: 60 });
    run_cycle(plugin, () => cmd_result(0, sensors(52_000), ""));
    expect(latest_status(plugin)).toBe("warning");
    run_cycle(plugin, () => cmd_result(0, sensors(65_000), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("keeps a host with no zones online", () => {
    const plugin = temperature();
    run_cycle(plugin, () => cmd_result(0, sensors(), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "temp_c")).toBeNull();
  });

  it("calls a failed read unavailable", () => {
    const plugin = temperature();
    run_cycle(plugin, () => cmd_result(1, "", "permission denied"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "temp_c")).toBeNull();
  });
});

describe("page", () => {
  it("gives the zone cards their own row", () => {
    expect(temperature().UI_SPEC.layout).toContainEqual(["sensors"]);
  });

  it("draws the max temperature as a gauge banded by the thresholds", () => {
    const card = temperature().UI_SPEC.cards!.temp_card;
    expect(card.kind).toBe("gauge");
    expect(card.max).toBe(100.0);
    expect(card.color).toEqual({ warning: 70, threshold: 80 });
  });

  it("raises the scale for a threshold above 100", () => {
    expect(temperature({ warning: 100, threshold: 120 }).UI_SPEC.cards!.temp_card.max).toBe(120.0);
  });

  it("draws zones as meters ticked at the warning level", () => {
    const plugin = temperature();
    const zones = plugin.UI_SPEC.cards!.sensors;
    expect(zones.title).toBe("THERMAL ZONES");
    const repeat = zones.repeat!;
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_max).toBe(100.0);
    expect(repeat.bar_marker).toBeCloseTo(70.0);
    expect(repeat.item_color_by).toBe(plugin.item_level);
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = temperature({ warning: 70, threshold: null });
    run_cycle(plugin, () => cmd_result(0, sensors(150_000), ""));
    expect(latest_status(plugin)).toBe("warning");
    expect(plugin.UI_SPEC.cards!.temp_card.max).toBe(100.0);
  });

  it("never warns with a failure only", () => {
    const plugin = temperature({ warning: null, threshold: 80 });
    run_cycle(plugin, () => cmd_result(0, sensors(79_000), ""));
    expect(latest_status(plugin)).toBe("online");
    run_cycle(plugin, () => cmd_result(0, sensors(81_000), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("ticks no meter without a warning", () => {
    expect(temperature({ warning: null }).UI_SPEC.cards!.sensors.repeat!.bar_marker).toBeUndefined();
  });
});
