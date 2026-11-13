import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { DiskSpace } from "../../src/monitors/disk_space.ts";
import { format_bytes, type PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = { name: "test-disk", id: "test-disk", path: "/", threshold: 90, ssh_config: { host: "test.host" } };
const gigabyte = 1024 ** 3;

const df_line = (size: number, used: number, avail: number, pct: number): string => `${size} ${used} ${avail} ${pct}%\n`;
const disk = (extra: PluginConfig = {}): DiskSpace => make_plugin(DiskSpace, { ...base_config, ...extra });
const storage_disk = (): DiskSpace => make_plugin(DiskSpace, { name: "test-disk-storage", id: "test-disk-storage", path: "/Storage", threshold: 80, ssh_config: { host: "test.host" } });
const latest_status = (plugin: DiskSpace) => store_of(plugin).latest_status(plugin.id);
const latest_metric = (plugin: DiskSpace, name: string) => store_of(plugin).latest_metric(plugin.id, name)?.value ?? null;

describe("format bytes", () => {
  it("shows less than 1 GB as MB", () => expect(format_bytes(0.5)).toBe("512 MB"));
  it("shows exactly 1 GB", () => expect(format_bytes(1.0)).toBe("1.0 GB"));
  it("shows GB between 1 and 1024", () => expect(format_bytes(512.0)).toBe("512.0 GB"));
  it("shows 1024 GB as TB", () => expect(format_bytes(1024.0)).toBe("1.0 TB"));
  it("shows more than 1024 GB as TB", () => expect(format_bytes(2048.0)).toBe("2.0 TB"));

  it("reads the value in a unit hint", () => {
    expect(format_bytes(2 * 1024 ** 3, "B")).toBe("2.0 GB");
    expect(format_bytes(512, "MB")).toBe("512 MB");
    expect(format_bytes(2, "TB")).toBe("2.0 TB");
  });

  it("rejects an unknown unit", () => {
    expect(() => format_bytes(1.0, "furlongs" as never)).toThrow();
  });
});

describe("collection", () => {
  it("calls usage below the threshold online", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 50 * gigabyte, 50 * gigabyte, 50), ""));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails usage at the threshold", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 90 * gigabyte, 10 * gigabyte, 90), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails usage above the threshold", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 95 * gigabyte, 5 * gigabyte, 95), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("respects a custom threshold", () => {
    const plugin = storage_disk();
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 85 * gigabyte, 15 * gigabyte, 85), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("records the used percent", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 42 * gigabyte, 58 * gigabyte, 42), ""));
    expect(latest_metric(plugin, "used_pct")).toBeCloseTo(42.0);
  });

  it("records the size", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(200 * gigabyte, 100 * gigabyte, 100 * gigabyte, 50), ""));
    expect(latest_metric(plugin, "size_gb")).toBeCloseTo(200.0);
  });

  it("records the used size", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(200 * gigabyte, 75 * gigabyte, 125 * gigabyte, 37), ""));
    expect(latest_metric(plugin, "used_gb")).toBeCloseTo(75.0);
  });

  it("records the available size", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(200 * gigabyte, 75 * gigabyte, 125 * gigabyte, 37), ""));
    expect(latest_metric(plugin, "avail_gb")).toBeCloseTo(125.0);
  });

  it("calls a transport failure unavailable", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(-1, "", "connection refused"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls malformed output unavailable", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, "unexpected garbage", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls empty output unavailable", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, "", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("writes no metrics on a transport failure", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(-1, "", "timeout"));
    expect(latest_metric(plugin, "used_pct")).toBeNull();
  });

  it("parses the percent", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 33 * gigabyte, 67 * gigabyte, 33), ""));
    expect(latest_metric(plugin, "used_pct")).toBeCloseTo(33.0);
  });
});

describe("actions", () => {
  it("plans no action", () => {
    expect(disk().plan_action("anything")).toBeNull();
  });
});

describe("page", () => {
  it("draws usage as a gauge colored by the threshold", () => {
    const plugin = disk();
    const usage = plugin.UI_SPEC.cards!.usage_card;
    expect(usage.kind).toBe("gauge");
    expect(usage.metric).toBe("used_pct");
    expect(usage.color).toEqual({ warning: plugin.threshold, threshold: plugin.threshold });
  });

  it("keeps the path, available and total cards", () => {
    const cards = Object.keys(disk().UI_SPEC.cards!);
    for (const name of ["path_card", "avail_card", "total_card"]) expect(cards).toContain(name);
  });
});

describe("optional limits", () => {
  it("turns the warning off by default", () => {
    expect(disk().warning).toBeNull();
  });

  it("warns before the threshold when a warning is set", () => {
    const plugin = disk({ warning: 80 });
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 85 * gigabyte, 15 * gigabyte, 85), ""));
    expect(latest_status(plugin)).toBe("warning");
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 90 * gigabyte, 10 * gigabyte, 90), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("never fails with a warning only", () => {
    const plugin = disk({ warning: 80, threshold: null });
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 100 * gigabyte, 0, 100), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = disk();
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 89 * gigabyte, 11 * gigabyte, 89), ""));
    expect(latest_status(plugin)).toBe("online");
  });

  it("stays online with no limits", () => {
    const plugin = disk({ threshold: null });
    run_cycle(plugin, () => cmd_result(0, df_line(100 * gigabyte, 100 * gigabyte, 0, 100), ""));
    expect(latest_status(plugin)).toBe("online");
  });

  it("names each level that is on in the limits card", () => {
    expect(disk({ warning: 80 }).limits_label).toBe("warn 80% / fail 90%");
    expect(disk({ threshold: null }).limits_label).toBe("no limits");
  });

  it("colors the gauge by both limits", () => {
    expect(disk({ warning: 80, threshold: null }).UI_SPEC.cards!.usage_card.color).toEqual({ warning: 80, threshold: null });
  });
});
