import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { parse_wireless, strongest_interface, Wifi } from "../../src/monitors/wifi.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-wifi", id: "test-wifi", ssh_config: { host: "test.host" } };
const wireless_header =
  "Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n" +
  " face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n";

function make_wireless(interfaces: Record<string, [number, number]>): string {
  return wireless_header + Object.entries(interfaces).map(([name, [link, level]]) => ` ${name}: 0000   ${link}.  ${level}.  -256        0      0      0      0      0        0\n`).join("");
}

const wifi = (extra: PluginConfig = {}): Wifi => make_plugin(Wifi, { ...config, ...extra });
const latest_status = (plugin: Wifi) => store_of(plugin).latest_status("test-wifi");
const latest_metric = (plugin: Wifi, name: string) => store_of(plugin).latest_metric("test-wifi", name)?.value ?? null;

describe("parse wireless", () => {
  it("reads link and level", () => {
    expect(parse_wireless(make_wireless({ wlan0: [65, -45] })).get("wlan0")).toEqual([65.0, -45.0]);
  });

  it("skips the header rows", () => {
    const result = parse_wireless(make_wireless({ wlan0: [50, -50] }));
    expect(result.has("Inter")).toBe(false);
    expect(result.has("face")).toBe(false);
  });

  it("picks the strongest link", () => {
    expect(strongest_interface(new Map([["wlan0", [30.0, -70.0]], ["wlan1", [65.0, -45.0]]]))).toBe("wlan1");
  });

  it("picks none when empty", () => {
    expect(strongest_interface(new Map())).toBeNull();
  });
});

describe("collection", () => {
  it("calls a good link online", () => {
    const plugin = wifi();
    run_cycle(plugin, () => cmd_result(0, make_wireless({ wlan0: [65, -45] }), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "link_quality")).toBeCloseTo(65.0);
  });

  it("warns on a weak signal", () => {
    const plugin = wifi();
    run_cycle(plugin, () => cmd_result(0, make_wireless({ wlan0: [30, -75] }), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("detects the strongest interface", () => {
    const plugin = wifi();
    const result = run_cycle(plugin, () => cmd_result(0, make_wireless({ wlan0: [25, -80], wlan1: [68, -40] }), ""));
    expect(result.settings[`network:${plugin.id}:wifi_interface`]).toBe("wlan1");
  });

  it("calls a missing explicit interface unavailable", () => {
    const plugin = wifi({ interface: "wlan0" });
    run_cycle(plugin, () => cmd_result(0, make_wireless({ wlan1: [60, -50] }), ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls no wireless interface unavailable", () => {
    const plugin = wifi();
    run_cycle(plugin, () => cmd_result(0, wireless_header, ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreadable /proc file unavailable", () => {
    const plugin = wifi();
    run_cycle(plugin, () => cmd_result(1, "", "cat: /proc/net/wireless: No such file"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "link_quality")).toBeNull();
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = wifi({ quality_threshold: null });
    run_cycle(plugin, () => cmd_result(0, make_wireless({ wlan0: [0, -95] }), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = wifi({ quality_warning: null });
    run_cycle(plugin, () => cmd_result(0, make_wireless({ wlan0: [30, -75] }), ""));
    expect(latest_status(plugin)).toBe("online");
    run_cycle(plugin, () => cmd_result(0, make_wireless({ wlan0: [20, -85] }), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("colors the gauge by the limits that are on", () => {
    expect(wifi({ quality_warning: null, quality_threshold: null }).quality_color(0.0)).toBe("online");
  });
});

describe("page", () => {
  it("draws link quality as a gauge with the floor coloring", () => {
    const plugin = wifi();
    const card = plugin.UI_SPEC.cards!.quality_card;
    expect(card.kind).toBe("gauge");
    expect(card.max).toBe(70.0);
    expect(card.color).toBe(plugin.quality_color_rule);
  });
});
