// Network interface inventory: every interface's operstate, carrier, MAC, MTU, speed and IPv4/IPv6 addresses, from
// `ip -j addr` and /sys/class/net (falling back to plain `ip addr` when ip has no JSON output). An interface listed in
// expect_up that is missing, down or without carrier is failed; one whose addresses changed since the previous cycle (a
// new DHCP lease, a new IPv6 prefix) is warning for that cycle and logs the old and new addresses. Temporary IPv6
// privacy addresses rotate by design and are left out of that comparison. Config: include, exclude, include_loopback,
// expect_up.

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, TableSpec } from "../shared/ui_spec.ts";
import { SCRIPT_SEP, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { fnmatch, int_or_null, split_lines, split_words } from "./base/text_parsing.ts";

// The kernel's ARPHRD_LOOPBACK link type, as /sys/class/net/<if>/type reports it.
const loopback_type = "772";

const text_link_pattern = /^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>(.*)$/;
const text_addr_pattern = /^\s+(inet6?)\s+(\S+)(.*)$/;
const text_mac_pattern = /^\s+link\/(\S+)\s+(\S+)/;

// One interface as the snapshot keeps it.
export interface NetworkInterface {
  name: string;
  state: string;
  carrier: boolean | null;
  mac: string;
  mtu: number | null;
  speed: number | null;
  loopback: boolean;
  ipv4: string[];
  ipv6: string[];
  ipv6_temporary: string[];
  up?: boolean;
  expected?: boolean;
}

type InterfaceMap = Map<string, NetworkInterface>;

// ── Probe ────────────────────────────────────────────────────────────────────

// One script printing `ip -j addr`, plain `ip addr` when JSON is unsupported, and each interface's sysfs facts.
export function probe_script(): string {
  return [
    'j=$(ip -j addr show 2>/dev/null) || j=""',
    'case "$j" in "["*) ;; *) j="" ;; esac',
    "printf '%s\\n' \"$j\"",
    `echo "${SCRIPT_SEP}"`,
    'if [ -z "$j" ]; then ip addr show 2>/dev/null; fi',
    `echo "${SCRIPT_SEP}"`,
    "for d in /sys/class/net/*; do",
    '  [ -e "$d" ] || continue',
    "  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"${d##*/}\" " +
      '"$(cat "$d/operstate" 2>/dev/null)" "$(cat "$d/carrier" 2>/dev/null)" ' +
      '"$(cat "$d/mtu" 2>/dev/null)" "$(cat "$d/address" 2>/dev/null)" ' +
      '"$(cat "$d/speed" 2>/dev/null)" "$(cat "$d/type" 2>/dev/null)"',
    "done",
  ].join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function blank(name: string): NetworkInterface {
  return { name, state: "unknown", carrier: null, mac: "", mtu: null, speed: null, loopback: false, ipv4: [], ipv6: [], ipv6_temporary: [] };
}

function to_int(value: unknown): number | null {
  return value === null || value === undefined ? null : int_or_null(value);
}

// One interface per tab-separated sysfs line: name, operstate, carrier, mtu, address, speed, type.
export function parse_sysfs(text: string): InterfaceMap {
  const interfaces: InterfaceMap = new Map();
  for (const line of split_lines(text)) {
    const fields = line.split("\t");
    if (fields.length < 7 || !fields[0]) continue;
    const [name, state, carrier, mtu, mac, speed, link_type] = fields;
    const entry = blank(name);
    entry.state = state.trim().toLowerCase() || "unknown";
    entry.carrier = carrier.trim() === "1" ? true : carrier.trim() === "0" ? false : null;
    entry.mtu = to_int(mtu);
    entry.mac = mac.trim();
    const speed_value = to_int(speed);
    entry.speed = speed_value !== null && speed_value > 0 ? speed_value : null;
    entry.loopback = link_type.trim() === loopback_type;
    interfaces.set(name, entry);
  }
  return interfaces;
}

function add_address(entry: NetworkInterface, family: string, address: string, temporary: boolean): void {
  if (family === "inet") entry.ipv4.push(address);
  else if (temporary) entry.ipv6_temporary.push(address);
  else entry.ipv6.push(address);
}

// Interfaces from `ip -j addr show`.
export function parse_ip_json(text: string): InterfaceMap {
  let links: unknown;
  try {
    links = JSON.parse(text);
  } catch {
    return new Map();
  }
  const interfaces: InterfaceMap = new Map();
  for (const raw of Array.isArray(links) ? links : []) {
    const link = raw as Record<string, unknown>;
    const name = link.ifname as string | undefined;
    if (!name) continue;
    const entry = blank(name);
    const flags = (link.flags as string[] | null | undefined) || [];
    entry.state = String(link.operstate || "unknown").toLowerCase();
    entry.carrier = flags.includes("LOWER_UP");
    entry.mtu = to_int(link.mtu);
    entry.mac = (link.address as string | undefined) || "";
    entry.loopback = link.link_type === "loopback" || flags.includes("LOOPBACK");
    for (const raw_info of (link.addr_info as Record<string, unknown>[] | null | undefined) || []) {
      const local = raw_info.local;
      const prefix = raw_info.prefixlen;
      if (!local) continue;
      const address = prefix !== null && prefix !== undefined ? `${String(local)}/${String(prefix)}` : String(local);
      add_address(entry, String(raw_info.family ?? ""), address, Boolean(raw_info.temporary));
    }
    interfaces.set(name, entry);
  }
  return interfaces;
}

// Interfaces from plain `ip addr show`, for an ip without JSON output.
export function parse_ip_text(text: string): InterfaceMap {
  const interfaces: InterfaceMap = new Map();
  let current: NetworkInterface | null = null;
  for (const line of split_lines(text)) {
    const link = text_link_pattern.exec(line);
    if (link) {
      const [, name, raw_flags, rest] = link;
      const flags = raw_flags.split(",");
      current = blank(name);
      interfaces.set(name, current);
      const state = /\bstate (\S+)/.exec(rest);
      const mtu = /\bmtu (\d+)/.exec(rest);
      current.state = state ? state[1].toLowerCase() : "unknown";
      current.mtu = mtu ? to_int(mtu[1]) : null;
      current.carrier = flags.includes("LOWER_UP");
      current.loopback = flags.includes("LOOPBACK");
      continue;
    }
    if (current === null) continue;
    const address = text_addr_pattern.exec(line);
    if (address) {
      add_address(current, address[1], address[2], split_words(address[3]).includes("temporary"));
      continue;
    }
    const mac = text_mac_pattern.exec(line);
    if (mac && mac[1] !== "none") current.mac = mac[2];
  }
  return interfaces;
}

// sysfs's state, carrier and speed with ip's addresses, over the union of both lists.
export function merge(sysfs: InterfaceMap, ip: InterfaceMap): InterfaceMap {
  const merged: InterfaceMap = new Map();
  for (const name of [...sysfs.keys(), ...[...ip.keys()].filter((key) => !sysfs.has(key))]) {
    const base: NetworkInterface = { ...(sysfs.get(name) ?? ip.get(name)!) };
    const extra = ip.get(name);
    if (extra !== undefined) {
      base.ipv4 = extra.ipv4;
      base.ipv6 = extra.ipv6;
      base.ipv6_temporary = extra.ipv6_temporary;
      base.mac = base.mac || extra.mac;
      base.mtu = base.mtu !== null ? base.mtu : extra.mtu;
      base.loopback = base.loopback || extra.loopback;
      if (base.carrier === null) base.carrier = extra.carrier;
    }
    merged.set(name, base);
  }
  return merged;
}

// Up and passing traffic: operstate up, or unknown (tunnels, loopback) with a carrier.
export function is_up(entry: { state: string; carrier: boolean | null }): boolean {
  return entry.state === "up" || (entry.state === "unknown" && entry.carrier === true);
}

function address_set(entry: NetworkInterface): Set<string> {
  return new Set([...entry.ipv4, ...entry.ipv6]);
}

function safe(name: string): string {
  return [...name.toLowerCase()].map((character) => (/^[\p{L}\p{N}]$/u.test(character) ? character : "_")).join("").replace(/^_+|_+$/g, "") || "iface";
}

function describe_addresses(addresses: Set<string>): string {
  return [...addresses].sort().join(", ") || "none";
}

function same_set(first: Set<string>, second: Set<string>): boolean {
  return first.size === second.size && [...first].every((item) => second.has(item));
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// The host's network interfaces with their link state and addressing, failing when an interface it must have is down
// and warning when one's addresses change.
export class Interfaces extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly include: string[];
  readonly exclude: string[];
  readonly include_loopback: boolean;
  readonly expect_up: string[];
  // The last non-empty address set of each expected interface, so a link that drops and returns unchanged is no change.
  private readonly addresses = new Map<string, Set<string>>();

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.include = [...((config.include as string[] | null | undefined) || [])];
    this.exclude = [...((config.exclude as string[] | null | undefined) || [])];
    this.include_loopback = Boolean(config.include_loopback ?? false);
    this.expect_up = [...((config.expect_up as string[] | null | undefined) || [])];
  }

  override commands(): Command[] {
    return [command(probe_script())];
  }

  private shown(entry: NetworkInterface): boolean {
    if (entry.loopback && !this.include_loopback) return false;
    if (this.include.length > 0 && !this.include.some((pattern) => fnmatch(entry.name, pattern))) return false;
    return !this.exclude.some((pattern) => fnmatch(entry.name, pattern));
  }

  override parse(results: CmdResult[]): CollectResult {
    const { stdout, stderr } = results[0];
    if (!stdout.includes(SCRIPT_SEP)) return CollectResult.unavailable(`Could not list network interfaces: ${(stderr || stdout).trim().slice(0, 200)}`);

    const parts = stdout.split(SCRIPT_SEP);
    while (parts.length < 3) parts.push("");
    const ip = parts[0].trim() ? parse_ip_json(parts[0].trim()) : parse_ip_text(parts[1]);
    const interfaces = merge(parse_sysfs(parts[2]), ip);
    if (interfaces.size === 0) return CollectResult.unavailable("No network interfaces found in /sys/class/net or `ip addr`");

    const accumulator = new StatusAccumulator();
    const logs: LogEntry[] = [];
    const metrics: Record<string, number> = {};
    for (const name of this.expect_up) this.check_expected(name, interfaces.get(name) ?? null, accumulator, logs, metrics);

    const shown = [...interfaces.values()].filter((entry) => this.shown(entry) || this.expect_up.includes(entry.name));
    const up = shown.filter(is_up).length;
    metrics.interfaces_up = up;
    metrics.interfaces_total = shown.length;

    let summary = `${up}/${shown.length} interface(s) up`;
    if (accumulator.problems.length > 0) summary += `; ${accumulator.problems.join("; ")}`;
    logs.unshift([summary, accumulator.log_level]);

    const expected = new Set(this.expect_up);
    const rows = [...shown]
      .sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0))
      .map((entry) => ({ ...entry, up: is_up(entry), expected: expected.has(entry.name) }));
    return new CollectResult({ metrics, logs, status: accumulator.status, snapshot: rows });
  }

  // Fails an expected interface that is missing or down, and warns when its addresses changed.
  private check_expected(name: string, entry: NetworkInterface | null, accumulator: StatusAccumulator, logs: LogEntry[], metrics: Record<string, number>): void {
    metrics[`interface_${safe(name)}_up`] = entry !== null && is_up(entry) ? 1 : 0;
    if (entry === null) {
      accumulator.escalate("failed", `${name} is missing`);
      return;
    }
    if (!is_up(entry)) {
      const why = entry.carrier === false ? "has no carrier" : `is ${entry.state}`;
      accumulator.escalate("failed", `${name} ${why}`);
      return;
    }
    const addresses = address_set(entry);
    if (addresses.size === 0) return;
    const previous = this.addresses.get(name);
    this.addresses.set(name, addresses);
    if (previous !== undefined && !same_set(previous, addresses)) {
      accumulator.escalate("warning", `${name} addresses changed`);
      logs.push([`${name} addresses changed: ${describe_addresses(previous)} -> ${describe_addresses(addresses)}`, log_level_of("warning")]);
    }
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get interface_rows(): Record<string, unknown>[] {
    const snapshot = this.data ? this.data.latest_snapshot<Partial<NetworkInterface>[]>([]) : [];
    return (Array.isArray(snapshot) ? snapshot : []).map((entry) => {
      const speed = entry.speed;
      const carrier = entry.carrier;
      return {
        name: entry.name ?? "",
        state: entry.state ?? "",
        carrier: carrier === null || carrier === undefined ? "--" : carrier ? "yes" : "no",
        mac: entry.mac || "--",
        mtu: entry.mtu !== null && entry.mtu !== undefined ? entry.mtu : "--",
        speed: speed ? `${speed} Mb/s` : "--",
        ipv4: (entry.ipv4 || []).join(", ") || "--",
        ipv6: [...(entry.ipv6 || []), ...(entry.ipv6_temporary || [])].join(", ") || "--",
        up: Boolean(entry.up),
        expected: Boolean(entry.expected),
      };
    });
  }

  // An expected interface's state cell; others are shown as they are.
  static state_color(row: Record<string, unknown>): Status | null {
    if (!row.expected) return null;
    return row.up ? "online" : "failed";
  }

  private expected_counts(): [up: number, total: number] | null {
    if (this.expect_up.length === 0) return null;
    const values = this.expect_up.map((name) => this.data.latest_metric(`interface_${safe(name)}_up`)).filter((metric) => metric !== null).map((metric) => metric.value);
    if (values.length === 0) return null;
    return [values.filter((value) => value >= 1).length, values.length];
  }

  get expected_text(): string {
    const counts = this.expected_counts();
    if (counts === null) return this.expect_up.length > 0 ? "--" : "NONE SET";
    return `${counts[0]}/${counts[1]} UP`;
  }

  get expected_color(): Status | null {
    const counts = this.expected_counts();
    if (counts === null) return null;
    return counts[0] === counts[1] ? "online" : "failed";
  }

  override cards(): Record<string, CardSpec> {
    return {
      up_card: { metric: "interfaces_up", title: "UP", format: "int" },
      total_card: { metric: "interfaces_total", title: "INTERFACES", format: "int" },
      expected_card: { title: "EXPECTED UP", value_attr: "expected_text", color_attr: "expected_color", refresh: true },
    };
  }

  override tables(): Record<string, TableSpec> {
    return {
      interfaces: {
        row_key: "name",
        rows_attr: "interface_rows",
        columns: [
          { name: "name", label: "Interface", field: "name", sortable: true, align: "left" },
          { name: "state", label: "State", field: "state", sortable: true, align: "left", cell_color_by: Interfaces.state_color },
          { name: "carrier", label: "Carrier", field: "carrier", align: "left" },
          { name: "ipv4", label: "IPv4", field: "ipv4", align: "left" },
          { name: "ipv6", label: "IPv6", field: "ipv6", align: "left" },
          { name: "mac", label: "MAC", field: "mac", align: "left" },
          { name: "mtu", label: "MTU", field: "mtu", align: "right" },
          { name: "speed", label: "Speed", field: "speed", align: "right" },
        ],
      },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return { up_chart: { metric: "interfaces_up", title: "INTERFACES UP" } };
  }
}
