// X-Monitor watching itself: process memory, CPU, and uptime from /proc/self, plus collection health across every
// other monitor, gathered through the io_call escape hatch since it reads local files and live engine state rather
// than issuing connector requests. Config: memory_warning / memory_threshold (MB of RSS), stale_warning /
// stale_threshold (how many intervals overdue a monitor may run), slow_cycle_fraction / slow_cycle_seconds (how long a
// monitor's average cycle may take, as a share of its interval or in seconds); each is optional, and null turns that
// level off. RSS past its bounds sets warning/failed, monitors overdue past stale_warning are warning ("late"), any
// past stale_threshold makes the status failed ("stalled"), and a monitor whose cycles run past either slow bound is
// warning ("slow"). A table lists every monitor's recent cycle times, slowest first, with how long its SSH commands
// queued for a channel. A sample that throws before anything was read is unavailable.

import { readFileSync } from "node:fs";

import { CollectResult, type Result } from "../core/connectors/types.ts";
import type { EngineLike } from "../core/contracts.ts";
import { threshold_color } from "../shared/ui_registry.ts";
import type { ColorRule, Formatter, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { level_for, limit_from, type PluginConfig } from "./base/plugin_helpers.ts";

// Linux's USER_HZ, which /proc/self/stat counts CPU time in; Node has no sysconf to ask.
const clock_ticks = 100;

const default_layout: LayoutRow[] = [
  ["uptime_card", "memory_card", "monitors_card", "slow_card"],
  ["chart"],
  ["timings"],
  ["events"],
];

// ── Engine surface ───────────────────────────────────────────────────────────

// One monitor's recent cycle durations in seconds, and how long its SSH commands queued for a channel.
export interface CycleTiming {
  last_seconds: number;
  avg_seconds: number;
  max_seconds: number;
  last_wait_seconds: number;
  avg_wait_seconds: number;
  cycles: number;
}

// The engine reads this monitor needs beyond EngineLike: each monitor's cycle timing, null before its first timed
// cycle; last_collected is in monotonic seconds (performance.now() / 1000).
export interface SelfEngine {
  readonly plugins: readonly unknown[];
  last_collected(plugin_id: string): number;
  cycle_timing(plugin_id: string): CycleTiming | null;
}

// The parts of another monitor this one reads.
interface WatchedMonitor {
  id: string;
  name: string;
  interval: number;
  children: WatchedMonitor[];
}

// Every monitor reachable from these roots once each, parents before children, in config order.
function* iter_monitors(roots: readonly unknown[]): Generator<WatchedMonitor> {
  const seen = new Set<unknown>();
  function* walk(plugins: readonly unknown[]): Generator<WatchedMonitor> {
    for (const plugin of plugins) {
      if (seen.has(plugin)) continue;
      seen.add(plugin);
      yield plugin as WatchedMonitor;
      yield* walk((plugin as WatchedMonitor).children ?? []);
    }
  }
  yield* walk(roots);
}

// ── Process readers ──────────────────────────────────────────────────────────

export function read_rss_mb(path = "/proc/self/status"): number | null {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.startsWith("VmRSS:")) {
        const field = line.split(/\s+/)[1];
        if (field === undefined || !/^[+-]?\d+$/.test(field)) return null;
        return Number(field) / 1024;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function read_cpu_seconds(path = "/proc/self/stat"): number | null {
  try {
    const fields = readFileSync(path, "utf8").split(/\s+/).filter((field) => field !== "");
    if (fields.length < 15 || !/^\d+$/.test(fields[13]) || !/^\d+$/.test(fields[14])) return null;
    return (Number(fields[13]) + Number(fields[14])) / clock_ticks;
  } catch {
    return null;
  }
}

// ── Text ─────────────────────────────────────────────────────────────────────

export function format_uptime(value: number): string {
  const seconds = Math.trunc(value);
  const days = Math.floor(seconds / 86400);
  let rem = seconds - days * 86400;
  const hours = Math.floor(rem / 3600);
  rem -= hours * 3600;
  const minutes = Math.floor(rem / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function round_to(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function monotonic(): number {
  return performance.now() / 1000;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export interface CycleRow {
  id: string;
  name: string;
  interval: number;
  last: number;
  avg: number;
  max: number;
  wait: number;
  share: number | null;
  slow: boolean;
}

export interface SelfSample {
  error?: string;
  cycles?: CycleRow[];
  rss_mb?: number | null;
  cpu_pct?: number | null;
  uptime_seconds?: number;
  total?: number;
  late?: number;
  stalled?: number;
  offenders?: [overdue: number, name: string][];
}

export class XMonitorSelfPlugin extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  readonly memory_warning: number | null;
  readonly memory_threshold: number | null;
  readonly stale_warning: number | null;
  readonly stale_threshold: number | null;
  readonly slow_cycle_fraction: number | null;
  readonly slow_cycle_seconds: number | null;
  private readonly started_at = Date.now() / 1000;
  private last_cpu_sample: [time: number, cpu: number] | null = null;
  private readonly memory_color: ColorRule;
  private readonly uptime_format: Formatter = (value) => (value === null ? "--" : format_uptime(value));
  private readonly memory_format: Formatter = (value) => (value === null ? "-- MB" : `${value.toFixed(0)} MB`);
  // The process readers, swappable in a test.
  read_rss_mb: () => number | null = () => read_rss_mb();
  read_cpu_seconds: () => number | null = () => read_cpu_seconds();

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.memory_warning = limit_from(config, "memory_warning", 256);
    this.memory_threshold = limit_from(config, "memory_threshold", 512);
    // A pushed monitor is only guaranteed an event every SAMPLE_MAX_QUIET_INTERVALS, so a bound at or under that would
    // read a healthy quiet stream as late.
    this.stale_warning = limit_from(config, "stale_warning", this.SAMPLE_MAX_QUIET_INTERVALS + 1);
    this.stale_threshold = limit_from(config, "stale_threshold", 10);
    this.slow_cycle_fraction = limit_from(config, "slow_cycle_fraction", 0.5);
    // Off by default, which leaves only the share-of-interval bound.
    this.slow_cycle_seconds = limit_from(config, "slow_cycle_seconds");
    this.target = "x-monitor";
    this.memory_color = threshold_color(this.memory_warning, this.memory_threshold);
  }

  private get self_engine(): SelfEngine | null {
    return this.engine as (EngineLike & SelfEngine) | null;
  }

  private *walk_monitors(): Generator<WatchedMonitor> {
    const engine = this.self_engine;
    if (engine === null) return;
    for (const plugin of iter_monitors(engine.plugins)) if ((plugin as unknown) !== this) yield plugin;
  }

  private collection_health(): [total: number, late: number, stalled: number, offenders: [number, string][]] {
    const now = monotonic();
    let total = 0;
    let late = 0;
    let stalled = 0;
    const offenders: [number, string][] = [];
    for (const plugin of this.walk_monitors()) {
      if (plugin.children.length > 0) continue;
      total += 1;
      const last = this.self_engine ? this.self_engine.last_collected(plugin.id) : 0.0;
      if (!last) continue;
      const overdue = plugin.interval ? (now - last) / plugin.interval : 0;
      const level = level_for(overdue, this.stale_warning, this.stale_threshold);
      if (level === "failed") {
        stalled += 1;
        offenders.push([overdue, plugin.name]);
      } else if (level === "warning") {
        late += 1;
        offenders.push([overdue, plugin.name]);
      }
    }
    offenders.sort((left, right) => right[0] - left[0] || (left[1] < right[1] ? 1 : left[1] > right[1] ? -1 : 0));
    return [total, late, stalled, offenders.slice(0, 5)];
  }

  private is_slow(avg_seconds: number, interval: number): boolean {
    if (this.slow_cycle_seconds && avg_seconds > this.slow_cycle_seconds) return true;
    return Boolean(interval) && Boolean(this.slow_cycle_fraction) && avg_seconds > interval * this.slow_cycle_fraction!;
  }

  // One row per monitor that has timed a cycle, slowest average first.
  private cycle_rows(): CycleRow[] {
    const rows: CycleRow[] = [];
    for (const plugin of this.walk_monitors()) {
      if (plugin.children.length > 0) continue;
      const timing = this.self_engine!.cycle_timing(plugin.id);
      if (timing === null || timing === undefined) continue;
      rows.push({
        id: plugin.id,
        name: plugin.name,
        interval: plugin.interval,
        last: round_to(timing.last_seconds, 3),
        avg: round_to(timing.avg_seconds, 3),
        max: round_to(timing.max_seconds, 3),
        wait: round_to(timing.avg_wait_seconds, 3),
        share: plugin.interval ? round_to((100.0 * timing.avg_seconds) / plugin.interval, 1) : null,
        slow: this.is_slow(timing.avg_seconds, plugin.interval),
      });
    }
    rows.sort((left, right) => right.avg - left.avg);
    return rows;
  }

  // Reads /proc/self plus the engine's live collection-health map; a sample that throws is handed to parse_results as
  // an error so the cycle records unavailable instead of nothing.
  override io_call(): () => SelfSample {
    return () => {
      try {
        return this.sample();
      } catch (error) {
        return { error: `${(error as Error).name ?? "Error"}: ${(error as Error).message ?? String(error)}` };
      }
    };
  }

  private sample(): SelfSample {
    const rss_mb = this.read_rss_mb();
    const cpu_seconds = this.read_cpu_seconds();
    const uptime_seconds = Date.now() / 1000 - this.started_at;

    let cpu_pct: number | null = null;
    if (cpu_seconds !== null) {
      const now = monotonic();
      if (this.last_cpu_sample) {
        const [previous_time, previous_cpu] = this.last_cpu_sample;
        const elapsed = now - previous_time;
        if (elapsed > 0) cpu_pct = (100.0 * (cpu_seconds - previous_cpu)) / elapsed;
      }
      this.last_cpu_sample = [now, cpu_seconds];
    }

    const [total, late, stalled, offenders] = this.collection_health();
    return { cycles: this.engine !== null ? this.cycle_rows() : [], rss_mb, cpu_pct, uptime_seconds, total, late, stalled, offenders };
  }

  override parse_results(results: Result[]): CollectResult {
    const result = results[0] as unknown as SelfSample;
    if ("error" in result) return CollectResult.unavailable(`Self sample could not be taken: ${result.error}`);
    const rss_mb = result.rss_mb ?? null;
    const cpu_pct = result.cpu_pct ?? null;
    const uptime_seconds = result.uptime_seconds ?? 0;
    const total = result.total ?? 0;
    const late = result.late ?? 0;
    const stalled = result.stalled ?? 0;
    const offenders = result.offenders ?? [];

    const cycles = result.cycles || [];
    const slow = cycles.filter((row) => row.slow);

    const metrics: Record<string, number> = { uptime_seconds, monitors_total: total, monitors_late: late, monitors_stalled: stalled, monitors_slow: slow.length };
    if (cycles.length > 0) metrics.slowest_cycle_seconds = cycles[0].avg;
    if (rss_mb !== null) metrics.memory_mb = rss_mb;
    if (cpu_pct !== null) metrics.cpu_pct = cpu_pct;

    const memory_level = rss_mb !== null ? level_for(rss_mb, this.memory_warning, this.memory_threshold) : "online";
    const collect_level = stalled ? "failed" : late || slow.length > 0 ? "warning" : "online";
    const ranks = ["online", "warning", "failed"];
    const overall = ranks.indexOf(collect_level) > ranks.indexOf(memory_level) ? collect_level : memory_level;

    const parts = [`up ${format_uptime(uptime_seconds)}`];
    if (rss_mb !== null) parts.push(`RSS ${rss_mb.toFixed(0)} MB`);
    if (cpu_pct !== null) parts.push(`CPU ${cpu_pct.toFixed(1)}%`);
    parts.push(`${total} monitors`);
    if (late || stalled) parts.push(`${late} late, ${stalled} stalled`);
    if (offenders.length > 0) parts.push(`worst: ${offenders.map(([multiple, name]) => `${name} (${multiple.toFixed(0)}x)`).join(", ")}`);
    if (slow.length > 0) parts.push(`slow: ${slow.slice(0, 5).map((row) => `${row.name} (${row.avg.toFixed(1)}s of ${row.interval.toFixed(0)}s)`).join(", ")}`);

    const log_level = overall === "failed" ? "ERROR" : overall === "warning" ? "WARNING" : "INFO";
    return new CollectResult({ metrics, logs: [[parts.join(" | "), log_level]], status: overall, snapshot: cycles });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  static monitors_text(values: Record<string, unknown>): string {
    const total = values.monitors_total;
    if (total === null || total === undefined) return "--";
    const late = Math.trunc(Number(values.monitors_late || 0));
    const stalled = Math.trunc(Number(values.monitors_stalled || 0));
    if (stalled) return `${Math.trunc(Number(total))} (${stalled} stalled)`;
    if (late) return `${Math.trunc(Number(total))} (${late} late)`;
    return `${Math.trunc(Number(total))} OK`;
  }

  static monitors_color(values: Record<string, unknown>): "online" | "warning" | "failed" | null {
    if (values.monitors_total === null || values.monitors_total === undefined) return null;
    if (Math.trunc(Number(values.monitors_stalled || 0))) return "failed";
    if (Math.trunc(Number(values.monitors_late || 0))) return "warning";
    return "online";
  }

  static slow_row_color(row: Record<string, unknown>): "warning" | null {
    return row.slow ? "warning" : null;
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        uptime_card: { metric: "uptime_seconds", title: "XMONITOR UPTIME", format: this.uptime_format },
        memory_card: { metric: "memory_mb", title: "MEMORY", format: this.memory_format, color: this.memory_color },
        monitors_card: {
          title: "MONITORS",
          metrics: ["monitors_total", "monitors_late", "monitors_stalled"],
          format_fn: XMonitorSelfPlugin.monitors_text,
          color_fn: XMonitorSelfPlugin.monitors_color,
        },
        slow_card: { metric: "monitors_slow", title: "SLOW MONITORS", color: "nonzero_warning" },
      },
      chart: { metric: "memory_mb", title: "XMONITOR MEMORY (MB)" },
      tables: {
        timings: {
          row_key: "id",
          columns: [
            { name: "name", label: "MONITOR", field: "name", sortable: true, align: "left", cell_color_by: XMonitorSelfPlugin.slow_row_color },
            { name: "interval", label: "INTERVAL (S)", field: "interval", sortable: true, align: "right" },
            { name: "last", label: "LAST (S)", field: "last", sortable: true, align: "right" },
            { name: "avg", label: "AVG (S)", field: "avg", sortable: true, align: "right" },
            { name: "max", label: "MAX (S)", field: "max", sortable: true, align: "right" },
            { name: "wait", label: "CHANNEL WAIT (S)", field: "wait", sortable: true, align: "right" },
            { name: "share", label: "% OF INTERVAL", field: "share", sortable: true, align: "right", cell_color_by: XMonitorSelfPlugin.slow_row_color },
          ],
        },
      },
      events: true,
    };
  }
}
