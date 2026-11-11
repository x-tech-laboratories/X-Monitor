// Runs the real dashboard on a homelab-shaped fleet fed with moving sample readings.
//
// The engine schedules every monitor as usual, but a cycle applies a sample reading for the monitor's type instead of
// collecting, so every widget has live data and nothing leaves the machine. Groups still fold their children's
// statuses the real way. A type with no sample here reports unavailable.
//
//     node dev/demo/sample.ts --config <rendered sample.yaml> --db <path> --port <port>

import { cmd_result, CollectResult, type DispatchResult } from "../../src/core/connectors/types.ts";
import { XMonitorEngine } from "../../src/core/coordination/engine.ts";
import { SCRIPT_SEP, level_for } from "../../src/monitors/base/plugin_helpers.ts";
import type { Plugin } from "../../src/monitors/base/plugin_base.ts";
import { process_tree, type ProcessEntry } from "../../src/monitors/processes.ts";
import { main as server_main } from "../../src/server/main.ts";

// ── Sample readings ──────────────────────────────────────────────────────────

// Metrics and a status, and for a monitor whose tiles read one, its snapshot list.
export type Reading = [metrics: Record<string, number>, status: string, snapshot?: unknown[]];

// The fields of a monitor a sample may read; each sample reads only those of its own type.
export type SampleMonitor = Plugin & Partial<{
  warning: number | null;
  threshold: number | null;
  cpu_warning: number | null;
  cpu_threshold: number | null;
  max_processes: number;
  max_age: number;
  checks: { metric: string }[];
}>;

// A number from 0 up to 1 fixed by the seed, so each monitor's jitter repeats run to run.
function seeded(seed: number): number {
  let state = (seed * 2654435761) >>> 0;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
}

// A slow sine around `base`, offset per monitor so no two lines move together, plus jitter.
export function wave(tick: number, seed: number, base: number, swing: number, noise = 0): number {
  const jitter = (seeded(seed * 7919 + tick) * 2 - 1) * noise;
  return Math.max(0, base + swing * Math.sin((tick + seed * 5) / 6) + jitter);
}

// The monitor's own warning and threshold verdict on a value, or online when it has none.
export function thresholds(plugin: SampleMonitor, value: number): string {
  const warning = plugin.warning ?? null;
  const threshold = plugin.threshold ?? null;
  if (warning === null || threshold === null) return "online";
  return level_for(value, warning, threshold);
}

// Whether a flaky monitor is in one of its short, regular outages.
function down_now(tick: number, seed: number, period = 37, length = 3): boolean {
  return (tick + seed * 11) % period < length;
}

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

function cpu(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const cores = range(8).map((core) => wave(tick, seed + core, 28 + (core === 3 ? 40 : 0), 14, 6));
  const value = cores.reduce((sum, pct) => sum + pct, 0) / cores.length;
  return [{ cpu_pct: value, cpu_core_max_pct: Math.max(...cores) }, thresholds(plugin, value),
    cores.map((pct, core) => ({ label: String(core), value: Math.min(pct, 100) }))];
}

function memory(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const value = wave(tick, seed, 58, 4, 1);
  return [{ memory_pct: value, memory_used_gb: (32 * value) / 100, memory_total_gb: 32 }, thresholds(plugin, value)];
}

function load(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const one = wave(tick, seed, 40, 15, 6);
  return [{ load_pct_1m: one, load_pct_5m: wave(tick, seed, 37, 6, 2), load_pct_15m: wave(tick, seed, 35, 2, 1) }, thresholds(plugin, one)];
}

function temperature(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const zones: Record<string, number> = { cpu: wave(tick, seed, 58, 6, 2), nvme: wave(tick, seed, 42, 2, 1), acpitz: 36, gpu: wave(tick, seed + 3, 70, 8, 2) };
  const hottest = Math.max(...Object.values(zones));
  const metrics: Record<string, number> = { temp_c: hottest };
  for (const [name, value] of Object.entries(zones)) metrics[`temp_zone_${name}`] = value;
  return [metrics, thresholds(plugin, hottest)];
}

function throughput(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  return [{ rx_kbps: wave(tick, seed, 2400, 1500, 600), tx_kbps: wave(tick, seed, 600, 300, 150) }, "online"];
}

function processes(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const entry = (pid: number, ppid: number, user: string, cpu_pct: number, mem: number, command: string): ProcessEntry =>
    ({ pid, ppid, user, cpu: Math.round(cpu_pct * 10) / 10, mem, command });
  const flat = [
    entry(1, 0, "root", 0.2, 0.1, "systemd"),
    entry(412, 1, "root", 0.0, 0.3, "sshd"),
    entry(5120, 412, "alice", 0.1, 0.1, "bash"),
    entry(5188, 5120, "alice", wave(tick, seed, 3, 2, 1), 0.2, "htop"),
    entry(880, 1, "root", wave(tick, seed, 4, 2, 1), 1.4, "nginx"),
    entry(881, 880, "nginx", wave(tick, seed + 1, 2, 1, 0.5), 0.6, "nginx"),
    entry(882, 880, "nginx", wave(tick, seed + 2, 2, 1, 0.5), 0.6, "nginx"),
    entry(1500, 1, "alice", wave(tick, seed, 6, 3, 1), 4.2, "firefox"),
    entry(1544, 1500, "alice", wave(tick, seed + 3, 30, 25, 5), 3.1, "Isolated Web Co"),
    entry(1560, 1500, "alice", wave(tick, seed + 4, 8, 6, 2), 2.4, "Isolated Web Co"),
    entry(1571, 1500, "alice", 0.3, 0.9, "RDD Process"),
    entry(2, 0, "root", 0.0, 0.0, "kthreadd"),
    entry(14, 2, "root", wave(tick, seed, 1, 1, 0.3), 0.0, "ksoftirqd/0"),
  ];
  const top = Math.max(...flat.map((process) => process.cpu));
  return [{ process_count: flat.length, top_cpu_pct: top }, level_for(top, plugin.cpu_warning ?? null, plugin.cpu_threshold ?? null),
    process_tree(flat, plugin.max_processes ?? 20)];
}

function connections(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const established = wave(tick, seed, 140, 25, 8);
  const time_wait = wave(tick, seed, 60, 18, 8);
  const total = established + time_wait + 38;
  return [{ conn_total: total, conn_established: established, conn_listen: 38, conn_time_wait: time_wait }, thresholds(plugin, total)];
}

function disk_io(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  return [{ read_kbps: wave(tick, seed, 1200, 800, 300), write_kbps: wave(tick, seed, 340, 150, 80) }, "online"];
}

function disk_space(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const used = wave(tick, seed, 45 + (seed % 40), 2, 0.5);
  return [{ used_pct: used, size_gb: 1800, avail_gb: 1800 * (1 - used / 100) }, thresholds(plugin, used)];
}

function filesystems(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const used: Record<string, number> = { root: 41, storage: wave(tick, seed, 84, 5, 1), boot: 33 };
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(used)) metrics[`fs_${key}_used_pct`] = value;
  for (const key of Object.keys(used)) metrics[`fs_${key}_inodes_pct`] = 4;
  return [metrics, thresholds(plugin, Math.max(...Object.values(used)))];
}

function zfs(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const usage: Record<string, number> = { storage: wave(tick, seed, 79, 4, 1), backup: 42 };
  const pools = Object.entries(usage).map(([label, value]) => ({ label, health: "ONLINE", usage: value }));
  const most = Math.max(...Object.values(usage));
  const metrics: Record<string, number> = { pools_total: 2, pools_ok: 2, pools_degraded: 0, zfs_usage_max: most };
  for (const [name, value] of Object.entries(usage)) metrics[`pool_usage_${name}`] = value;
  return [metrics, thresholds(plugin, most), pools];
}

function smart(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  const disks = ([["sda", 36, 21402], ["sdb", 37, 21398], ["nvme0n1", 41, 8120]] as const).map(([label, temp, hours], index) => ({
    label, health: "PASSED", temperature: wave(tick, seed + index, temp, 2, 1), power_on_hours: hours + tick / 720,
  }));
  return [{ disks_total: 3, disks_ok: 3, disks_failed: 0, disks_unknown: 0 }, "online", disks];
}

function uptime(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  const up = !down_now(tick, seed);
  return [{ up: up ? 1 : 0, latency_ms: wave(tick, seed, 21, 5, 3) }, up ? "online" : "failed"];
}

function http(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  const up = !down_now(tick, seed, 53);
  return [{ probe_ok: up ? 1 : 0, probe_latency_ms: wave(tick, seed, 60, 15, 8) }, up ? "online" : "failed"];
}

function ports(plugin: SampleMonitor, tick: number, seed: number): Reading {
  const metrics: Record<string, number> = {};
  let down = 0;
  (plugin.checks ?? []).forEach((check, index) => {
    const up = !down_now(tick, seed + index, 61, 2);
    if (!up) down++;
    metrics[`${check.metric}_up`] = up ? 1 : 0;
    metrics[`${check.metric}_latency_ms`] = wave(tick, seed + index, 40, 8, 4);
  });
  return [metrics, down ? "failed" : "online"];
}

function pihole(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  return [{
    block_rate_pct: wave(tick, seed, 18, 3, 1), queries_blocked: 7750 + 4 * tick, queries_forwarded: 28842 + 15 * tick,
    queries_cached: 5526 + 3 * tick, clients_active: 14, blocking_enabled: 1,
  }, "online"];
}

function unbound(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  return [{
    resolved_ok: 1, servfail_rate_pct: wave(tick, seed, 0.4, 0.3, 0.1), queries_total: 120000 + 30 * tick,
    cache_hit_rate_pct: wave(tick, seed, 87, 3, 1), uptime_seconds: 530000 + 5 * tick,
  }, "online"];
}

function containers(_plugin: SampleMonitor, tick: number): Reading {
  const stopped = Math.floor(tick / 20) % 2;
  const rows = [
    { name: "nginx", state: "running", image: "nginx:latest", update: "Update available", update_state: "available" },
    { name: "postgres", state: stopped ? "exited" : "running", image: "postgres:16", update: "Up to date", update_state: "current" },
    { name: "redis", state: "running", image: "redis:7", update: "Up to date", update_state: "current" },
    { name: "app", state: "running", image: "app:dev", update: "Local image", update_state: "local" },
  ];
  return [{ containers_total: 4, containers_running: 4 - stopped, containers_stopped: stopped, images_update_available: 1 }, stopped ? "warning" : "online", rows];
}

function syncthing(_plugin: SampleMonitor, tick: number, seed: number): Reading {
  const percent = ((tick + seed) % 30) * 10;
  const syncing = percent < 100;
  const folders = [
    { id: "docs", label: "Documents", state: "idle", caption: "up to date", status: "online" },
    { id: "photos", label: "Photos", state: syncing ? "syncing" : "idle", caption: syncing ? `syncing ${percent}%` : "up to date", status: syncing ? "info" : "online" },
    { id: "music", label: "Music", state: "idle", caption: "up to date", status: "online" },
  ];
  const need = syncing ? (100 - percent) * 4e6 : 0;
  return [{ folders_total: 3, folders_errored: 0, folders_stalled: 0, need_bytes: need, pull_errors: 0, devices_expected: 2, devices_disconnected: 0 },
    syncing ? "info" : "online", folders];
}

function borg(plugin: SampleMonitor, _tick: number, seed: number): Reading {
  // One repository in five has missed its window, so the backups panel shows a late one.
  const late = seed % 5 === 0;
  const max_age = plugin.max_age ?? 86400;
  const age = max_age * (late ? 1.4 : 0.25 + (seed % 3) * 0.15);
  return [{ last_backup_epoch: Date.now() / 1000 - age, archive_count: 30 + (seed % 20), deduplicated_size: 400 + seed * 10, dedup_ratio: 2.4 }, late ? "failed" : "online"];
}

function nixos_upgrade(_plugin: SampleMonitor, _tick: number, seed: number): Reading {
  const drifting = seed % 4 === 1;
  const reboot = seed % 4 === 2;
  return [{ generation: 800 + seed * 3, up_to_date: drifting ? 0 : 1, reboot_required: reboot ? 1 : 0, last_switch_epoch: Date.now() / 1000 - 86400 * (seed % 6) },
    drifting || reboot ? "warning" : "online"];
}

function vuln_scan(_plugin: SampleMonitor, _tick: number, seed: number): Reading {
  const vulnerable = seed % 3 === 0 ? 1 : 0;
  const suspected = seed % 3;
  const status = vulnerable ? "failed" : suspected ? "warning" : "online";
  return [{ vulnerable, suspected, noted: 2 + (seed % 8), open_ports: 3 + (seed % 12) }, status];
}

// ── Parsed samples ───────────────────────────────────────────────────────────

// The monitor's own parse of canned command output, one string per command it runs.
function parsed(plugin: Plugin, ...outputs: string[]): CollectResult {
  return plugin.parse(outputs.map((output) => cmd_result(0, output, "")));
}

function package_updates(plugin: Plugin): CollectResult {
  const updates = "Listing... Done\n" +
    "bash/stable 5.2.15-2+b7 amd64 [upgradable from: 5.2.15-2+b2]\n" +
    "openssl/stable-security 3.0.14-1~deb12u2 amd64 [upgradable from: 3.0.13-1~deb12u1]\n";
  return parsed(plugin, `manager=apt\nsource=\nrc=0\n${SCRIPT_SEP}\n${updates}\n${SCRIPT_SEP}\n\n${SCRIPT_SEP}\n\n`);
}

function reboot_required(plugin: Plugin): CollectResult {
  return parsed(plugin, "kernel=6.1.0-25-amd64\ndebian=1\ndebian_flag=1\ndebian_pkg=linux-image-6.1.0-26-amd64\ndebian_pkg=libc6\nmodules=present\n");
}

function interfaces(plugin: Plugin): CollectResult {
  const link = (ifname: string, address: string, addr_info: unknown[], operstate = "UP", link_type = "ether") =>
    ({ ifname, flags: ["BROADCAST", "UP", "LOWER_UP"], mtu: 1500, operstate, link_type, address, addr_info });
  const links = [
    link("lo", "00:00:00:00:00:00", [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }], "UNKNOWN", "loopback"),
    link("eth0", "52:54:00:00:00:01", [{ family: "inet", local: "192.0.2.10", prefixlen: 24 }, { family: "inet6", local: "fe80::1", prefixlen: 64 }]),
    link("docker0", "02:42:00:00:00:01", [{ family: "inet", local: "172.17.0.1", prefixlen: 16 }]),
  ];
  const sysfs = ["lo\tunknown\t1\t65536\t00:00:00:00:00:00\t\t772", "eth0\tup\t1\t1500\t52:54:00:00:00:01\t1000\t1", "docker0\tup\t1\t1500\t02:42:00:00:00:01\t\t1"];
  return parsed(plugin, `${JSON.stringify(links)}\n${SCRIPT_SEP}\n\n${SCRIPT_SEP}\n${sysfs.join("\n")}\n`);
}

function sessions(plugin: Plugin): CollectResult {
  const block = (sid: string, user: string, host = "", tty = "pts/0", seat = "", kind = "tty", service = "sshd"): string =>
    `Id=${sid}\nName=${user}\nTimestamp=Thu 2026-09-24 10:00:00 UTC\nSeat=${seat}\nTTY=${tty}\n` +
    `Remote=${host ? "yes" : "no"}\nRemoteHost=${host}\nRemoteUser=\nService=${service}\n` +
    `Type=${kind}\nClass=user\nState=active\nIdleHint=no\nIdleSinceHint=0\n`;
  const current = block("2", "alice", "", "", "seat0", "wayland", "gdm-password") + block("4", "alice", "192.0.2.5");
  const last = "alice    pts/0        192.0.2.5        2026-09-24T10:00:00+00:00   still logged in\n" +
    "bob      tty1         0.0.0.0          2026-09-23T08:00:00+00:00 - 2026-09-23T17:00:00+00:00  (09:00)\n";
  return parsed(plugin, `source=loginctl\n${SCRIPT_SEP}\n${current}${SCRIPT_SEP}\n${last}`);
}

function host_control(plugin: Plugin): CollectResult {
  const power = "backend=ppd\n  performance:\n    CpuDriver:\tintel_pstate\n* balanced:\n" +
    "    CpuDriver:\tintel_pstate\n  power-saver:\n    CpuDriver:\tintel_pstate\n";
  return parsed(plugin, power, "freeze mem disk");
}

// What a journal holds in the demo: seconds ago, priority, unit and message, the same on every host.
const JOURNAL_ENTRIES: [number, number, string, string][] = [
  [40, 6, "sshd.service", "Accepted publickey for alice from 192.0.2.5 port 51234 ssh2"],
  [95, 4, "nginx.service", "upstream response is buffered to a temporary file"],
  [180, 3, "backup.service", "borg: Failed to create/acquire the lock (timeout)"],
  [240, 6, "systemd-logind.service", "New session 4 of user alice."],
  [420, 5, "kernel", "usb 1-2: new high-speed USB device number 7 using xhci_hcd"],
  [600, 6, "nginx.service", "Reloading nginx configuration"],
  [900, 2, "kernel", "nvme0: I/O 412 QID 3 timeout, aborting"],
  [1500, 6, "cron.service", "(root) CMD (run-parts /etc/cron.hourly)"],
  [2400, 4, "NetworkManager.service", "dhcp4 (eth0): request timed out"],
  [3000, 7, "systemd-resolved.service", "Using degraded feature set UDP instead of EDNS0 for DNS server 192.0.2.1."],
];

const seed_of = (id: string): number => [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0);

// The demo journal as journalctl -o json prints it, oldest first, keeping entries at or above max_priority.
export function journal_output(plugin: Plugin, max_priority = 7): string {
  const seed = seed_of(plugin.id);
  const now = Date.now() / 1000;
  const lines: string[] = [];
  [...JOURNAL_ENTRIES].reverse().forEach(([ago, priority, unit, message], index) => {
    if (priority > max_priority) return;
    lines.push(JSON.stringify({
      __REALTIME_TIMESTAMP: String(Math.trunc((now - ago - (seed % 60)) * 1e6)),
      __CURSOR: `${plugin.id}-${index}`,
      PRIORITY: String(priority),
      [unit === "kernel" ? "SYSLOG_IDENTIFIER" : "_SYSTEMD_UNIT"]: unit,
      MESSAGE: message,
    }));
  });
  return lines.join("\n");
}

// Every warning and error of the demo journal, counted as if they were all new.
function journal(plugin: Plugin): CollectResult {
  return parsed(plugin, journal_output(plugin, 4));
}

type Sample = (plugin: SampleMonitor, tick: number, seed: number) => Reading;
type ParsedSample = (plugin: Plugin, tick: number, seed: number) => CollectResult;

export const READINGS: Record<string, Sample> = {
  cpu, memory, load, temperature, throughput, connections, processes, disk_io, disk_space, filesystems, zfs, smart,
  uptime, http, ports, pihole, unbound, containers, syncthing, borg, nixos_upgrade, vuln_scan,
};

// Types whose sample runs the monitor's own parser on canned output, so each needs a real monitor.
export const PARSED_SAMPLES: Record<string, ParsedSample> = { package_updates, reboot_required, interfaces, sessions, host_control, journal };

export const SAMPLE_TYPES = new Set([...Object.keys(READINGS), ...Object.keys(PARSED_SAMPLES)]);

// ── The engine that applies them ─────────────────────────────────────────────

// The real engine, except that a monitor's cycle applies a sample reading instead of collecting.
export class SampleEngine extends XMonitorEngine {
  private readonly ticks = new Map<string, number>();

  override async run_cycle(plugin: Plugin): Promise<boolean> {
    const kind = String(plugin.config.type ?? "");
    if (kind === "group") return super.run_cycle(plugin);
    const tick = this.ticks.get(plugin.id) ?? 0;
    this.ticks.set(plugin.id, tick + 1);
    const seed = seed_of(plugin.id);
    if (Object.hasOwn(PARSED_SAMPLES, kind)) {
      this.apply(plugin, PARSED_SAMPLES[kind](plugin, tick, seed));
      return true;
    }
    if (!Object.hasOwn(READINGS, kind)) {
      this.apply(plugin, new CollectResult({ status: "unavailable" }));
      return true;
    }
    const [metrics, status, snapshot] = READINGS[kind](plugin as SampleMonitor, tick, seed);
    this.apply(plugin, new CollectResult({ metrics, status, snapshot: snapshot ?? null }));
    return true;
  }

  // A journal search reads the demo journal; every other action runs as usual.
  override async dispatch_action(plugin: Plugin, action_id: string, args: Record<string, unknown> = {}): Promise<DispatchResult> {
    if (action_id !== "query_logs" || plugin.config.type !== "journal") return super.dispatch_action(plugin, action_id, args);
    const output = journal_output(plugin, Number(args.priority ?? 7));
    const newest_first = output.split("\n").reverse().join("\n");
    return this.finish_action(plugin, plugin.interpret_action(action_id, cmd_result(0, newest_first, ""), args));
  }
}

if (import.meta.main) process.exitCode = await server_main(process.argv.slice(2), { engine_class: SampleEngine });
