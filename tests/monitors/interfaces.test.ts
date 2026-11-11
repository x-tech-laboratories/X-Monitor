import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { SCRIPT_SEP, type PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Interfaces, is_up, merge, parse_ip_json, parse_ip_text, parse_sysfs, probe_script, type NetworkInterface } from "../../src/monitors/interfaces.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-ifaces", id: "test-ifaces", ssh_config: { host: "test.host" } };

interface Link {
  ifname: string;
  flags: string[];
  mtu: number;
  operstate: string;
  link_type: string;
  address: string;
  addr_info: Record<string, unknown>[];
}

function link(name: string, { operstate = "UP", flags = ["BROADCAST", "UP", "LOWER_UP"], mac = "52:54:00:00:00:01", addrs = [] as Record<string, unknown>[], link_type = "ether", mtu = 1500 } = {}): Link {
  return { ifname: name, flags: [...flags], mtu, operstate, link_type, address: mac, addr_info: addrs.map((each) => ({ ...each })) };
}

const v4 = (address: string, prefix = 24) => ({ family: "inet", local: address, prefixlen: prefix });
const v6 = (address: string, prefix = 64, temporary = false) => ({ family: "inet6", local: address, prefixlen: prefix, ...(temporary ? { temporary: true } : {}) });

const lo = link("lo", { operstate: "UNKNOWN", flags: ["LOOPBACK", "UP", "LOWER_UP"], mac: "00:00:00:00:00:00", addrs: [v4("127.0.0.1", 8), v6("::1", 128)], link_type: "loopback", mtu: 65536 });

function sysfs_line(name: string, { state = "up", carrier = "1", mtu = "1500", mac = "52:54:00:00:00:01", speed = "1000", link_type = "1" } = {}): string {
  return [name, state, carrier, mtu, mac, speed, link_type].join("\t");
}

function output(links: Link[] | null, { sysfs = null as string[] | null, text = "" } = {}): string {
  const ip_json = links !== null ? JSON.stringify(links) : "";
  let lines = sysfs;
  if (lines === null) {
    lines = [sysfs_line("lo", { state: "unknown", carrier: "1", mtu: "65536", mac: "00:00:00:00:00:00", speed: "", link_type: "772" })];
    for (const each of links ?? []) {
      if (each.ifname === "lo") continue;
      lines.push(sysfs_line(each.ifname, { state: each.operstate.toLowerCase(), carrier: each.flags.includes("LOWER_UP") ? "1" : "0", mac: each.address }));
    }
  }
  return `${ip_json}\n${SCRIPT_SEP}\n${text}\n${SCRIPT_SEP}\n` + lines.join("\n") + "\n";
}

function eth0({ address = "192.0.2.10", operstate = "UP", lower_up = true, extra = [] as Record<string, unknown>[] } = {}): Link {
  const flags = lower_up ? ["BROADCAST", "UP", "LOWER_UP"] : ["NO-CARRIER", "BROADCAST", "UP"];
  return link("eth0", { operstate, flags, addrs: [v4(address), v6("fe80::1"), ...extra] });
}

const text = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host
2: eth0@if7: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default
    link/ether 52:54:00:00:00:01 brd ff:ff:ff:ff:ff:ff
    inet 192.0.2.10/24 brd 192.0.2.255 scope global dynamic eth0
    inet6 2001:db8::1234/64 scope global temporary dynamic
    inet6 2001:db8::1/64 scope global dynamic mngtmpaddr
3: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN group default
    link/none
    inet 10.0.0.2/24 scope global wg0
4: eth1: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc fq_codel state DOWN group default
    link/ether 52:54:00:00:00:02 brd ff:ff:ff:ff:ff:ff
`;

const interfaces = (extra: PluginConfig = {}): Interfaces => make_plugin(Interfaces, { ...config, ...extra });
const expecting = (): Interfaces => interfaces({ expect_up: ["eth0"] });
const run = (plugin: Interfaces, stdout: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const rows_of = (result: { snapshot: unknown }) => result.snapshot as NetworkInterface[];
const latest_status = (plugin: Interfaces) => store_of(plugin).latest_status("test-ifaces");
const latest_metric = (plugin: Interfaces, name: string) => store_of(plugin).latest_metric("test-ifaces", name)?.value ?? null;

describe("parsers", () => {
  it("reads ip json", () => {
    const parsed = parse_ip_json(JSON.stringify([lo, eth0({ extra: [v6("2001:db8::99", 64, true)] })]));
    expect(parsed.get("lo")!.loopback).toBe(true);
    const entry = parsed.get("eth0")!;
    expect(entry.ipv4).toEqual(["192.0.2.10/24"]);
    expect(entry.ipv6).toEqual(["fe80::1/64"]);
    expect(entry.ipv6_temporary).toEqual(["2001:db8::99/64"]);
    expect(entry.carrier).toBe(true);
    expect(entry.state).toBe("up");
  });

  it("reads garbage json as empty", () => expect(parse_ip_json("not json").size).toBe(0));

  it("reads ip text", () => {
    const parsed = parse_ip_text(text);
    expect(new Set(parsed.keys())).toEqual(new Set(["lo", "eth0", "wg0", "eth1"]));
    expect(parsed.get("eth0")!.ipv4).toEqual(["192.0.2.10/24"]);
    expect(parsed.get("eth0")!.ipv6).toEqual(["2001:db8::1/64"]);
    expect(parsed.get("eth0")!.ipv6_temporary).toEqual(["2001:db8::1234/64"]);
    expect(parsed.get("eth0")!.mac).toBe("52:54:00:00:00:01");
    expect(parsed.get("wg0")!.mac).toBe("");
    expect(parsed.get("wg0")!.state).toBe("unknown");
    expect(parsed.get("eth1")!.carrier).toBe(false);
    expect(parsed.get("eth1")!.state).toBe("down");
    expect(parsed.get("lo")!.loopback).toBe(true);
  });

  it("reads sysfs", () => {
    const parsed = parse_sysfs(sysfs_line("eth0", { speed: "2500" }) + "\n" + sysfs_line("eth1", { state: "down", carrier: "", speed: "-1" }) + "\nbad line\n");
    expect(parsed.get("eth0")!.speed).toBe(2500);
    expect(parsed.get("eth0")!.carrier).toBe(true);
    expect(parsed.get("eth1")!.speed).toBeNull();
    expect(parsed.get("eth1")!.carrier).toBeNull();
  });

  it("prefers sysfs state and fills the carrier from ip", () => {
    const merged = merge(parse_sysfs(sysfs_line("eth1", { state: "down", carrier: "", speed: "" })), parse_ip_text(text));
    expect(merged.get("eth1")!.carrier).toBe(false);
    expect(merged.get("eth0")!.ipv4).toEqual(["192.0.2.10/24"]);
  });

  it("tells whether an interface is up", () => {
    expect(is_up({ state: "up", carrier: true })).toBe(true);
    expect(is_up({ state: "unknown", carrier: true })).toBe(true);
    expect(is_up({ state: "unknown", carrier: null })).toBe(false);
    expect(is_up({ state: "lowerlayerdown", carrier: false })).toBe(false);
  });
});

describe("inventory", () => {
  it("leaves loopback out of the counts by default", () => {
    const plugin = interfaces();
    const result = run(plugin, output([lo, eth0()]));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "interfaces_total")).toBe(1.0);
    expect(latest_metric(plugin, "interfaces_up")).toBe(1.0);
    expect(rows_of(result).map((row) => row.name)).toEqual(["eth0"]);
  });

  it("includes loopback when asked", () => {
    const plugin = interfaces({ include_loopback: true });
    run(plugin, output([lo, eth0()]));
    expect(latest_metric(plugin, "interfaces_total")).toBe(2.0);
  });

  it("applies include and exclude globs", () => {
    const plugin = interfaces({ include: ["eth*", "veth*"], exclude: ["veth*"] });
    const result = run(plugin, output([eth0(), link("eth1"), link("veth12ab"), link("docker0")]));
    expect(rows_of(result).map((row) => row.name)).toEqual(["eth0", "eth1"]);
  });

  it("counts a down interface without failing unless it is expected", () => {
    const plugin = interfaces();
    run(plugin, output([eth0({ operstate: "DOWN", lower_up: false })]));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "interfaces_up")).toBe(0.0);
  });

  it("falls back to ip text", () => {
    const plugin = interfaces();
    const result = run(plugin, output(null, { sysfs: [sysfs_line("eth0"), sysfs_line("wg0", { state: "unknown", carrier: "1", link_type: "65534" })], text }));
    const rows = Object.fromEntries(rows_of(result).map((row) => [row.name, row]));
    expect(rows.eth0.ipv4).toEqual(["192.0.2.10/24"]);
    expect(rows.eth1.up).toBe(false);
    expect(latest_metric(plugin, "interfaces_up")).toBe(2.0);
  });

  it("calls nothing found unavailable", () => {
    const plugin = interfaces();
    run(plugin, output(null, { sysfs: [] }));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = interfaces();
    run(plugin, "", -1, "connection refused");
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("expect up", () => {
  it("calls an expected interface that is up online", () => {
    const plugin = expecting();
    run(plugin, output([eth0()]));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "interface_eth0_up")).toBe(1.0);
  });

  it("fails an expected interface without carrier", () => {
    const plugin = expecting();
    const result = run(plugin, output([eth0({ operstate: "DOWN", lower_up: false })]));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[0][0]).toContain("eth0 has no carrier");
    expect(latest_metric(plugin, "interface_eth0_up")).toBe(0.0);
  });

  it("fails a missing expected interface", () => {
    const plugin = expecting();
    const result = run(plugin, output([link("eth1")]));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[0][0]).toContain("eth0 is missing");
  });

  it("shows an expected interface even when excluded", () => {
    const plugin = interfaces({ expect_up: ["eth0"], exclude: ["eth*"] });
    const result = run(plugin, output([eth0(), link("eth1")]));
    expect(rows_of(result).map((row) => row.name)).toEqual(["eth0"]);
    expect(rows_of(result)[0].expected).toBe(true);
  });

  it("warns once on an address change and logs both", () => {
    const plugin = expecting();
    run(plugin, output([eth0({ address: "192.0.2.10" })]));
    expect(latest_status(plugin)).toBe("online");
    const result = run(plugin, output([eth0({ address: "192.0.2.11" })]));
    expect(latest_status(plugin)).toBe("warning");
    const change = result.logs.map(([message]) => message).find((message) => message.includes("changed:"))!;
    expect(change).toContain("192.0.2.10/24");
    expect(change).toContain("192.0.2.11/24");
    run(plugin, output([eth0({ address: "192.0.2.11" })]));
    expect(latest_status(plugin)).toBe("online");
  });

  it("does not take temporary IPv6 rotation for a change", () => {
    const plugin = expecting();
    run(plugin, output([eth0({ extra: [v6("2001:db8::aa", 64, true)] })]));
    run(plugin, output([eth0({ extra: [v6("2001:db8::bb", 64, true)] })]));
    expect(latest_status(plugin)).toBe("online");
  });

  it("does not take a link bounce with the same address for a change", () => {
    const plugin = expecting();
    run(plugin, output([eth0()]));
    run(plugin, output([link("eth0", { operstate: "DOWN", flags: ["NO-CARRIER", "UP"] })]));
    expect(latest_status(plugin)).toBe("failed");
    run(plugin, output([eth0()]));
    expect(latest_status(plugin)).toBe("online");
  });

  it("ignores an address change on an unexpected interface", () => {
    const plugin = expecting();
    run(plugin, output([eth0(), link("eth1", { addrs: [v4("198.51.100.1")] })]));
    run(plugin, output([eth0(), link("eth1", { addrs: [v4("198.51.100.2")] })]));
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("cards", () => {
  it("builds rows and the expected card", () => {
    const plugin = expecting();
    expect(plugin.expected_text).toBe("--");
    run(plugin, output([eth0(), link("eth1", { operstate: "DOWN", flags: ["UP"] })]));
    const rows = Object.fromEntries(plugin.interface_rows.map((row) => [row.name, row]));
    expect(rows.eth0.ipv4).toBe("192.0.2.10/24");
    expect(rows.eth0.speed).toBe("1000 Mb/s");
    expect(Interfaces.state_color(rows.eth0)).toBe("online");
    expect(Interfaces.state_color(rows.eth1)).toBeNull();
    expect(plugin.expected_text).toBe("1/1 UP");
    expect(plugin.expected_color).toBe("online");
  });

  it("says when nothing is expected", () => {
    const plugin = interfaces();
    expect(plugin.expected_text).toBe("NONE SET");
    expect(plugin.expected_color).toBeNull();
  });
});

it.skipIf(spawnSync("sh", ["-c", "true"]).status !== 0)("runs the probe script on this host", () => {
  const stdout = spawnSync("sh", ["-c", probe_script()], { encoding: "utf8" }).stdout;
  expect(stdout.split(SCRIPT_SEP).length - 1).toBe(2);
});
