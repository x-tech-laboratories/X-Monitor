import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { SCRIPT_SEP, type PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { PackageUpdates, parse_apt, parse_dnf, parse_pacman, probe_script, type PackageUpdate } from "../../src/monitors/package_updates.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-updates", id: "test-updates", ssh_config: { host: "test.host" } };

const apt_list = `Listing... Done
bash/jammy-updates 5.1-6ubuntu1.1 amd64 [upgradable from: 5.1-6ubuntu1]
libssl3/jammy-updates,jammy-security 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.15]
openssl/stable-security 3.0.14-1~deb12u2 amd64 [upgradable from: 3.0.13-1~deb12u1]
`;

const apt_sim = `NOTE: This is only a simulation!
Inst libc6 [2.36-9+deb12u7] (2.36-9+deb12u8 Debian-Security:12/stable-security [amd64])
Inst linux-image-6.1.0-26-amd64 (6.1.112-1 Debian:12.7/stable [amd64])
Conf libc6 (2.36-9+deb12u8 Debian-Security:12/stable-security [amd64])
`;

const dnf_updates = `
bash.x86_64                        5.2.26-3.fc40                 updates
curl.x86_64                        8.6.0-8.fc40                  updates
texlive-collection-latexrecommended.noarch
                                   11:svn65512-1.fc40            updates
Obsoleting Packages
grub2-tools.x86_64                 1:2.06-120.fc40               updates
    grub2-tools.x86_64             1:2.06-118.fc40               @updates
`;

const dnf_security = `FEDORA-2024-1a2b3c4d5e Moderate/Sec.  curl-8.6.0-8.fc40.x86_64
FEDORA-2024-9f8e7d6c5b Important/Sec. curl-minimal-8.6.0-8.fc40.x86_64
`;

const dnf5_security = `Name                 Type     Severity  Package                    Issued
FEDORA-2024-1a2b3c4d security Moderate  curl-8.6.0-8.fc40.x86_64   2024-05-01 00:00:00
`;

const rpm_installed = "bash.x86_64 5.2.26-1.fc40\ncurl.x86_64 8.6.0-7.fc40\n";

const pacman = "linux 6.10.1.arch1-1 -> 6.10.2.arch1-1\nopenssl 3.3.1-1 -> 3.3.2-1\nvim 9.1-1 -> 9.1-2 [ignored]\n";

function output(manager: string, { updates = "", security = "", installed = "", rc = "0", source = "", nixos = false } = {}): string {
  const header = `manager=${manager}\nsource=${source}\nrc=${rc}\n` + (nixos ? "nixos=1\n" : "");
  return `${header}${SCRIPT_SEP}\n${updates}\n${SCRIPT_SEP}\n${security}\n${SCRIPT_SEP}\n${installed}\n`;
}

const updates_monitor = (extra: PluginConfig = {}): PackageUpdates => make_plugin(PackageUpdates, { ...config, ...extra });
const run = (plugin: PackageUpdates, stdout: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const packages_of = (result: { snapshot: unknown }) => (result.snapshot as { packages: PackageUpdate[] }).packages;
const by_name = (packages: PackageUpdate[]) => Object.fromEntries(packages.map((each) => [each.name, each]));
const latest_status = (plugin: PackageUpdates) => store_of(plugin).latest_status("test-updates");
const latest_metric = (plugin: PackageUpdates, name: string) => store_of(plugin).latest_metric("test-updates", name)?.value ?? null;

describe("parsers", () => {
  it("flags security origins in apt list", () => {
    const packages = by_name(parse_apt(apt_list));
    expect(new Set(Object.keys(packages))).toEqual(new Set(["bash", "libssl3", "openssl"]));
    expect(packages.bash).toEqual({ name: "bash", current: "5.1-6ubuntu1", new: "5.1-6ubuntu1.1", security: false, origin: "jammy-updates" });
    expect(packages.libssl3.security).toBe(true);
    expect(packages.openssl.security).toBe(true);
  });

  it("reads apt simulation lines", () => {
    const packages = by_name(parse_apt(apt_sim));
    expect(new Set(Object.keys(packages))).toEqual(new Set(["libc6", "linux-image-6.1.0-26-amd64"]));
    expect(packages.libc6.current).toBe("2.36-9+deb12u7");
    expect(packages.libc6.security).toBe(true);
    expect(packages["linux-image-6.1.0-26-amd64"].current).toBe("");
    expect(packages["linux-image-6.1.0-26-amd64"].security).toBe(false);
  });

  it("joins dnf versions and security", () => {
    const packages = by_name(parse_dnf(dnf_updates, dnf_security, rpm_installed));
    expect(new Set(Object.keys(packages))).toEqual(new Set(["bash", "curl", "texlive-collection-latexrecommended"]));
    expect(packages.curl.security).toBe(true);
    expect(packages.bash.security).toBe(false);
    expect(packages.curl.current).toBe("8.6.0-7.fc40");
    expect(packages["texlive-collection-latexrecommended"].new).toBe("11:svn65512-1.fc40");
  });

  it("reads the dnf5 advisory table", () => {
    expect(by_name(parse_dnf(dnf_updates, dnf5_security, "")).curl.security).toBe(true);
  });

  it("reads pacman with arch-audit", () => {
    const packages = by_name(parse_pacman(pacman, "openssl\n"));
    expect(packages.linux.current).toBe("6.10.1.arch1-1");
    expect(packages.openssl.security).toBe(true);
    expect(packages.linux.security).toBe(false);
    expect(packages.vim.origin).toBe("ignored");
  });

  it("reads arch-audit's sentence form", () => {
    const audit = "Package openssl is affected by CVE-2024-0001. Update to 3.3.2-1!\n";
    expect(parse_pacman(pacman, audit).filter((each) => each.security).map((each) => each.name)).toEqual(["openssl"]);
  });
});

describe("collection", () => {
  it("counts apt updates and warns on security", () => {
    const plugin = updates_monitor();
    const result = run(plugin, output("apt", { updates: apt_list, source: "apt list --upgradable" }));
    expect(latest_metric(plugin, "updates_pending")).toBe(3.0);
    expect(latest_metric(plugin, "security_updates_pending")).toBe(2.0);
    expect(latest_status(plugin)).toBe("warning");
    expect(result.logs[0][0]).toContain("libssl3");
    expect(packages_of(result).map((each) => each.name).slice(0, 2)).toEqual(["libssl3", "openssl"]);
  });

  it("calls no updates online", () => {
    const plugin = updates_monitor();
    run(plugin, output("apt", { updates: "Listing... Done" }));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "updates_pending")).toBe(0.0);
  });

  it("calls plain updates online by default", () => {
    const plugin = updates_monitor();
    run(plugin, output("pacman", { updates: "linux 1-1 -> 1-2", rc: "0" }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("ranks the update count against its thresholds", () => {
    const plugin = updates_monitor({ warning: 2, threshold: 3, security_warning: null });
    run(plugin, output("pacman", { updates: pacman, rc: "0" }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails past the security threshold", () => {
    const plugin = updates_monitor({ security_threshold: 2 });
    run(plugin, output("apt", { updates: apt_list }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("lets the security warning be turned off", () => {
    const plugin = updates_monitor({ security_warning: null });
    run(plugin, output("apt", { updates: apt_list }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("reads dnf exit 100 as updates", () => {
    const plugin = updates_monitor();
    run(plugin, output("dnf", { updates: dnf_updates, security: dnf_security, installed: rpm_installed, rc: "100" }));
    expect(latest_metric(plugin, "updates_pending")).toBe(3.0);
    expect(latest_metric(plugin, "security_updates_pending")).toBe(1.0);
  });

  it("calls dnf without a cache unavailable", () => {
    const plugin = updates_monitor();
    const result = run(plugin, output("dnf", { updates: "Error: Cache-only enabled but no cache for 'fedora'", rc: "1" }));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("no cache");
  });

  it("reads checkupdates exit 2 as none", () => {
    const plugin = updates_monitor();
    run(plugin, output("pacman", { rc: "2", source: "checkupdates" }));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "updates_pending")).toBe(0.0);
  });

  it("calls no manager unavailable", () => {
    const plugin = updates_monitor();
    const result = run(plugin, output(""));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("No supported package manager");
  });

  it("points nixos at nixos_upgrade", () => {
    const plugin = updates_monitor();
    const result = run(plugin, output("", { nixos: true }));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("nixos_upgrade");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = updates_monitor();
    run(plugin, "", -1, "connection refused");
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("config", () => {
  it("has hourly polls, auto-detection and a security warning by default", () => {
    const plugin = updates_monitor();
    expect(new PackageUpdates("updates", { name: "updates" }).interval).toBe(3600);
    expect(plugin.manager).toBeNull();
    expect(plugin.security_warning).toBe(1.0);
    expect(plugin.warning).toBeNull();
  });

  it("quotes a manager override into the script", () => {
    const plugin = updates_monitor({ manager: "DNF", interval: 600 });
    expect(plugin.manager).toBe("dnf");
    expect(plugin.interval).toBe(600);
    expect(plugin.commands()[0].text.startsWith("m=dnf\n")).toBe(true);
  });

  it("auto-detects past an unknown manager", () => {
    expect(updates_monitor({ manager: "zypper" }).commands()[0].text.startsWith("m=''\n")).toBe(true);
  });
});

describe("cards", () => {
  it("builds rows and colors", () => {
    const plugin = updates_monitor();
    expect(plugin.manager_text).toBe("Detecting...");
    run(plugin, output("apt", { updates: apt_list }));
    expect(plugin.manager_text).toBe("apt");
    const rows = plugin.package_rows;
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    const security = rows.filter((row) => row.security);
    expect(plugin.security_cell(security[0])).toBe("warning");
    expect(plugin.security_cell(rows.at(-1)!)).toBeNull();
    expect(plugin.security_color(0)).toBe("online");
    expect(plugin.security_color(1)).toBe("warning");
    expect(plugin.updates_color(100)).toBe("online");
  });
});

// Runs the real probe script against stub package managers.
describe.skipIf(spawnSync("sh", ["-c", "true"]).status !== 0)("script", () => {
  let bin_dir = "";

  beforeEach(() => {
    bin_dir = mkdtempSync(join(tmpdir(), "x-monitor-updates-"));
  });

  afterEach(() => {
    rmSync(bin_dir, { recursive: true, force: true });
  });

  function stub(name: string, body: string): void {
    const path = join(bin_dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function probe(manager: string | null = null): string {
    return spawnSync("sh", ["-c", probe_script(manager)], { encoding: "utf8", env: { ...process.env, PATH: `${bin_dir}:${process.env.PATH ?? ""}` } }).stdout;
  }

  it("reads apt", () => {
    stub("apt-get", "exit 0");
    stub("apt", `cat <<'EOF'\n${apt_list}EOF`);
    const stdout = probe();
    expect(stdout.startsWith("manager=apt\nsource=apt list --upgradable\nrc=0\n")).toBe(true);
    const plugin = updates_monitor();
    run(plugin, stdout);
    expect(latest_metric(plugin, "security_updates_pending")).toBe(2.0);
  });

  it("reads rpm for dnf's current versions", () => {
    stub("dnf", `case "$*" in *updateinfo*) cat <<'EOF'\n${dnf_security}EOF\n;;\n*) cat <<'EOF'\n${dnf_updates}EOF\nexit 100;;\nesac`);
    stub("rpm", 'shift 3; for n in "$@"; do echo "$n 0.1-1"; done');
    const stdout = probe("dnf");
    expect(stdout).toContain("rc=100");
    const currents = Object.fromEntries(packages_of(run(updates_monitor(), stdout)).map((each) => [each.name, each.current]));
    expect(currents.bash).toBe("0.1-1");
    expect(currents["texlive-collection-latexrecommended"]).toBe("0.1-1");
  });

  it("falls back to pacman -Qu when checkupdates errors", () => {
    stub("checkupdates", "echo 'cannot fetch' >&2; exit 1");
    stub("pacman", `cat <<'EOF'\n${pacman}EOF`);
    const stdout = probe("pacman");
    expect(stdout).toContain("source=pacman -Qu");
    const plugin = updates_monitor();
    run(plugin, stdout);
    expect(latest_metric(plugin, "updates_pending")).toBe(3.0);
  });
});
