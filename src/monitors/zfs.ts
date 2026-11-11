// ZFS pool state and capacity, via zpool.

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, LayoutRow } from "../shared/ui_spec.ts";
import { level_for, limit_from, limits_text, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin, worst_status } from "./base/signal_plugin.ts";
import { format_fixed, parse_float, split_lines, split_words } from "./base/text_parsing.ts";

const unhealthy = new Set(["DEGRADED", "FAULTED", "OFFLINE", "UNAVAIL", "REMOVED"]);

// A pool name reduced to the characters a metric name may carry.
export function sanitize_pool(name: string): string {
  return [...name.toLowerCase()].map((character) => (/^[\p{L}\p{N}_]$/u.test(character) ? character : "_")).join("");
}

// A pool tile's caption: its health word and how full it is.
export function pool_caption(item: Record<string, unknown>): string {
  return `${item.health ?? "--"} · ${format_fixed(Number(item.usage) || 0, 0)}%`;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Pool state and capacity from one `zpool list`: a count of degraded pools, a usage metric per pool and the fullest
// pool's usage, with each pool's health and usage in the snapshot for its tile. A zpool that fails to run or lists no
// pools measured nothing, so it is unavailable; a pool in any unhealthy state is failed.
export class Zfs extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly pools: string[];

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 80);
    this.threshold = limit_from(config, "threshold", 90);
    this.pools = [...((config.pools as string[] | null | undefined) || [])];
  }

  // One pool's meter, by its own capacity against this monitor's thresholds.
  readonly item_level = (item: Record<string, unknown>): Status => level_for(Number(item.value) || 0, this.warning, this.threshold);

  // One pool's tile: failed when it is unhealthy, otherwise by its capacity.
  readonly pool_state = (item: Record<string, unknown>): Status => {
    if (unhealthy.has(String(item.health))) return "failed";
    return level_for(Number(item.usage) || 0, this.warning, this.threshold);
  };

  override commands(): Command[] {
    return [command(`zpool list -H -o name,health,capacity ${this.pools.join(" ")} 2>&1`)];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0 && !stdout.trim()) return CollectResult.unavailable(`zpool list failed: ${stderr || stdout}`);

    let ok = 0;
    let degraded = 0;
    const usage = new Map<string, number>();
    const pools: Record<string, unknown>[] = [];
    const logs: LogEntry[] = [];
    const statuses: Status[] = [];
    for (const line of split_lines(stdout)) {
      const parts = split_words(line.trim());
      if (parts.length !== 3) continue;
      const [pool, health, capacity] = parts;
      let usage_pct: number;
      try {
        usage_pct = parse_float(capacity.replace(/%+$/, ""));
      } catch {
        continue;
      }
      usage.set(pool, usage_pct);
      pools.push({ label: pool, health, usage: usage_pct });

      let status: Status;
      if (unhealthy.has(health)) {
        degraded += 1;
        status = "failed";
      } else {
        ok += 1;
        status = level_for(usage_pct, this.warning, this.threshold);
      }
      statuses.push(status);
      logs.push([`Pool ${pool}: ${health}, ${format_fixed(usage_pct, 0)}% used (${limits_text(this.warning, this.threshold, "%")})`, log_level_of(status)]);
    }

    if (usage.size === 0) {
      const result = CollectResult.unavailable("No ZFS pools found");
      result.snapshot = [];
      return result;
    }

    const metrics: Record<string, number> = { pools_total: ok + degraded, pools_ok: ok, pools_degraded: degraded, zfs_usage_max: Math.max(...usage.values()) };
    for (const [pool, usage_pct] of usage) metrics[`pool_usage_${sanitize_pool(pool)}`] = usage_pct;
    return new CollectResult({ metrics, logs, status: worst_status(statuses), snapshot: pools });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      zfs_total_card: { metric: "pools_total", title: "POOLS", format: "int" },
      zfs_degraded_card: {
        kind: "share", title: "POOL HEALTH", format: "int",
        parts: [
          { metric: "pools_ok", label: "Healthy", color: "online" },
          { metric: "pools_degraded", label: "Degraded", color: "failed" },
        ],
      },
      zfs_pool_tiles: {
        title: "POOL STATE",
        repeat: { source: "snapshot", container: "tiles", item_format_fn: pool_caption, item_color_by: this.pool_state, empty_text: "No ZFS pools found" },
      },
      zfs_pools: {
        title: "POOL CAPACITY",
        repeat: {
          source: "metrics_prefix",
          metrics_prefix: "pool_usage_",
          metrics_suffix: "",
          item_format: "percent1",
          item_color_by: this.item_level,
          label_transform: "spaces_upper",
          container: "bars",
          bar_marker: this.warning ?? this.threshold ?? undefined,
          empty_text: "No ZFS pools found",
        },
      },
    };
  }

  override card_row(): string[] {
    return ["zfs_total_card", "zfs_degraded_card"];
  }

  override rows(): LayoutRow[] {
    return [["zfs_pool_tiles"], ["zfs_pools"]];
  }

  override charts(): Record<string, ChartSpec> {
    return { zfs_chart: { metric: "zfs_usage_max", title: "FULLEST POOL CAPACITY (%)" } };
  }
}
