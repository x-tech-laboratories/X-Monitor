import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { path_key } from "../../src/monitors/base/disk_usage.ts";
import { Filesystems, parse_inodes, parse_readonly, SNAP } from "../../src/monitors/filesystems.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = { name: "test-fs", id: "test-fs", warning: 80, threshold: 90, ssh_config: { host: "test.host" } };
const header = "Mounted on           1B-blocks        Used Use%";
const inode_header = "Mounted on            Inodes IUsed IFree IUse%";

const df = (...rows: [string, number, number, number][]): string => [header, ...rows.map(([mount, size, used, pct]) => `${mount} ${size} ${used} ${pct}%`)].join("\n") + "\n";
const df_inodes = (...rows: [string, number | "-"][]): string => [inode_header, ...rows.map(([mount, pct]) => (pct === "-" ? `${mount} ${pct}` : `${mount} ${pct}%`))].join("\n") + "\n";
const mounts = (...rows: [string, string][]): string =>
  rows.map(([mount, mode]) => `/dev/sda1 ${mount.replaceAll("\\", "\\134").replaceAll(" ", "\\040")} ext4 ${mode},relatime 0 0`).join("\n") + "\n";
const combined = (...parts: string[]): string => parts.join(`\n${SNAP}\n`);

const filesystems = (extra: PluginConfig = {}): Filesystems => make_plugin(Filesystems, { ...base_config, ...extra });
const latest_status = (plugin: Filesystems) => store_of(plugin).latest_status("test-fs");
const latest_metric = (plugin: Filesystems, name: string) => store_of(plugin).latest_metric("test-fs", name)?.value ?? null;
const run = (plugin: Filesystems, stdout: string, exit_code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(exit_code, stdout, stderr));

describe("path key", () => {
  it("names the root", () => expect(path_key("/")).toBe("root"));
  it("flattens a nested path", () => expect(path_key("/var/log")).toBe("var_log"));
});

describe("collection", () => {
  it("calls healthy filesystems online", () => {
    const plugin = filesystems();
    run(plugin, df(["/", 100_000_000_000, 40_000_000_000, 40], ["/home", 500_000_000_000, 100_000_000_000, 20]));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "worst_used_pct")).toBeCloseTo(40.0);
    expect(latest_metric(plugin, "fs_root_used_pct")).toBeCloseTo(40.0);
    expect(latest_metric(plugin, "fs_home_used_pct")).toBeCloseTo(20.0);
  });

  it("warns past the warning", () => {
    const plugin = filesystems();
    run(plugin, df(["/", 100, 85, 85]));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails past the threshold", () => {
    const plugin = filesystems();
    run(plugin, df(["/", 100, 40, 40], ["/data", 100, 95, 95]));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "worst_used_pct")).toBeCloseTo(95.0);
  });

  it("reads a mount with a space", () => {
    const plugin = filesystems();
    run(plugin, df(["/mnt/my drive", 100, 10, 10]));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "fs_mnt_my_drive_used_pct")).toBeCloseTo(10.0);
  });

  it("calls no filesystems unavailable", () => {
    const plugin = filesystems();
    run(plugin, `${header}\n`);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a df failure unavailable", () => {
    const plugin = filesystems();
    run(plugin, "", 1, "df: error");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = filesystems();
    run(plugin, "", -1, "not connected");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("counts the filesystems for the count card", () => {
    const plugin = filesystems();
    run(plugin, df(["/", 100, 40, 40], ["/home", 100, 20, 20]));
    expect(plugin.filesystem_count).toBe("2");
  });
});

describe("parse inodes", () => {
  it("reads each mount's percent", () => {
    expect(parse_inodes(df_inodes(["/", 12], ["/home", 90]))).toEqual(new Map([["/", 12.0], ["/home", 90.0]]));
  });

  it("leaves out filesystems without inodes", () => {
    expect(parse_inodes(df_inodes(["/tank", "-"], ["/", 5]))).toEqual(new Map([["/", 5.0]]));
  });

  it("reads a mount with a space", () => {
    expect(parse_inodes(df_inodes(["/mnt/my drive", 30]))).toEqual(new Map([["/mnt/my drive", 30.0]]));
  });
});

describe("parse readonly", () => {
  it("tells read-only from read-write", () => {
    expect(parse_readonly(mounts(["/", "rw"], ["/data", "ro"]))).toEqual(new Map([["/", false], ["/data", true]]));
  });

  it("decodes an escaped space", () => {
    expect(parse_readonly(mounts(["/mnt/my drive", "ro"]))).toEqual(new Map([["/mnt/my drive", true]]));
  });

  it("ignores malformed lines", () => {
    expect(parse_readonly("garbage\n/dev/sda1 /mnt ext4 rw 0 0\n")).toEqual(new Map([["/mnt", false]]));
  });
});

describe("inode exhaustion", () => {
  it("keeps healthy inodes online", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/", 100, 10, 10]), df_inodes(["/", 12]), mounts(["/", "rw"])));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "fs_root_inodes_pct")).toBeCloseTo(12.0);
  });

  it("fails exhausted inodes despite free space", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/", 100, 10, 10]), df_inodes(["/", 97]), mounts(["/", "rw"])));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "worst_used_pct")).toBeCloseTo(10.0);
    expect(latest_metric(plugin, "worst_inodes_pct")).toBeCloseTo(97.0);
  });

  it("warns on inodes past the warning", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/", 100, 10, 10]), df_inodes(["/", 88]), mounts(["/", "rw"])));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("records no inode metric for a filesystem without inodes", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/tank", 100, 10, 10]), df_inodes(["/tank", "-"]), mounts(["/tank", "rw"])));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "fs_tank_inodes_pct")).toBeNull();
  });
});

describe("read-only detection", () => {
  it("fails a read-only mount", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/", 100, 10, 10], ["/data", 100, 20, 20]), df_inodes(["/", 5], ["/data", 5]), mounts(["/", "rw"], ["/data", "ro"])));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "readonly_count")).toBeCloseTo(1.0);
  });

  it("warns on a read-only mount when configured", () => {
    const plugin = filesystems({ readonly_is_failure: false });
    run(plugin, combined(df(["/data", 100, 20, 20]), df_inodes(["/data", 5]), mounts(["/data", "ro"])));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("ignores read-only mounts df does not report", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/", 100, 10, 10]), df_inodes(["/", 5]), mounts(["/", "rw"], ["/nix/store", "ro"], ["/run/user/1000/doc", "ro"])));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "readonly_count")).toBeCloseTo(0.0);
  });

  it("skips excluded mounts and their children", () => {
    const plugin = filesystems({ exclude_mounts: ["/var/lib/waydroid/rootfs/"] });
    run(plugin, combined(
      df(["/", 100, 10, 10], ["/var/lib/waydroid/rootfs", 100, 99, 99], ["/var/lib/waydroid/rootfs/vendor", 100, 99, 99], ["/var/lib/waydroid/rootfs2", 100, 20, 20]),
      df_inodes(["/", 5], ["/var/lib/waydroid/rootfs", 5], ["/var/lib/waydroid/rootfs/vendor", 5], ["/var/lib/waydroid/rootfs2", 5]),
      mounts(["/", "rw"], ["/var/lib/waydroid/rootfs", "ro"], ["/var/lib/waydroid/rootfs/vendor", "ro"], ["/var/lib/waydroid/rootfs2", "rw"]),
    ));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "readonly_count")).toBeCloseTo(0.0);
    expect(latest_metric(plugin, "fs_var_lib_waydroid_rootfs2_used_pct")).toBeCloseTo(20.0);
    expect(latest_metric(plugin, "fs_var_lib_waydroid_rootfs_used_pct")).toBeNull();
  });

  it("calls excluding everything unavailable", () => {
    const plugin = filesystems({ exclude_mounts: ["/"] });
    run(plugin, combined(df(["/", 100, 10, 10], ["/data", 100, 20, 20])));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("keeps all read-write mounts online", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/", 100, 10, 10]), df_inodes(["/", 5]), mounts(["/", "rw"])));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "readonly_count")).toBeCloseTo(0.0);
  });
});

describe("degraded output", () => {
  it("still works from space alone", () => {
    const plugin = filesystems();
    run(plugin, df(["/", 100, 95, 95]));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "worst_used_pct")).toBeCloseTo(95.0);
  });

  it("works from space and inodes without mounts", () => {
    const plugin = filesystems();
    run(plugin, combined(df(["/", 100, 10, 10]), df_inodes(["/", 97])));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "worst_inodes_pct")).toBeCloseTo(97.0);
  });
});

describe("actions", () => {
  it("plans no action", () => expect(filesystems().plan_action("anything")).toBeNull());
});

describe("page", () => {
  it("ticks the filesystem meters at the warning level", () => {
    const plugin = filesystems();
    const repeat = plugin.UI_SPEC.cards!.filesystems.repeat!;
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_value).toBe("used_pct");
    expect(repeat.bar_marker).toBe(plugin.warning);
    expect(repeat.item_color_by).toBe(plugin.item_color);
  });

  it("drops the worst usage card the meters make redundant", () => {
    const spec = filesystems().UI_SPEC;
    expect("worst_card" in spec.cards!).toBe(false);
    expect(spec.layout!.flat()).not.toContain("worst_card");
  });

  it("adds the inode percent to a meter's text once inodes are a problem", () => {
    const plugin = filesystems();
    expect(plugin.item_text({ used_pct: 40, inodes_pct: 10 })).toBe("40%");
    expect(plugin.item_text({ used_pct: 40, inodes_pct: 96 })).toBe("40%  ·  inodes 96%");
    expect(plugin.item_level({ used_pct: 40, inodes_pct: 96 })).toBe("failed");
  });
});

describe("optional limits", () => {
  it("never fails with warnings only", () => {
    const plugin = filesystems({ threshold: null, inode_threshold: null });
    run(plugin, combined(df(["/", 100, 100, 100]), df_inodes(["/", 100])));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with failures only", () => {
    const plugin = filesystems({ warning: null, inode_warning: null });
    run(plugin, df(["/", 100, 89, 89]));
    expect(latest_status(plugin)).toBe("online");
    run(plugin, df(["/", 100, 90, 90]));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("stays online with no limits", () => {
    const plugin = filesystems({ warning: null, threshold: null });
    run(plugin, df(["/", 100, 100, 100]));
    expect(latest_status(plugin)).toBe("online");
  });

  it("falls back to the threshold for the meter tick", () => {
    expect(filesystems({ warning: null }).UI_SPEC.cards!.filesystems.repeat!.bar_marker).toBe(90);
  });
});
