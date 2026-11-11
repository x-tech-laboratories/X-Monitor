// Disk read/write throughput, sampled from /proc/diskstats. It has no thresholds; a sample that could not be read, or a
// device that is not in it, is unavailable.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { parse_int, partition, split_lines, split_words } from "./base/text_parsing.ts";

const sector_bytes = 512;
const virtual_prefixes = ["loop", "ram", "dm-", "sr", "fd", "md"];

type Sample = Map<string, [sectors_read: number, sectors_written: number]>;

// ── Parsing ──────────────────────────────────────────────────────────────────

// Each device's [sectors read, sectors written] from one /proc/diskstats block.
export function parse_diskstats(stdout: string): Sample {
  const result: Sample = new Map();
  for (const line of split_lines(stdout)) {
    const fields = split_words(line);
    if (fields.length < 10) continue;
    try {
      result.set(fields[2], [parse_int(fields[5]), parse_int(fields[9])]);
    } catch {
      continue;
    }
  }
  return result;
}

const is_digits = (text: string): boolean => /^\d+$/.test(text);

// Whether a device is a whole physical disk rather than a partition or virtual node.
export function is_physical(name: string): boolean {
  if (virtual_prefixes.some((prefix) => name.startsWith(prefix))) return false;
  const flash = name.startsWith("nvme") || name.startsWith("mmcblk");
  if (is_digits(name.slice(-1)) && !flash) return false;
  if (name.includes("p") && is_digits(name.split("p").at(-1)!) && flash) return false;
  return true;
}

// The busiest physical disk across the two samples, or the first one when all are idle.
export function auto_detect_device(first: Sample, second: Sample): string | null {
  let busiest: string | null = null;
  let busiest_activity = 0;
  for (const [name, [read1, written1]] of first) {
    const later = second.get(name);
    if (later === undefined || !is_physical(name)) continue;
    const activity = later[0] - read1 + (later[1] - written1);
    if (busiest === null || activity > busiest_activity) [busiest, busiest_activity] = [name, activity];
  }
  if (busiest !== null) return busiest;
  return [...first.keys()].find(is_physical) ?? null;
}

// Whether a configured device is a path to resolve rather than a kernel name.
export function is_device_path(device: string): boolean {
  return device.startsWith("/");
}

// The kernel name a resolved device path points at, or null when the path is absent.
export function resolve_device_path(stdout: string): string | null {
  const path = stdout.trim() ? split_lines(stdout.trim()).at(-1)!.trim() : "";
  if (!path.startsWith("/dev/")) return null;
  return path.slice(path.lastIndexOf("/") + 1) || null;
}

// A KB/s rate as a human-readable throughput.
export function format_rate(kbps: number): string {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps.toFixed(1)} KB/s`;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Read and write throughput for one disk, from two /proc/diskstats samples a second apart taken on the target so the
// sleep costs one round trip.
export class DiskIo extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly device: string | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.device = (config.device as string | null | undefined) ?? null;
  }

  get setting_key(): string {
    return `disks:${this.id}:active_device`;
  }

  override commands(): Command[] {
    let text = "cat /proc/diskstats && sleep 1 && echo '---SNAP---' && cat /proc/diskstats";
    if (this.device && is_device_path(this.device)) text += ` && echo '---DEVICE---' && { readlink -e ${shell_quote(this.device)} || true; }`;
    return [command(text)];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to read /proc/diskstats: ${stderr}`);

    const [samples, , resolved] = partition(stdout, "---DEVICE---");
    const halves = samples.split("---SNAP---");
    if (halves.length < 2) return CollectResult.unavailable("Unexpected /proc/diskstats output format");

    const first = parse_diskstats(halves[0]);
    const second = parse_diskstats(halves[1]);

    let device: string | null;
    if (this.device && is_device_path(this.device)) {
      device = resolve_device_path(resolved);
      if (!device) return CollectResult.unavailable(`Device '${this.device}' is not present`);
    } else {
      device = this.device || auto_detect_device(first, second);
    }
    if (!device) return CollectResult.unavailable("No usable disk device found");
    const before = first.get(device);
    const after = second.get(device);
    if (before === undefined || after === undefined) return CollectResult.unavailable(`Device '${device}' not found in /proc/diskstats`);

    const read_kbps = Math.max(0, ((after[0] - before[0]) * sector_bytes) / 1024);
    const write_kbps = Math.max(0, ((after[1] - before[1]) * sector_bytes) / 1024);
    return new CollectResult({
      metrics: { read_kbps, write_kbps },
      logs: [[`Disk ${device}: read ${format_rate(read_kbps)}, write ${format_rate(write_kbps)}`, "INFO"]],
      status: "online",
      settings: { [this.setting_key]: device },
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get active_device_text(): string {
    return this.data.get_setting(this.setting_key) || this.device || "Detecting...";
  }

  override cards(): Record<string, CardSpec> {
    return {
      io_device_card: { title: "DEVICE", value_attr: "active_device_text", refresh: true },
      read_card: { metric: "read_kbps", title: "READ", format: "kbps_rate" },
      write_card: { metric: "write_kbps", title: "WRITE", format: "kbps_rate" },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return {
      read_chart: {
        title: "DISK THROUGHPUT (KB/s)", style: "lines",
        series: [{ metric: "read_kbps", label: "Read" }, { metric: "write_kbps", label: "Write" }],
      },
    };
  }
}
