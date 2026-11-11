import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Btrfs, sanitize_mount } from "../../src/monitors/btrfs.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-btrfs", id: "test-btrfs", ssh_config: { host: "test.host" } };
const gibibyte = 1024 ** 3;
const counters = ["write_io_errs", "read_io_errs", "flush_io_errs", "corruption_errs", "generation_errs"];

type Reading = [size: number, used: number, unallocated: number, errors: Record<string, number>];

// The probe's FS, USE and DEV lines for each mountpoint's reading.
function probe(filesystems: Record<string, Reading>): string {
  const lines: string[] = [];
  for (const [mount, [size, used, unallocated, errors]] of Object.entries(filesystems)) {
    lines.push(`FS ${mount}`, `USE size ${size}`, `USE unallocated ${unallocated}`, `USE used ${used}`);
    const device = `/dev/mapper/${mount.replace(/^\/+|\/+$/g, "") || "root"}`;
    for (const counter of counters) lines.push(`DEV [${device}].${counter}    ${errors[counter] ?? 0}`);
  }
  return lines.join("\n") + "\n";
}

const healthy = (used_pct: number, { size = 100 * gibibyte, unallocated = 50 * gibibyte } = {}): Reading => [size, Math.trunc((size * used_pct) / 100), unallocated, {}];
const btrfs = (extra: PluginConfig = {}): Btrfs => make_plugin(Btrfs, { ...config, ...extra });
const run = (plugin: Btrfs, body: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, body, stderr));
const latest_status = (plugin: Btrfs) => store_of(plugin).latest_status("test-btrfs");
const latest_metric = (plugin: Btrfs, name: string) => store_of(plugin).latest_metric("test-btrfs", name)?.value ?? null;

describe("sanitize mount", () => {
  it("names the root mount root", () => expect(sanitize_mount("/")).toBe("root"));
  it("turns separators into underscores", () => expect(sanitize_mount("/var/log")).toBe("var_log"));
  it("keeps case so the label reads back", () => expect(sanitize_mount("/Storage")).toBe("Storage"));
});

describe("collection", () => {
  it("calls all healthy filesystems ok", () => {
    const plugin = btrfs();
    run(plugin, probe({ "/": healthy(10), "/Storage": healthy(20) }));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "filesystems_total")).toBe(2);
    expect(latest_metric(plugin, "filesystems_ok")).toBe(2);
    expect(latest_metric(plugin, "filesystems_degraded")).toBe(0);
  });

  it("records each filesystem's usage", () => {
    const plugin = btrfs();
    run(plugin, probe({ "/": healthy(10), "/Storage": healthy(55) }));
    expect(latest_metric(plugin, "fs_usage_root")).toBeCloseTo(10.0);
    expect(latest_metric(plugin, "fs_usage_Storage")).toBeCloseTo(55.0);
    expect(latest_metric(plugin, "btrfs_usage_max")).toBeCloseTo(55.0);
  });

  it("reads usage raw so a DUP profile shows as the fuller filesystem", () => {
    const plugin = btrfs();
    run(plugin, probe({ "/Storage": [4000, 2000, 1000, {}] }));
    expect(latest_metric(plugin, "fs_usage_Storage")).toBeCloseTo(50.0);
  });

  it.each(counters)("fails on any %s", (counter) => {
    const plugin = btrfs();
    const [size, used, unallocated] = healthy(10);
    run(plugin, probe({ "/": [size, used, unallocated, { [counter]: 3 }] }));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "filesystems_degraded")).toBe(1);
    expect(latest_metric(plugin, "fs_errors_root")).toBe(3);
    expect(latest_metric(plugin, "device_errors")).toBe(3);
  });

  it("ranks errors above an empty filesystem", () => {
    const plugin = btrfs();
    const [size, used, unallocated] = healthy(1);
    run(plugin, probe({ "/": [size, used, unallocated, { read_io_errs: 1 }] }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("warns on usage past the warning", () => {
    const plugin = btrfs();
    run(plugin, probe({ "/": healthy(85) }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails usage at the threshold", () => {
    const plugin = btrfs();
    run(plugin, probe({ "/": healthy(90) }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("applies custom thresholds", () => {
    const plugin = btrfs({ warning: 60, threshold: 75 });
    run(plugin, probe({ "/": healthy(80) }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("warns on exhausted unallocated space however empty", () => {
    const plugin = btrfs();
    run(plugin, probe({ "/": healthy(5, { unallocated: 0 }) }));
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "fs_unallocated_root")).toBe(0);
  });

  it("takes a configurable unallocated warning", () => {
    const plugin = btrfs({ unallocated_warning: 10 * gibibyte });
    run(plugin, probe({ "/": healthy(5, { unallocated: 5 * gibibyte }) }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("narrows the report to named filesystems", () => {
    const plugin = btrfs({ filesystems: ["/Storage"] });
    run(plugin, probe({ "/": healthy(10), "/Storage": healthy(20) }));
    expect(latest_metric(plugin, "filesystems_total")).toBe(1);
    expect(latest_metric(plugin, "fs_usage_Storage")).toBeCloseTo(20.0);
  });

  it("calls no filesystems unavailable", () => {
    const plugin = btrfs();
    run(plugin, "");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("skips a filesystem with no size", () => {
    const plugin = btrfs();
    run(plugin, "FS /broken\nDEV [/dev/x].read_io_errs 0\n");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls missing btrfs-progs unavailable", () => {
    const plugin = btrfs();
    run(plugin, "ERROR btrfs-progs not found\n", 1);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a transport failure unavailable", () => {
    const plugin = btrfs();
    run(plugin, "", -1, "timeout");
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("probe", () => {
  it("reads through mountpoints so it needs no privilege", () => {
    const text = btrfs().commands()[0].text;
    expect(text).not.toContain("sudo");
    expect(text).not.toContain("btrfs filesystem show");
  });

  it("runs one command per cycle", () => expect(btrfs().commands()).toHaveLength(1));
});

describe("page", () => {
  it("gives the per-filesystem repeat card its own row", () => expect(btrfs().UI_SPEC.layout).toContainEqual(["btrfs_filesystems"]));

  it("colors a filesystem with errors failed however empty", () => {
    expect(btrfs().item_level({ usage_pct: 1.0, errors: 2, unallocated: 50 * gibibyte })).toBe("failed");
  });

  it("shows an error count beside the percentage", () => expect(btrfs().item_text({ usage_pct: 41.7, errors: 2 })).toContain("2 dev err"));

  it("ticks the filesystem meters at the warning level", () => {
    const plugin = btrfs();
    const repeat = plugin.UI_SPEC.cards!.btrfs_filesystems.repeat!;
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_value).toBe("usage_pct");
    expect(repeat.bar_marker).toBe(plugin.warning);
    expect(repeat.item_color_by).toBe(plugin.item_level);
  });

  it("shares one bar between healthy and degraded filesystems", () => {
    const health = btrfs().UI_SPEC.cards!.btrfs_degraded_card;
    expect(health.kind).toBe("share");
    expect(health.parts!.map((part) => [part.metric, part.color])).toEqual([["filesystems_ok", "online"], ["filesystems_degraded", "failed"]]);
  });

  it("drops the count cards the meters replace", () => {
    const plugin = btrfs();
    const cards = Object.keys(plugin.UI_SPEC.cards!);
    expect(cards).not.toContain("btrfs_ok_card");
    expect(cards).not.toContain("btrfs_usage_card");
    expect(plugin.card_row()).toEqual(["btrfs_total_card", "btrfs_degraded_card"]);
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = btrfs({ threshold: null });
    run(plugin, probe({ "/": healthy(100) }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = btrfs({ warning: null, unallocated_warning: null });
    run(plugin, probe({ "/": healthy(89, { unallocated: 0 }) }));
    expect(latest_status(plugin)).toBe("online");
    run(plugin, probe({ "/": healthy(90) }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("still fails device errors with no limits", () => {
    const plugin = btrfs({ warning: null, threshold: null });
    const [size, used, unallocated] = healthy(5);
    run(plugin, probe({ "/": [size, used, unallocated, { read_io_errs: 1 }] }));
    expect(latest_status(plugin)).toBe("failed");
  });
});
