// Unbound resolver health, from one script over SSH, sampled locally by the agent on agent-backed hosts, combining
// unbound-control statistics with a live dig probe against the resolver itself. Config: control_cmd, query_host,
// query_port, query_domain, query_timeout, servfail_warning / servfail_threshold (percent, either null to turn it off),
// min_queries. A failed probe lookup or a SERVFAIL rate at servfail_threshold is failed; a rate at servfail_warning is
// warning, with rates only judged once min_queries have been answered. A script that exits non-zero or prints
// unparseable output is unavailable.

import { python_float_repr, python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import { fixed, register_color_rule, register_formatter, threshold_color } from "../shared/ui_registry.ts";
import type { ColorRule, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { level_for, limit_from, SCRIPT_SEP, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";

export { SCRIPT_SEP };

const resolve_ok_markers = ["NOERROR"];

// ── Parsing ──────────────────────────────────────────────────────────────────

export function build_probe_script(control_cmd: string, query_host: string, query_port: number, query_domain: string, query_timeout: number): string {
  return [
    "set -e",
    control_cmd,
    `echo "${SCRIPT_SEP}"`,
    `dig +time=${Math.trunc(query_timeout)} +tries=1 ` +
    `@${shell_quote(query_host)} -p ${Math.trunc(query_port)} ` +
    `${shell_quote(query_domain)} 2>&1 | grep -E "^;; ->>HEADER<<-" || true`,
  ].join("\n");
}

// Python's float() of a stripped text, or null where it would raise.
function python_float(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?|inf(inity)?|nan)$/i.test(trimmed.replaceAll("_", ""))) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered.endsWith("inf") || lowered.endsWith("infinity")) return lowered.startsWith("-") ? -Infinity : Infinity;
  return Number(trimmed.replaceAll("_", ""));
}

export function parse_stats(raw: string): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    const value = python_float(line.slice(at + 1));
    if (value === null) continue;
    stats[line.slice(0, at).trim()] = value;
  }
  return stats;
}

export function resolved_ok(query_output: string): boolean {
  return resolve_ok_markers.some((marker) => query_output.includes(marker));
}

export function split_response(stdout: string): [stats_raw: string, query_raw: string] {
  const at = stdout.indexOf(SCRIPT_SEP);
  if (at === -1) throw new Error(`unexpected control output: ${python_repr(stdout.slice(0, 200))}`);
  return [stdout.slice(0, at).trim(), stdout.slice(at + SCRIPT_SEP.length).trim()];
}

// The metric dict (totals, SERVFAIL and cache-hit rates, uptime) from the control stats and probe outcome.
function stats_metrics(stats: Record<string, number>, resolved: boolean): Record<string, number> {
  const total_answered = stats["total.num.queries"] ?? 0.0;
  const servfail = stats["total.num.servfail"] ?? 0.0;
  const cache_hits = stats["total.num.cachehits"] ?? 0.0;
  const cache_miss = stats["total.num.cachemiss"] ?? 0.0;
  const cache_total = cache_hits + cache_miss;
  return {
    resolved_ok: resolved ? 1.0 : 0.0,
    queries_total: total_answered,
    servfail_total: servfail,
    servfail_rate_pct: total_answered ? (100.0 * servfail) / total_answered : 0.0,
    cache_hit_rate_pct: cache_total ? (100.0 * cache_hits) / cache_total : 0.0,
    uptime_seconds: stats["total.num.uptime"] ?? 0.0,
  };
}

// Judges the probe outcome and SERVFAIL rate against the limits.
function accumulate_resolver_problems(resolved: boolean, total_answered: number, servfail_rate: number, query_domain: string, servfail_warning: number | null, servfail_threshold: number | null, min_queries: number): StatusAccumulator {
  const accumulator = new StatusAccumulator();
  if (!resolved) accumulator.escalate("failed", `probe lookup of ${query_domain} did not resolve`);
  if (total_answered >= min_queries) {
    const level = level_for(servfail_rate, servfail_warning, servfail_threshold);
    if (level === "failed") accumulator.escalate("failed", `SERVFAIL rate ${servfail_rate.toFixed(1)}% >= ${python_float_repr(servfail_threshold!)}%`);
    else if (level === "warning") accumulator.escalate("warning", `SERVFAIL rate ${servfail_rate.toFixed(1)}% >= ${python_float_repr(servfail_warning!)}%`);
  }
  return accumulator;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "resolution_card", "servfail_card"],
  ["queries_card", "cache_card", "uptime_card"],
  ["chart"],
  ["events"],
];

export class Unbound extends Plugin {
  override readonly SAMPLED = true;
  readonly control_cmd: string;
  readonly query_host: string;
  readonly query_port: number;
  readonly query_domain: string;
  readonly query_timeout: number;
  readonly servfail_warning: number | null;
  readonly servfail_threshold: number | null;
  readonly min_queries: number;
  private readonly servfail_color: ColorRule;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.control_cmd = String(config.control_cmd ?? "unbound-control stats_noreset");
    this.query_host = String(config.query_host ?? "127.0.0.1");
    this.query_port = Math.trunc(Number(config.query_port ?? 53));
    this.query_domain = String(config.query_domain ?? "cloudflare.com");
    this.query_timeout = Math.trunc(Number(config.query_timeout ?? 5));
    this.servfail_warning = limit_from(config, "servfail_warning", 5);
    this.servfail_threshold = limit_from(config, "servfail_threshold", 20);
    this.min_queries = Math.trunc(Number(config.min_queries ?? 20));
    this.servfail_color = threshold_color(this.servfail_warning, this.servfail_threshold);
  }

  override commands(): Command[] {
    return [command(build_probe_script(this.control_cmd, this.query_host, this.query_port, this.query_domain, this.query_timeout))];
  }

  // Turns the stats and dig probe output into query, SERVFAIL, cache and uptime metrics, one summary log line, and a
  // status where a failed probe lookup or a SERVFAIL rate at the threshold is failed and one at the warning is warning.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to query Unbound: ${stderr.trim()}`);

    let stats_raw: string;
    let query_output: string;
    try {
      [stats_raw, query_output] = split_response(stdout);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const stats = parse_stats(stats_raw);
    const resolved = resolved_ok(query_output);
    const metrics = stats_metrics(stats, resolved);

    const accumulator = accumulate_resolver_problems(resolved, metrics.queries_total, metrics.servfail_rate_pct, this.query_domain, this.servfail_warning, this.servfail_threshold, this.min_queries);

    const parts = [
      resolved ? "resolved OK" : "resolution FAILED",
      `${metrics.servfail_rate_pct.toFixed(1)}% SERVFAIL`,
      `${fixed(Math.trunc(metrics.queries_total), 0, true)} queries`,
      `${metrics.cache_hit_rate_pct.toFixed(1)}% cache hit`,
    ];
    if (accumulator.problems.length > 0) parts.push("| " + accumulator.problems.join("; "));

    return new CollectResult({ metrics, logs: [[parts.join(" | "), accumulator.log_level]], status: accumulator.status });
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        resolution_card: { metric: "resolved_ok", title: "RESOLUTION", format: "unbound_resolution_text", color: "unbound_resolution_color" },
        servfail_card: { metric: "servfail_rate_pct", title: "SERVFAIL RATE", format: "percent1_plain_dash", color: this.servfail_color },
        queries_card: { metric: "queries_total", title: "QUERIES", format: "count_comma" },
        cache_card: { kind: "gauge", metric: "cache_hit_rate_pct", title: "CACHE HIT RATE", format: "percent1_plain_dash" },
        uptime_card: { metric: "uptime_seconds", title: "UPTIME", format: "unbound_uptime" },
      },
      chart: { metric: "servfail_rate_pct", title: "SERVFAIL RATE (%)" },
      events: true,
    };
  }
}

// ── Page rules ───────────────────────────────────────────────────────────────

register_formatter("unbound_resolution_text", (value) => (value === null ? "--" : value >= 1.0 ? "OK" : "FAILED"));
register_color_rule("unbound_resolution_color", (value) => (value === null ? null : value >= 1.0 ? "online" : "failed"));
register_formatter("unbound_uptime", (value) => {
  if (value === null) return "--";
  const days = Math.trunc(Math.floor(value / 86400));
  const hours = Math.trunc(Math.floor((value % 86400) / 3600));
  return days ? `${days}d ${hours}h` : `${hours}h`;
});
