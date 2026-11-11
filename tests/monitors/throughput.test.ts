import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { busiest_interface, format_rate, parse_net_dev, Throughput } from "../../src/monitors/throughput.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-throughput", id: "test-throughput", ssh_config: { host: "test.host" } };
const net_dev_header =
  "Inter-|   Receive                                                |  Transmit\n" +
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n";

type Interfaces = Record<string, [number, number]>;
const make_net_dev = (interfaces: Interfaces): string =>
  net_dev_header + Object.entries(interfaces).map(([name, [rx, tx]]) => `  ${name}: ${rx} 100 0 0 0 0 0 0 ${tx} 50 0 0 0 0 0 0\n`).join("");
const two_snapshots = (first: Interfaces, second: Interfaces): string => make_net_dev(first) + make_net_dev(second);
const default_snapshots = (): string => two_snapshots({ lo: [0, 0], eth0: [1_000_000, 500_000] }, { lo: [0, 0], eth0: [1_001_024, 500_512] });

const throughput = (extra: PluginConfig = {}): Throughput => make_plugin(Throughput, { ...config, ...extra });
const latest_status = (plugin: Throughput) => store_of(plugin).latest_status("test-throughput");
const latest_metric = (plugin: Throughput, name: string) => store_of(plugin).latest_metric("test-throughput", name)?.value ?? null;

describe("parse net dev", () => {
  it("reads rx and tx", () => expect(parse_net_dev(make_net_dev({ eth0: [1024, 512] })).get("eth0")).toEqual([1024, 512]));

  it("skips the header lines", () => {
    const result = parse_net_dev(make_net_dev({ eth0: [0, 0] }));
    expect(result.has("Inter")).toBe(false);
    expect(result.has("face")).toBe(false);
  });

  it("picks the interface with the most traffic", () => {
    expect(busiest_interface(new Map([["eth0", [1_000_000, 500_000]], ["wlan0", [100, 50]]]))).toBe("eth0");
  });

  it("leaves out virtual interfaces", () => {
    const stats = new Map<string, [number, number]>(["lo", "veth0", "docker0", "virbr0", "br-abc", "tun0", "tap0"].map((name) => [name, [9_999_999, 0]]));
    stats.set("eth0", [1000, 500]);
    expect(busiest_interface(stats)).toBe("eth0");
  });

  it("picks none without candidates", () => {
    expect(busiest_interface(new Map([["lo", [100, 100]], ["veth0", [200, 200]]]))).toBeNull();
  });
});

describe("format rate", () => {
  it("shows KB/s below 1024", () => expect(format_rate(512.0)).toBe("512.0 KB/s"));
  it("shows MB/s at 1024", () => expect(format_rate(1024.0)).toBe("1.0 MB/s"));
});

describe("collection", () => {
  it("takes rates as the delta between samples", () => {
    const plugin = throughput();
    run_cycle(plugin, () => cmd_result(0, default_snapshots(), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "rx_kbps")).toBeCloseTo(1.0);
  });

  it("persists the active interface", () => {
    const plugin = throughput();
    const result = run_cycle(plugin, () => cmd_result(0, default_snapshots(), ""));
    expect(result.settings[`network:${plugin.id}:throughput_interface`]).toBe("eth0");
    expect(plugin.active_interface_text).toBe("eth0");
  });

  it("prefers an explicit interface to detection", () => {
    const plugin = throughput({ interface: "eth0" });
    run_cycle(plugin, () => cmd_result(0, two_snapshots({ eth0: [0, 0], wlan0: [9_999_999, 0] }, { eth0: [512, 0], wlan0: [9_999_999, 0] }), ""));
    expect(latest_metric(plugin, "rx_kbps")).toBeCloseTo(0.5);
  });

  it("calls a missing explicit interface unavailable", () => {
    const plugin = throughput({ interface: "eth0" });
    run_cycle(plugin, () => cmd_result(0, two_snapshots({ wlan0: [0, 0] }, { wlan0: [1024, 0] }), ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("clamps a counter reset to zero", () => {
    const plugin = throughput();
    run_cycle(plugin, () => cmd_result(0, two_snapshots({ eth0: [5000, 0] }, { eth0: [100, 0] }), ""));
    expect(latest_metric(plugin, "rx_kbps")).toBeCloseTo(0.0);
  });

  it("calls malformed output unavailable", () => {
    const plugin = throughput();
    run_cycle(plugin, () => cmd_result(0, "garbage output", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreadable /proc file unavailable", () => {
    const plugin = throughput();
    run_cycle(plugin, () => cmd_result(1, "", "cat: /proc/net/dev: Permission denied"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "rx_kbps")).toBeNull();
  });

  it("calls no usable interface unavailable", () => {
    const plugin = throughput();
    run_cycle(plugin, () => cmd_result(0, two_snapshots({ lo: [0, 0], veth0: [0, 0] }, { lo: [0, 0], veth0: [0, 0] }), ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("page", () => {
  it("draws download above and upload below on one mirror chart", () => {
    const charts = throughput().UI_SPEC.charts!;
    expect(Object.keys(charts)).toEqual(["rx_chart"]);
    expect(charts.rx_chart.style).toBe("mirror");
    expect(charts.rx_chart.series!.map((series) => series.metric)).toEqual(["rx_kbps", "tx_kbps"]);
  });

  it("keeps the interface and current rates visible", () => {
    expect(throughput().UI_SPEC.layout![0]).toEqual(["host_card", "iface_card", "rx_card", "tx_card"]);
  });
});
