import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { parse_probe, probe_script, RebootRequired, type RebootSnapshot } from "../../src/monitors/reboot_required.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-reboot", id: "test-reboot", ssh_config: { host: "test.host" } };
const kernel = "/nix/store/aaaa-linux-6.18.46";
const new_kernel = "/nix/store/bbbb-linux-6.19.1";

function nixos(booted = kernel, current = kernel): string {
  const lines = ["kernel=6.18.46", "nixos=1"];
  for (const part of ["initrd", "kernel", "kernel-modules", "systemd"]) {
    const kernel_side = part === "kernel" || part === "kernel-modules";
    lines.push(`booted_part=${kernel_side ? booted : kernel}/${part}`);
    lines.push(`current_part=${kernel_side ? current : kernel}/${part}`);
  }
  return lines.join("\n") + "\n";
}

const debian_clean = "kernel=6.1.0-25-amd64\ndebian=1\nmodules=present\n";
const debian_flagged = "kernel=6.1.0-25-amd64\ndebian=1\ndebian_flag=1\ndebian_pkg=linux-image-6.1.0-26-amd64\ndebian_pkg=libc6\ndebian_pkg=libc6\nmodules=present\n";
const rhel_reboot =
  "kernel=5.14.0-427.el9.x86_64\nrhel_rc=1\n" +
  "rhel_out=Core libraries or services have been updated since boot-up:\n" +
  "rhel_out=  * kernel\nrhel_out=  * glibc\nrhel_out=\n" +
  "rhel_out=Reboot is required to fully utilize these updates.\n" +
  "rhel_out=More information: https://access.redhat.com/solutions/27943\n" +
  "modules=present\n";
const rhel_clean =
  "kernel=5.14.0-427.el9.x86_64\nrhel_rc=0\n" +
  "rhel_out=No core libraries or services have been updated since boot-up.\n" +
  "rhel_out=Reboot should not be necessary.\nmodules=present\n";

const reboot = (extra: PluginConfig = {}): RebootRequired => make_plugin(RebootRequired, { ...config, ...extra });
const run = (plugin: RebootRequired, stdout: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const snapshot_of = (result: { snapshot: unknown }) => result.snapshot as RebootSnapshot;
const latest_status = (plugin: RebootRequired) => store_of(plugin).latest_status("test-reboot");
const latest_metric = (plugin: RebootRequired, name: string) => store_of(plugin).latest_metric("test-reboot", name)?.value ?? null;

describe("probe script", () => {
  it("runs every check", () => {
    const script = probe_script();
    for (const needle of ["uname -r", "/run/booted-system", "/var/run/reboot-required", "needs-restarting -r", "/usr/lib/modules"]) expect(script).toContain(needle);
  });

  it("is one sampled command", () => {
    const plugin = reboot();
    expect(plugin.SAMPLED).toBe(true);
    expect(plugin.commands()).toHaveLength(1);
  });

  it("collects repeated keys", () => {
    const fields = parse_probe("kernel=6.1\ndebian_pkg=a\ndebian_pkg=b\nnoise\n");
    expect(fields.kernel).toBe("6.1");
    expect(fields.debian_pkg).toEqual(["a", "b"]);
  });
});

describe("debian", () => {
  it("calls no flag online", () => {
    const plugin = reboot();
    const result = run(plugin, debian_clean);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "reboot_required")).toBe(0.0);
    expect(snapshot_of(result).checks).toEqual(["debian", "kernel"]);
  });

  it("warns on the flag with its packages", () => {
    const plugin = reboot();
    const result = run(plugin, debian_flagged);
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "reboot_required")).toBe(1.0);
    expect(snapshot_of(result).packages).toEqual(["linux-image-6.1.0-26-amd64", "libc6"]);
    expect(result.logs[0][0]).toContain("linux-image-6.1.0-26-amd64");
  });

  it("takes a configurable reboot status", () => {
    const plugin = reboot({ reboot_status: "failed" });
    run(plugin, debian_flagged);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("falls back to warning for an unknown reboot status", () => expect(reboot({ reboot_status: "bogus" }).reboot_status).toBe("warning"));
});

describe("rhel", () => {
  it("requires a reboot on needs-restarting exit 1", () => {
    const plugin = reboot();
    const result = run(plugin, rhel_reboot);
    expect(latest_status(plugin)).toBe("warning");
    expect(snapshot_of(result).packages).toEqual(["kernel", "glibc"]);
  });

  it("calls needs-restarting exit 0 online", () => {
    const plugin = reboot();
    run(plugin, rhel_clean);
    expect(latest_status(plugin)).toBe("online");
  });

  it("does not take dnf without the command for a reboot", () => {
    const plugin = reboot();
    const result = run(plugin, "kernel=6.9\nrhel_rc=1\nrhel_out=No such command: needs-restarting.\nmodules=present\n");
    expect(latest_status(plugin)).toBe("online");
    expect(snapshot_of(result).checks).toEqual(["kernel"]);
  });
});

describe("generic kernel", () => {
  it("requires a reboot when the module directory is gone", () => {
    const plugin = reboot();
    const result = run(plugin, "kernel=6.10.1-arch1-1\nmodules=missing\n");
    expect(latest_status(plugin)).toBe("warning");
    expect(snapshot_of(result).reasons[0]).toContain("6.10.1-arch1-1");
  });

  it("calls a present module directory online", () => {
    const plugin = reboot();
    run(plugin, "kernel=6.10.1-arch1-1\nmodules=present\n");
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("nixos", () => {
  it("calls the same boot parts online", () => {
    const plugin = reboot();
    run(plugin, nixos());
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "reboot_required")).toBe(0.0);
  });

  it("requires a reboot for a changed kernel and names the parts", () => {
    const plugin = reboot();
    const result = run(plugin, nixos(kernel, new_kernel));
    expect(latest_status(plugin)).toBe("warning");
    expect(snapshot_of(result).packages).toEqual(["kernel", "kernel-modules"]);
  });

  it("skips the module check on nixos", () => {
    const plugin = reboot();
    const result = run(plugin, nixos() + "modules=missing\n");
    expect(latest_status(plugin)).toBe("online");
    expect(snapshot_of(result).checks).toEqual(["nixos"]);
  });
});

describe("unavailable", () => {
  it("calls no applicable check unavailable", () => {
    const plugin = reboot();
    run(plugin, "kernel=6.1\n");
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "reboot_required")).toBeNull();
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = reboot();
    run(plugin, "", -1, "connection refused");
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("cards", () => {
  it("follows the metric in the card text", () => {
    const plugin = reboot();
    expect(plugin.reboot_text).toBe("--");
    run(plugin, debian_flagged);
    expect(plugin.reboot_text).toBe("REQUIRED");
    expect(plugin.reboot_color).toBe("warning");
    expect(plugin.kernel_text).toBe("6.1.0-25-amd64");
    expect(plugin.reason_rows.map((row) => row.kind)).toEqual(["Reason", "Package", "Package"]);
    run(plugin, debian_clean);
    expect(plugin.reboot_text).toBe("NOT NEEDED");
    expect(plugin.reboot_color).toBe("online");
  });

  it("places the details table", () => {
    const spec = reboot().UI_SPEC;
    expect(spec.layout!.flat()).toContain("details");
    expect("details" in spec.tables!).toBe(true);
  });
});
