import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { auto_detect_device, DiskIo, format_rate, is_device_path, is_physical, parse_diskstats, resolve_device_path } from "../../src/monitors/disk_io.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-disk_io", id: "test-disk_io", ssh_config: { host: "test.host" } };
type Devices = Record<string, [number, number]>;

const make_diskstats = (devices: Devices): string =>
  Object.entries(devices).map(([name, [read, written]], index) => `   8       ${index} ${name} 100 0 ${read} 50 200 0 ${written} 80 0 0 0 0`).join("\n") + "\n";
const two_snaps = (first: Devices, second: Devices): string => make_diskstats(first) + "---SNAP---\n" + make_diskstats(second);
const sample = (devices: Devices) => new Map(Object.entries(devices));

const disk_io = (extra: PluginConfig = {}): DiskIo => make_plugin(DiskIo, { ...config, ...extra });
const run = (plugin: DiskIo, body: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, body, stderr));
const latest_status = (plugin: DiskIo) => store_of(plugin).latest_status("test-disk_io");
const latest_metric = (plugin: DiskIo, name: string) => store_of(plugin).latest_metric("test-disk_io", name)?.value ?? null;

describe("parse diskstats", () => {
  it("reads sectors read and written", () => expect(parse_diskstats(make_diskstats({ sda: [1000, 2000] })).get("sda")).toEqual([1000, 2000]));

  it("reads several devices", () => {
    expect(new Set(parse_diskstats(make_diskstats({ sda: [1, 2], nvme0n1: [3, 4] })).keys())).toEqual(new Set(["sda", "nvme0n1"]));
  });
});

describe("is physical", () => {
  it("counts whole disks", () => {
    for (const name of ["sda", "nvme0n1", "mmcblk0"]) expect(is_physical(name)).toBe(true);
  });

  it("leaves out partitions", () => {
    for (const name of ["sda1", "nvme0n1p1", "mmcblk0p2"]) expect(is_physical(name)).toBe(false);
  });

  it("leaves out virtual devices", () => {
    for (const name of ["loop0", "ram0", "dm-0"]) expect(is_physical(name)).toBe(false);
  });
});

describe("auto detect", () => {
  it("picks the busiest disk", () => {
    expect(auto_detect_device(sample({ sda: [0, 0], sdb: [0, 0] }), sample({ sda: [100, 0], sdb: [5000, 0] }))).toBe("sdb");
  });

  it("leaves out partitions", () => {
    expect(auto_detect_device(sample({ sda1: [0, 0], sda: [0, 0] }), sample({ sda1: [9999, 0], sda: [10, 0] }))).toBe("sda");
  });

  it("picks none without candidates", () => expect(auto_detect_device(new Map(), new Map())).toBeNull());
});

describe("device paths", () => {
  it("recognises a path", () => expect(is_device_path("/dev/disk/by-id/ata-EXAMPLE_1234")).toBe(true));
  it("does not take a kernel name as a path", () => expect(is_device_path("sda")).toBe(false));
  it("resolves to the kernel name", () => expect(resolve_device_path("/dev/sdb\n")).toBe("sdb"));
  it("resolves an absent link to none", () => expect(resolve_device_path("")).toBeNull());
});

describe("format rate", () => {
  it("shows KB/s below 1024", () => expect(format_rate(512.0)).toBe("512.0 KB/s"));
  it("shows MB/s from 1024", () => expect(format_rate(2048.0)).toBe("2.0 MB/s"));
});

describe("collection", () => {
  it("records throughput", () => {
    const plugin = disk_io();
    run(plugin, two_snaps({ sda: [0, 0] }, { sda: [2, 4] }));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "read_kbps")).toBeCloseTo(1.0);
    expect(latest_metric(plugin, "write_kbps")).toBeCloseTo(2.0);
  });

  it("clamps a counter reset", () => {
    const plugin = disk_io();
    run(plugin, two_snaps({ sda: [5000, 5000] }, { sda: [10, 10] }));
    expect(latest_metric(plugin, "read_kbps")).toBeCloseTo(0.0);
  });

  it("detects the busiest device", () => {
    const plugin = disk_io();
    const result = run(plugin, two_snaps({ sda: [0, 0], sdb: [0, 0] }, { sda: [2, 0], sdb: [1000, 0] }));
    expect(result.settings[`disks:${plugin.id}:active_device`]).toBe("sdb");
  });

  it("calls a missing explicit device unavailable", () => {
    const plugin = disk_io({ device: "sda" });
    run(plugin, two_snaps({ sdb: [0, 0] }, { sdb: [2, 0] }));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("resolves a by-id path to the current letter", () => {
    const plugin = disk_io({ device: "/dev/disk/by-id/ata-EXAMPLE_1234" });
    const result = run(plugin, two_snaps({ sdb: [0, 0] }, { sdb: [2, 4] }) + "---DEVICE---\n/dev/sdb\n");
    expect(latest_status(plugin)).toBe("online");
    expect(result.settings[`disks:${plugin.id}:active_device`]).toBe("sdb");
    expect(latest_metric(plugin, "read_kbps")).toBeCloseTo(1.0);
  });

  it("calls an absent by-id path unavailable", () => {
    const plugin = disk_io({ device: "/dev/disk/by-id/ata-EXAMPLE_1234" });
    run(plugin, two_snaps({ sdb: [0, 0] }, { sdb: [2, 4] }) + "---DEVICE---\n");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("resolves a by-id path on the target", () => {
    expect(disk_io({ device: "/dev/disk/by-id/ata-EXAMPLE_1234" }).commands()[0].text).toContain("readlink -e /dev/disk/by-id/ata-EXAMPLE_1234");
  });

  it("calls malformed output unavailable", () => {
    const plugin = disk_io();
    run(plugin, "no separator here");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a transport failure unavailable", () => {
    const plugin = disk_io();
    run(plugin, "", -1, "err");
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("page", () => {
  it("draws read and write as lines on one chart", () => {
    const charts = disk_io().UI_SPEC.charts!;
    expect(Object.keys(charts)).toEqual(["read_chart"]);
    expect(charts.read_chart.style).toBe("lines");
    expect(charts.read_chart.series!.map((series) => series.metric)).toEqual(["read_kbps", "write_kbps"]);
  });

  it("keeps the device and current rates visible", () => {
    expect(disk_io().UI_SPEC.layout![0]).toEqual(["host_card", "io_device_card", "read_card", "write_card"]);
  });
});
