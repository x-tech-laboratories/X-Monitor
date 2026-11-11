import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Smart, SMART_SCRIPT } from "../../src/monitors/smart.ts";
import type { ItemColorRule, ItemFormatter } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const smart = (): Smart => make_plugin(Smart, { name: "test-smart", id: "test-smart", ssh_config: { host: "test.host" } });
const run = (plugin: Smart, body: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, body, stderr));
const parse = (stdout: string) => smart().parse([cmd_result(0, stdout, "")]);
const latest_status = (plugin: Smart) => store_of(plugin).latest_status("test-smart");
const latest_metric = (plugin: Smart, name: string) => store_of(plugin).latest_metric("test-smart", name)?.value ?? null;
const tiles = () => smart().UI_SPEC.cards!.smart_disk_tiles.repeat!;

describe("collection", () => {
  it("calls all passing disks online", () => {
    const plugin = smart();
    run(plugin, "PASS /dev/sda\nPASS /dev/sdb");
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails on one failing disk", () => {
    const plugin = smart();
    run(plugin, "PASS /dev/sda\nFAIL /dev/sdb\nFAIL /dev/sdc");
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "disks_total")).toBe(3);
    expect(latest_metric(plugin, "disks_ok")).toBe(1);
    expect(latest_metric(plugin, "disks_failed")).toBe(2);
  });

  it("calls no disks unavailable", () => {
    const plugin = smart();
    run(plugin, "");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("skips malformed lines", () => {
    const plugin = smart();
    run(plugin, "PASS /dev/sda\nsome random noise\nFAIL /dev/sdb");
    expect(latest_metric(plugin, "disks_total")).toBe(2);
  });

  it("calls a transport failure unavailable", () => {
    const plugin = smart();
    run(plugin, "", -1, "SSH timeout");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a missing smartctl unavailable", () => {
    const plugin = smart();
    run(plugin, "ERROR smartctl not found", 1);
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

// The failure that matters most: when smartctl cannot run, the monitor must not report healthy disks.
describe("blind checks are not healthy", () => {
  it("does not take a privilege error for a passing disk", () => {
    const result = parse("UNKNOWN /dev/sda sudo: must be owned by uid 0 and have the setuid bit set");
    expect(result.status).toBe("unavailable");
    expect(result.metrics.disks_ok).toBe(0);
  });

  it("still passes a healthy disk", () => {
    const result = parse("PASS /dev/sda\nPASS /dev/sdb");
    expect(result.status).toBe("online");
    expect(result.metrics.disks_ok).toBe(2);
  });

  it("calls the monitor unavailable on one unreadable disk", () => {
    expect(parse("PASS /dev/sda\nUNKNOWN /dev/sdb Permission denied").status).toBe("unavailable");
  });

  it("ranks a failing disk above an unreadable one", () => {
    expect(parse("FAIL /dev/sda\nUNKNOWN /dev/sdb Permission denied").status).toBe("failed");
  });

  it("classifies by positive assertion", () => expect(SMART_SCRIPT).toContain("test result: *PASSED"));
});

describe("non-physical devices", () => {
  it("filters virtual devices before probing", () => expect(SMART_SCRIPT).toContain("grep -Ev '^(zram|zd|loop|md|dm-|sr|fd|ram)'"));

  it("skips an unsupported device without counting it", () => {
    const result = parse("PASS /dev/sda\nSKIP /dev/zd0");
    expect(result.status).toBe("online");
    expect(result.metrics.disks_total).toBe(1);
  });

  it("reads only skips as no disks", () => expect(parse("SKIP /dev/zram0\nSKIP /dev/zd0").status).toBe("unavailable"));
});

describe("page", () => {
  it("shares one bar between healthy, failed and unreadable disks", () => {
    const health = smart().UI_SPEC.cards!.smart_failed_card;
    expect(health.kind).toBe("share");
    expect(health.parts!.map((part) => [part.metric, part.color])).toEqual([["disks_ok", "online"], ["disks_failed", "failed"], ["disks_unknown", "neutral"]]);
  });

  it("replaces the healthy count card with the share", () => {
    expect(new Set(Object.keys(smart().UI_SPEC.cards!))).toEqual(new Set(["smart_total_card", "smart_failed_card", "smart_disk_tiles"]));
  });
});

describe("disk tiles", () => {
  it("records each disk with its verdict and readings", () => {
    const result = parse("PASS /dev/sda temp=34 hours=12345\nFAIL /dev/sdb temp=51\nUNKNOWN /dev/sdc Permission denied\nSKIP /dev/zd0\n");
    expect(result.snapshot).toEqual([
      { label: "sda", health: "PASSED", temperature: 34.0, power_on_hours: 12345.0 },
      { label: "sdb", health: "FAILED", temperature: 51.0, power_on_hours: null },
      { label: "sdc", health: "unknown", temperature: null, power_on_hours: null },
    ]);
  });

  it("still parses the old output shape", () => {
    const result = parse("PASS /dev/sda\nFAIL /dev/sdb");
    expect(result.metrics.disks_ok).toBe(1);
    expect(result.snapshot).toEqual([
      { label: "sda", health: "PASSED", temperature: null, power_on_hours: null },
      { label: "sdb", health: "FAILED", temperature: null, power_on_hours: null },
    ]);
  });

  it("leaves out an unreadable reading", () => {
    const disk = (parse("PASS /dev/sda temp=hot hours=").snapshot as Record<string, unknown>[])[0];
    expect(disk.temperature).toBeNull();
    expect(disk.power_on_hours).toBeNull();
  });

  it("clears the tiles when there are no disks", () => expect(parse("SKIP /dev/zd0").snapshot).toEqual([]));

  it("reads attributes in the same smartctl call", () => {
    expect(SMART_SCRIPT).toContain("smartctl -H -A");
    expect(SMART_SCRIPT).toContain("temp=");
    expect(SMART_SCRIPT).toContain("hours=");
  });

  it("puts the tiles on their own row", () => {
    const plugin = smart();
    expect(plugin.UI_SPEC.layout).toContainEqual(["smart_disk_tiles"]);
    expect(plugin.card_row()).toEqual(["smart_total_card", "smart_failed_card"]);
  });

  it("repeats the tiles over the snapshot", () => {
    expect(tiles().source).toBe("snapshot");
    expect(tiles().container).toBe("tiles");
  });

  it.each([
    [{ health: "PASSED", temperature: 34.0, power_on_hours: 12345.0 }, "PASSED · 34°C · 12,345 h"],
    [{ health: "FAILED", temperature: 51.0, power_on_hours: null }, "FAILED · 51°C"],
    [{ health: "unknown", temperature: null, power_on_hours: null }, "unknown"],
  ])("captions %o as %s", (item, caption) => expect((tiles().item_format_fn as ItemFormatter)(item)).toBe(caption));

  it.each([["PASSED", "online"], ["FAILED", "failed"], ["unknown", "unavailable"]])("colors a %s tile %s", (health, color) => {
    expect((tiles().item_color_by as ItemColorRule)({ health })).toBe(color);
  });
});
