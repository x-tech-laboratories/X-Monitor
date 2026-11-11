// Space, inodes and read-only state of every real filesystem on the target, from one combined df and /proc/mounts
// command, sampled on the host by the agent where there is one. Config: warning / threshold (space percent),
// inode_warning / inode_threshold (each null to turn that level off), readonly_is_failure, and exclude_mounts
// (mountpoints left out along with everything mounted beneath them). The worst filesystem sets the status: space or
// inode use past the warning is warning and past the threshold is failed, while a read-only mount is failed (warning
// when readonly_is_failure is off) because the kernel may have remounted it after an I/O error. A df that produced
// nothing, or no real filesystems at all, is unavailable.

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { log_level_of, severity, type Status } from "../shared/status.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { df_command, parse_df, path_key, PSEUDO_FS_TYPES } from "./base/disk_usage.ts";
import { scan_metric_family } from "./base/metric_family.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_bytes, level_for, limit_from, limits_text, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";
import { format_fixed, split_lines, split_words } from "./base/text_parsing.ts";

export const SNAP = "---SNAP---";

const space_columns = ["target", "size", "used", "pcent"];
const inode_columns = ["target", "ipcent"];

const default_layout: LayoutRow[] = [["host_card", "count_card"], ["filesystems"], ["events"]];

// ── Parsing ──────────────────────────────────────────────────────────────────

function build_command(): string {
  const space = df_command(space_columns, { byte_blocks: true, exclude_types: PSEUDO_FS_TYPES });
  const inodes = df_command(inode_columns, { exclude_types: PSEUDO_FS_TYPES });
  return `${space} && echo '${SNAP}' && ${inodes} && echo '${SNAP}' && cat /proc/mounts`;
}

export function parse_inodes(block: string): Map<string, number> {
  return new Map(parse_df(block, inode_columns).map((row) => [row.target!, row.ipcent]));
}

// Each mountpoint in /proc/mounts, true when mounted read-only.
export function parse_readonly(block: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const line of split_lines(block)) {
    const fields = split_words(line);
    if (fields.length < 4) continue;
    const mountpoint = fields[1].replaceAll("\\040", " ").replaceAll("\\011", "\t").replaceAll("\\012", "\n").replaceAll("\\134", "\\");
    result.set(mountpoint, fields[3].split(",")[0] === "ro");
  }
  return result;
}

type SpaceRow = [mountpoint: string, used_pct: number, size_bytes: number, used_bytes: number];

function parse_space(block: string): SpaceRow[] {
  return parse_df(block, space_columns).map((row) => [row.target!, row.pcent, row.size, row.used]);
}

interface Assessment {
  metrics: Record<string, number>;
  logs: LogEntry[];
  worst: number;
  worst_inode: number;
  ro_mounts: string[];
  accumulator: StatusAccumulator;
}

// Per-filesystem metrics, problem logs, worst-usage figures, read-only mounts and the worst-of status.
function assess_filesystems(filesystems: SpaceRow[], inode_pct: Map<string, number>, readonly: Map<string, boolean>, space_level_for: (pct: number) => Status, inode_level_for: (pct: number) => Status, readonly_level: Status): Assessment {
  const metrics: Record<string, number> = {};
  const logs: LogEntry[] = [];
  let worst = 0;
  let worst_inode = 0;
  const accumulator = new StatusAccumulator();
  const ro_mounts: string[] = [];

  for (const [mountpoint, used_pct, size_bytes] of filesystems) {
    const key = path_key(mountpoint);
    metrics[`fs_${key}_used_pct`] = used_pct;
    metrics[`fs_${key}_size_gb`] = size_bytes / 1024 ** 3;
    worst = Math.max(worst, used_pct);
    const level = space_level_for(used_pct);
    accumulator.escalate(level);
    if (level !== "online") logs.push([`${mountpoint}: ${format_fixed(used_pct, 0)}% used (${format_bytes(size_bytes, "B")})`, log_level_of(level)]);

    const inode_used_pct = inode_pct.get(mountpoint);
    if (inode_used_pct !== undefined) {
      metrics[`fs_${key}_inodes_pct`] = inode_used_pct;
      worst_inode = Math.max(worst_inode, inode_used_pct);
      const inode_level = inode_level_for(inode_used_pct);
      accumulator.escalate(inode_level);
      if (inode_level !== "online") {
        logs.push([`${mountpoint}: ${format_fixed(inode_used_pct, 0)}% of inodes used — writes may fail with ENOSPC despite free space`, log_level_of(inode_level)]);
      }
    }

    if (readonly.get(mountpoint)) {
      ro_mounts.push(mountpoint);
      accumulator.escalate(readonly_level);
      logs.push([`${mountpoint}: mounted READ-ONLY — usage figures are stale; the kernel may have remounted it after an I/O error`, log_level_of(readonly_level)]);
    }
  }
  return { metrics, logs, worst, worst_inode, ro_mounts, accumulator };
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Filesystems extends Plugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly inode_warning: number | null;
  readonly inode_threshold: number | null;
  readonly readonly_is_failure: boolean;
  readonly exclude_mounts: string[];

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 80);
    this.threshold = limit_from(config, "threshold", 90);
    this.inode_warning = limit_from(config, "inode_warning", 85);
    this.inode_threshold = limit_from(config, "inode_threshold", 95);
    this.readonly_is_failure = Boolean(config.readonly_is_failure ?? true);
    this.exclude_mounts = ((config.exclude_mounts as string[] | undefined) ?? []).map((mount) => mount.replace(/\/+$/, "") || "/");
  }

  // Whether the mountpoint is an excluded one or sits beneath one.
  private excluded(mountpoint: string): boolean {
    return this.exclude_mounts.some((mount) => mountpoint === mount || mountpoint.startsWith(`${mount.replace(/\/+$/, "")}/`));
  }

  private inode_level_for(pct: number): Status {
    return level_for(pct, this.inode_warning, this.inode_threshold);
  }

  private level_for(pct: number): Status {
    return level_for(pct, this.warning, this.threshold);
  }

  override commands(): Command[] {
    return [command(build_command())];
  }

  // The combined output as per-filesystem usage metrics, a log line per problem plus a summary, and the worst
  // filesystem's level as status.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0 && !stdout.trim()) return CollectResult.unavailable(`df failed: ${stderr}`);

    const sections = stdout.split(SNAP);
    const inode_pct = sections.length > 1 ? parse_inodes(sections[1]) : new Map<string, number>();
    const readonly = sections.length > 2 ? parse_readonly(sections[2]) : new Map<string, boolean>();
    const filesystems = parse_space(sections[0]).filter((row) => !this.excluded(row[0]));
    if (filesystems.length === 0) return CollectResult.unavailable("No real filesystems found");

    const readonly_level: Status = this.readonly_is_failure ? "failed" : "warning";
    const { metrics, logs, worst, worst_inode, ro_mounts, accumulator } = assess_filesystems(
      filesystems, inode_pct, readonly, (pct) => this.level_for(pct), (pct) => this.inode_level_for(pct), readonly_level);
    metrics.worst_used_pct = worst;
    metrics.worst_inodes_pct = worst_inode;
    metrics.readonly_count = ro_mounts.length;

    let summary = `${filesystems.length} filesystem(s), worst ${format_fixed(worst, 0)}% (${limits_text(this.warning, this.threshold, "%")})`;
    if (inode_pct.size > 0) summary += `, worst inodes ${format_fixed(worst_inode, 0)}%`;
    if (ro_mounts.length > 0) summary += `, ${ro_mounts.length} read-only: ${ro_mounts.join(", ")}`;
    logs.push([summary, accumulator.log_level]);
    return new CollectResult({ metrics, logs, status: accumulator.status });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  item_level(item: Record<string, unknown>): Status {
    let level = this.level_for(Number(item.used_pct) || 0);
    const inode_pct = item.inodes_pct;
    if (inode_pct !== null && inode_pct !== undefined) {
      const inode_level = this.inode_level_for(Number(inode_pct));
      if (severity(inode_level) > severity(level)) level = inode_level;
    }
    return level;
  }

  readonly item_color = (item: Record<string, unknown>): Status => this.item_level(item);

  readonly item_text = (item: Record<string, unknown>): string => {
    const value = Number(item.used_pct) || 0;
    let text = `${format_fixed(value, 0)}%`;
    const inode_pct = item.inodes_pct;
    if (inode_pct !== null && inode_pct !== undefined && this.inode_level_for(Number(inode_pct)) !== "online") text += `  ·  inodes ${format_fixed(Number(inode_pct), 0)}%`;
    return text;
  };

  // How many filesystems the latest cycle measured.
  get filesystem_count(): string {
    return String(scan_metric_family(this.data.latest_collector_metrics(), "fs_", "_used_pct").size);
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        count_card: { title: "FILESYSTEMS", value_attr: "filesystem_count" },
        filesystems: {
          title: "USAGE",
          repeat: {
            source: "metrics_prefix",
            fields: [
              { name: "used_pct", prefix: "fs_", suffix: "_used_pct" },
              { name: "inodes_pct", prefix: "fs_", suffix: "_inodes_pct" },
            ],
            item_format_fn: this.item_text,
            item_color_by: this.item_color,
            label_transform: "slashes",
            container: "bars",
            bar_value: "used_pct",
            bar_marker: this.warning ?? this.threshold ?? undefined,
            empty_text: "No filesystems found",
          },
        },
      },
      events: true,
    };
  }
}
