// Btrfs filesystem health and capacity, via btrfs-progs. Device errors or usage over the threshold is failed; a probe
// that could not run, missing btrfs-progs, or no btrfs filesystem to read is unavailable.

import { format_fixed, parse_int, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, LayoutRow } from "../shared/ui_spec.ts";
import { format_bytes, level_for, limit_from, limits_text, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin, worst_status } from "./base/signal_plugin.ts";

// One mountpoint per filesystem, the shortest, so a container with subvolumes mounted all over the tree is reported
// once under its topmost mount; every command reads through the mountpoint, which needs no privilege.
export const BTRFS_PROBE = "command -v btrfs >/dev/null 2>&1 || { echo 'ERROR btrfs-progs not found'; exit 1; }; findmnt -nrt btrfs -o UUID,TARGET 2>/dev/null | awk 'NF == 2 { if (!($1 in m) || length($2) < length(m[$1])) m[$1] = $2 }        END { for (u in m) print m[u] }' | sort | while read -r mnt; do   echo \"FS $mnt\";   btrfs filesystem usage -b \"$mnt\" 2>/dev/null | awk '    /^[ \\t]*Device size:/ { print \"USE size \" $NF }     /^[ \\t]*Device unallocated:/ { print \"USE unallocated \" $NF }     /^[ \\t]*Used:/ { print \"USE used \" $NF }';   btrfs device stats \"$mnt\" 2>/dev/null | sed 's/^/DEV /'; done";

const gibibyte = 1024 ** 3;

// A mountpoint reduced to the characters a metric name may carry.
export function sanitize_mount(mountpoint: string): string {
  const stripped = mountpoint.replace(/^\/+|\/+$/g, "");
  if (!stripped) return "root";
  return [...stripped].map((character) => (/^[\p{L}\p{N}]$/u.test(character) ? character : "_")).join("");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// One btrfs filesystem's readings, as the probe reported them.
export class BtrfsFilesystem {
  readonly mountpoint: string;
  readonly key: string;
  size = 0;
  used = 0;
  unallocated = 0;
  readonly errors = new Map<string, number>();

  constructor(mountpoint: string) {
    this.mountpoint = mountpoint;
    this.key = sanitize_mount(mountpoint);
  }

  // How much of the raw device the filesystem occupies, raw on both sides so a DUP or RAID1 profile reads as the fuller
  // filesystem it really is.
  get usage_pct(): number {
    return this.size ? (100 * this.used) / this.size : 0;
  }

  get error_count(): number {
    return [...this.errors.values()].reduce((sum, count) => sum + count, 0);
  }

  get error_summary(): string {
    return [...this.errors].sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0)).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`).join(", ");
  }
}

// The probe's FS, USE and DEV lines as one filesystem per mountpoint, leaving out any without a size.
export function parse_probe(stdout: string): BtrfsFilesystem[] {
  const filesystems: BtrfsFilesystem[] = [];
  let current: BtrfsFilesystem | null = null;
  for (const line of split_lines(stdout)) {
    const parts = split_words(line);
    if (parts.length === 0) continue;
    if (parts[0] === "FS" && parts.length === 2) {
      current = new BtrfsFilesystem(parts[1]);
      filesystems.push(current);
    } else if (parts[0] === "USE" && parts.length === 3 && current !== null) {
      const field = parts[1];
      if (field !== "size" && field !== "used" && field !== "unallocated") continue;
      try {
        current[field] = parse_int(parts[2]);
      } catch {
        continue;
      }
    } else if (parts[0] === "DEV" && parts.length === 3 && current !== null) {
      const marker = parts[1].lastIndexOf("].");
      const counter = marker === -1 ? parts[1] : parts[1].slice(marker + 2);
      try {
        current.errors.set(counter, (current.errors.get(counter) ?? 0) + parse_int(parts[2]));
      } catch {
        continue;
      }
    }
  }
  return filesystems.filter((filesystem) => filesystem.size);
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Filesystem state and capacity from one probe, the btrfs sibling of the zfs monitor: a count of filesystems carrying
// device errors plus a usage metric per filesystem and the fullest one's usage. With no pool health word in btrfs, the
// verdict comes from the per-device error counters (read, write, flush, corruption, generation), cleared only by hand;
// any above zero is this monitor's DEGRADED.
export class Btrfs extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly filesystems: string[];
  readonly unallocated_warning: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 80);
    this.threshold = limit_from(config, "threshold", 90);
    this.filesystems = [...((config.filesystems as string[] | null | undefined) || [])];
    this.unallocated_warning = limit_from(config, "unallocated_warning", gibibyte);
  }

  override commands(): Command[] {
    return [command(BTRFS_PROBE)];
  }

  // Whether a filesystem has less unallocated space than the warning floor, which null turns off.
  private short_of_unallocated(unallocated: number): boolean {
    return this.unallocated_warning !== null && unallocated < this.unallocated_warning;
  }

  // Errors outrank fullness, and a container with nothing left to allocate is a warning however empty it reads.
  private level_for(filesystem: BtrfsFilesystem): Status {
    if (filesystem.error_count) return "failed";
    const level = level_for(filesystem.usage_pct, this.warning, this.threshold);
    if (this.short_of_unallocated(filesystem.unallocated)) return worst_status([level, "warning"]);
    return level;
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0 && !stdout.trim()) return CollectResult.unavailable(`btrfs probe failed: ${stderr || stdout}`);
    if (stdout.startsWith("ERROR ")) return CollectResult.unavailable(stdout.trim());

    let filesystems = parse_probe(stdout);
    if (this.filesystems.length > 0) filesystems = filesystems.filter((filesystem) => this.filesystems.includes(filesystem.mountpoint));
    if (filesystems.length === 0) return new CollectResult({ logs: [["No btrfs filesystems found", "WARNING"]], status: "unavailable" });

    const metrics: Record<string, number> = {};
    const logs: LogEntry[] = [];
    const statuses: Status[] = [];
    let ok = 0;
    let degraded = 0;
    for (const filesystem of filesystems) {
      const level = this.level_for(filesystem);
      statuses.push(level);
      if (filesystem.error_count) degraded += 1;
      else ok += 1;

      metrics[`fs_usage_${filesystem.key}`] = filesystem.usage_pct;
      metrics[`fs_errors_${filesystem.key}`] = filesystem.error_count;
      metrics[`fs_unallocated_${filesystem.key}`] = filesystem.unallocated;

      let detail = `${format_fixed(filesystem.usage_pct, 0)}% used of ${format_bytes(filesystem.size, "B")} (${limits_text(this.warning, this.threshold, "%")})`;
      if (filesystem.error_count) detail += `, device errors: ${filesystem.error_summary}`;
      else if (this.short_of_unallocated(filesystem.unallocated)) detail += `, only ${format_bytes(filesystem.unallocated, "B")} unallocated — btrfs cannot make a new chunk and writes may fail with ENOSPC`;
      logs.push([`${filesystem.mountpoint}: ${detail}`, log_level_of(level)]);
    }

    Object.assign(metrics, {
      filesystems_total: ok + degraded,
      filesystems_ok: ok,
      filesystems_degraded: degraded,
      btrfs_usage_max: Math.max(...filesystems.map((filesystem) => filesystem.usage_pct)),
      device_errors: filesystems.reduce((sum, filesystem) => sum + filesystem.error_count, 0),
    });
    return new CollectResult({ metrics, logs, status: worst_status(statuses) });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  readonly item_level = (item: Record<string, unknown>): Status => {
    if ((Number(item.errors) || 0) > 0) return "failed";
    const level = level_for(Number(item.usage_pct) || 0, this.warning, this.threshold);
    const unallocated = item.unallocated;
    if (unallocated !== null && unallocated !== undefined && this.short_of_unallocated(Number(unallocated))) return worst_status([level, "warning"]);
    return level;
  };

  readonly item_text = (item: Record<string, unknown>): string => {
    let text = `${format_fixed(Number(item.usage_pct) || 0, 1)}%`;
    const errors = Number(item.errors) || 0;
    if (errors) text += `  ·  ${Math.trunc(errors)} dev err`;
    return text;
  };

  override cards(): Record<string, CardSpec> {
    return {
      btrfs_total_card: { metric: "filesystems_total", title: "FILESYSTEMS", format: "int" },
      btrfs_degraded_card: {
        kind: "share", title: "FILESYSTEM HEALTH", format: "int",
        parts: [
          { metric: "filesystems_ok", label: "Healthy", color: "online" },
          { metric: "filesystems_degraded", label: "Degraded", color: "failed" },
        ],
      },
      btrfs_filesystems: {
        title: "FILESYSTEM CAPACITY",
        repeat: {
          source: "metrics_prefix",
          fields: [
            { name: "usage_pct", prefix: "fs_usage_", suffix: "" },
            { name: "errors", prefix: "fs_errors_", suffix: "" },
            { name: "unallocated", prefix: "fs_unallocated_", suffix: "" },
          ],
          item_format_fn: this.item_text,
          item_color_by: this.item_level,
          label_transform: "slashes",
          container: "bars",
          bar_value: "usage_pct",
          bar_marker: this.warning ?? this.threshold ?? undefined,
          empty_text: "No btrfs filesystems found",
        },
      },
    };
  }

  override card_row(): string[] {
    return ["btrfs_total_card", "btrfs_degraded_card"];
  }

  override rows(): LayoutRow[] {
    return [["btrfs_filesystems"]];
  }

  override charts(): Record<string, ChartSpec> {
    return { btrfs_chart: { metric: "btrfs_usage_max", title: "FULLEST FILESYSTEM (%)" } };
  }
}
