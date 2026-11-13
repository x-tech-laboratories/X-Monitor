import { describe, expect, it } from "vitest";

import { Plugin } from "../../src/monitors/base/plugin_base.ts";
import { builtin_monitor_types } from "../../src/monitors/index.ts";

// Every monitor type the Python app shipped, by the `type` a config names.
const python_types = [
  "attic_push", "blockurl", "btrfs", "cloud", "command", "connections", "containers", "cpu", "ddns_updater", "disk_io",
  "disk_space", "dns_record", "filesystems", "folders", "freshrss", "frigate", "gpu", "group", "host_control", "http",
  "interfaces", "interrupts", "journal", "load", "md", "memory", "mosquitto", "nix_gc", "nixos_upgrade", "oom",
  "package_updates", "pihole", "ports", "power", "processes", "push", "qbittorrent", "reboot_required", "service_list",
  "sessions", "smart", "syncthing", "systemd_service", "temperature", "throughput", "traccar", "trilium", "unbound",
  "uptime", "vms", "vuln_scan", "wifi", "x_monitor_self", "zfs",
];

describe("built-in monitor types", () => {
  it("ships every type the Python app shipped, and no other", () => {
    expect(Object.keys(builtin_monitor_types).sort()).toEqual([...python_types].sort());
  });

  it.each(python_types)("loads %s as a monitor class", async (type) => {
    const cls = await builtin_monitor_types[type]();
    expect(cls.prototype).toBeInstanceOf(Plugin);
  });
});
