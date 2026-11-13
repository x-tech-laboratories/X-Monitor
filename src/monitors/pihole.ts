// Pi-hole effectiveness via the FTL v6 API, fetched by one curl script over SSH, sampled locally by the agent on
// agent-backed hosts, that authenticates for a session, reads /api/stats/summary and /api/dns/blocking, and releases
// the session on exit. Config: api_url, api_password / api_password_command, block_rate_warning,
// block_rate_threshold, gravity_max_age, min_queries, api_timeout, gravity_timeout. Disabled blocking, an empty gravity
// list, or a block rate under block_rate_threshold (once min_queries is reached) is failed; a merely low block rate or a
// stale gravity list is warning; an API that did not answer, or answered with something unparseable, is unavailable.
// Either block_rate limit may be null to turn that level off, and setting both to 0 or null stops the rate being
// judged at all: it is then charted but sets neither the status nor the card colour.

import { python_dumps, python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import type { Status } from "../shared/status.ts";
import { fixed } from "../shared/ui_registry.ts";
import type { ActionButtonSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { dq, limit_from, parse_duration, password_line, python_g, SCRIPT_SEP, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";

export { SCRIPT_SEP };

type Json = Record<string, unknown>;

// ── Scripts ──────────────────────────────────────────────────────────────────

function auth_preamble(base: string, timeout: number, password_command: string | null, password: string | null): [lines: string[], auth: string] {
  if (!(password_command || password)) return [[], ""];

  // Every user on the host can read a command line in `ps`, so the password reaches curl on stdin and the sid a private file.
  const lines = [password_line(password_command, password)];
  lines.push(
    `__sid=$(printf '{"password":"%s"}' "$__pw" | ` +
    `curl -s -m ${timeout} -X POST ${shell_quote(base + "/api/auth")} ` +
    '-H "Content-Type: application/json" --data @- ' +
    `| sed -n 's/.*"sid"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')`,
  );
  lines.push("__hdr=$(mktemp)");
  // Releases the session however the script exits, since FTL's session table is finite.
  lines.push(`trap '[ -n "$__sid" ] && curl -s -m ${timeout} -X DELETE -H @"$__hdr" ${dq(base + "/api/auth")} >/dev/null 2>&1; rm -f "$__hdr"' EXIT`);
  lines.push('printf "X-FTL-SID: %s\\n" "$__sid" > "$__hdr"');
  return [lines, '-H @"$__hdr"'];
}

function base_of(api_url: string): string {
  return api_url.replace(/\/+$/, "");
}

export function build_fetch_script(api_url: string, timeout: number, password_command: string | null, password: string | null): string {
  const base = base_of(api_url);
  const [auth_lines, auth] = auth_preamble(base, timeout, password_command, password);
  return [
    "set -e",
    ...auth_lines,
    `curl -s -m ${timeout} ${auth} ${shell_quote(base + "/api/stats/summary")}`,
    `echo "${SCRIPT_SEP}"`,
    `curl -s -m ${timeout} ${auth} ${shell_quote(base + "/api/dns/blocking")}`,
  ].join("\n");
}

export function build_blocking_script(api_url: string, timeout: number, password_command: string | null, password: string | null, enabled: boolean): string {
  const base = base_of(api_url);
  const [auth_lines, auth] = auth_preamble(base, timeout, password_command, password);
  const body = python_dumps({ blocking: enabled, timer: null });
  return [
    "set -e",
    ...auth_lines,
    `curl -s -f -m ${timeout} -X POST ${auth} -H "Content-Type: application/json" --data ${shell_quote(body)} ${shell_quote(base + "/api/dns/blocking")}`,
  ].join("\n");
}

export function build_gravity_script(api_url: string, timeout: number, password_command: string | null, password: string | null): string {
  const base = base_of(api_url);
  const [auth_lines, auth] = auth_preamble(base, timeout, password_command, password);
  return ["set -e", ...auth_lines, `curl -s -f -m ${timeout} ${auth} ${shell_quote(base + "/api/action/gravity")} > /dev/null`].join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function json_or_throw(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch (error) {
    throw new Error(`${what} was not JSON (${(error as Error).message}): ${python_repr(raw.slice(0, 200))}`);
  }
}

function as_object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

export function parse_response(stdout: string): [summary: Json, blocking: Json] {
  const at = stdout.indexOf(SCRIPT_SEP);
  if (at === -1) throw new Error(`unexpected API response: ${python_repr(stdout.slice(0, 200))}`);
  const summary_raw = stdout.slice(0, at);
  const blocking_raw = stdout.slice(at + SCRIPT_SEP.length);
  const summary = as_object(json_or_throw(summary_raw, "summary"));
  const blocking = as_object(json_or_throw(blocking_raw, "blocking status"));

  if (!("queries" in summary)) {
    const error = summary.error;
    if (typeof error === "object" && error !== null && !Array.isArray(error)) {
      const message = (error as Json).message ?? "unknown error";
      throw new Error(`API returned an error: ${message} (set api_password if auth is required)`);
    }
    throw new Error(`summary missing 'queries': ${python_repr(summary_raw.slice(0, 200))}`);
  }
  return [summary, blocking];
}

function number_of(value: unknown): number {
  return Number(value || 0);
}

// The blocked-query percentage, computed from the totals when the API omits it.
function block_rate(queries: Json): number {
  const rate = queries.percent_blocked;
  if (rate === null || rate === undefined) {
    const total = number_of(queries.total);
    const blocked = number_of(queries.blocked);
    return total ? (100.0 * blocked) / total : 0.0;
  }
  return Number(rate);
}

// Flattens the summary and blocking payloads into the metric dict.
function collect_metrics(summary: Json, blocking: Json): Record<string, number> {
  const queries = as_object(summary.queries ?? {});
  const gravity = as_object(summary.gravity ?? {});
  const clients = as_object(summary.clients ?? {});
  return {
    block_rate_pct: block_rate(queries),
    queries_total: number_of(queries.total),
    queries_blocked: number_of(queries.blocked),
    queries_forwarded: number_of(queries.forwarded),
    queries_cached: number_of(queries.cached),
    unique_domains: number_of(queries.unique_domains),
    gravity_domains: number_of(gravity.domains_being_blocked),
    clients_active: number_of(clients.active),
    blocking_enabled: blocking.blocking === "enabled" ? 1.0 : 0.0,
  };
}

// Seconds since the last gravity update, or null if it never ran.
function gravity_age_seconds(gravity: Json, now: number): number | null {
  const last_update = gravity.last_update;
  if (!last_update) return null;
  return Math.max(0.0, now - Number(last_update));
}

// Whether the block rate is judged at all: both limits at zero or null turn it off, since the rate measures what
// clients asked for, not whether Pi-hole still blocks; blocking state and the gravity list answer that regardless.
export function rate_is_checked(warning: number | null, threshold: number | null): boolean {
  return [warning, threshold].some((limit) => limit !== null && limit > 0);
}

// The block rate's level, where falling strictly under a limit fires it and a null limit never fires.
function rate_level(rate: number, warning: number | null, threshold: number | null): "online" | "warning" | "failed" {
  if (threshold !== null && rate < threshold) return "failed";
  if (warning !== null && rate < warning) return "warning";
  return "online";
}

export function format_age_compact(value: number): string {
  const seconds = Math.trunc(value);
  const days = Math.floor(seconds / 86400);
  const rest = seconds % 86400;
  const hours = Math.floor(rest / 3600);
  if (days) return `${days}d ${hours}h`;
  const minutes = Math.floor((rest % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Judges blocking state, block rate, and gravity freshness against the limits.
function evaluate_health(metrics: Record<string, number>, gravity_age: number | null, block_rate_warning: number | null, block_rate_threshold: number | null, gravity_max_age: number, min_queries: number): StatusAccumulator {
  const accumulator = new StatusAccumulator();
  const rate = metrics.block_rate_pct;

  if (metrics.blocking_enabled !== 1.0) accumulator.escalate("failed", "blocking is DISABLED");
  if (metrics.gravity_domains <= 0) accumulator.escalate("failed", "gravity list is empty");

  if (rate_is_checked(block_rate_warning, block_rate_threshold) && metrics.queries_total >= min_queries) {
    const level = rate_level(rate, block_rate_warning, block_rate_threshold);
    if (level === "failed") accumulator.escalate("failed", `block rate ${rate.toFixed(1)}% below ${python_g(block_rate_threshold!)}%`);
    else if (level === "warning") accumulator.escalate("warning", `block rate ${rate.toFixed(1)}% below ${python_g(block_rate_warning!)}%`);
  }

  if (gravity_age === null) accumulator.escalate("warning", "gravity has never been updated");
  else if (gravity_age > gravity_max_age) accumulator.escalate("warning", `gravity list is ${format_age_compact(gravity_age)} old`);
  return accumulator;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "block_rate_card", "queries_card"],
  ["gravity_card", "clients_card", "blocking_card"],
  ["chart"],
  ["events"],
];

export class Pihole extends Plugin {
  override readonly SAMPLED = true;
  readonly api_url: string;
  readonly api_password: string | null;
  readonly api_password_command: string | null;
  readonly block_rate_warning: number | null;
  readonly block_rate_threshold: number | null;
  readonly gravity_max_age: number;
  readonly min_queries: number;
  readonly api_timeout: number;
  readonly gravity_timeout: number;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.api_url = String(config.api_url ?? "http://127.0.0.1:80");
    this.api_password = (config.api_password as string | null | undefined) ?? null;
    this.api_password_command = (config.api_password_command as string | null | undefined) ?? null;
    this.block_rate_warning = limit_from(config, "block_rate_warning", 5);
    this.block_rate_threshold = limit_from(config, "block_rate_threshold", 1);
    this.gravity_max_age = parse_duration(config.gravity_max_age ?? "8d");
    this.min_queries = Math.trunc(Number(config.min_queries ?? 100));
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
    this.gravity_timeout = Math.trunc(Number(config.gravity_timeout ?? 120));
  }

  override commands(): Command[] {
    return [command(build_fetch_script(this.api_url, this.api_timeout, this.api_password_command, this.api_password))];
  }

  // Turns the summary and blocking curl output into query, gravity and client metrics, one summary log line, and a
  // status where disabled blocking, an empty gravity list, or a block rate under the threshold is failed, a low rate
  // or stale gravity is warning, and an API that did not answer or could not be parsed is unavailable.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to query Pi-hole API: ${stderr.trim()}`);

    let summary: Json;
    let blocking: Json;
    try {
      [summary, blocking] = parse_response(stdout);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const metrics = collect_metrics(summary, blocking);
    const gravity_age = gravity_age_seconds(as_object(summary.gravity ?? {}), Date.now() / 1000);
    if (gravity_age !== null) metrics.gravity_age_seconds = gravity_age;

    const accumulator = evaluate_health(metrics, gravity_age, this.block_rate_warning, this.block_rate_threshold, this.gravity_max_age, this.min_queries);

    const parts = [
      `${metrics.block_rate_pct.toFixed(1)}% blocked`,
      `${fixed(Math.trunc(metrics.queries_total), 0, true)} queries`,
      `${fixed(Math.trunc(metrics.gravity_domains), 0, true)} domains on list`,
      `${Math.trunc(metrics.clients_active)} active clients`,
    ];
    if (gravity_age !== null) parts.push(`list ${format_age_compact(gravity_age)} old`);
    if (accumulator.problems.length > 0) parts.push("| " + accumulator.problems.join("; "));

    return new CollectResult({ metrics, logs: [[parts.join(" | "), accumulator.log_level]], status: accumulator.status });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    return [
      { name: "Blocking", kind: "toggle", metric: "blocking_enabled", icon: "shield", on_action_id: "enable_blocking", off_action_id: "disable_blocking" } as ActionButtonSpec,
      { name: "Update Gravity", action_id: "update_gravity", variant: "secondary", icon: "refresh" },
    ];
  }

  override plan_action(action_id: string): ActionPlanResult {
    if (action_id === "enable_blocking" || action_id === "disable_blocking") {
      return action_plan(build_blocking_script(this.api_url, this.api_timeout, this.api_password_command, this.api_password, action_id === "enable_blocking"));
    }
    if (action_id === "update_gravity") {
      return action_plan(build_gravity_script(this.api_url, this.gravity_timeout, this.api_password_command, this.api_password), { timeout: this.gravity_timeout });
    }
    return null;
  }

  override interpret_action(action_id: string, result: unknown): ActionOutcome {
    const outcome = result as CmdResult;
    if (action_id === "enable_blocking" || action_id === "disable_blocking") {
      const verb = action_id === "enable_blocking" ? "enable" : "disable";
      if (outcome.exit_code !== 0) return CollectResult.failed(`Failed to ${verb} blocking: ${outcome.stderr.trim()}`);
      return new CollectResult({ logs: [[`Blocking ${verb}d`, "INFO"]], success: true });
    }
    if (action_id === "update_gravity") {
      if (outcome.exit_code !== 0) return CollectResult.failed(`Gravity update failed: ${outcome.stderr.trim()}`);
      return new CollectResult({ logs: [["Gravity update triggered", "INFO"]], success: true });
    }
    return outcome.exit_code === 0;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  // Null leaves the card unstyled, so a rate nothing judges reads as the figure it is rather than a health verdict.
  block_rate_color(value: number | null): Status | null {
    if (value === null) return null;
    if (!rate_is_checked(this.block_rate_warning, this.block_rate_threshold)) return null;
    return rate_level(value, this.block_rate_warning, this.block_rate_threshold);
  }

  gravity_text(values: Record<string, unknown>): string {
    const domains = values.gravity_domains;
    if (domains === null || domains === undefined) return "--";
    let text = `${fixed(Math.trunc(Number(domains)), 0, true)} domains`;
    const age = values.gravity_age_seconds;
    if (age !== null && age !== undefined) text += ` (${format_age_compact(Number(age))} old)`;
    return text;
  }

  gravity_color(values: Record<string, unknown>): Status | null {
    const age = values.gravity_age_seconds;
    if (age === null || age === undefined) return null;
    return Number(age) > this.gravity_max_age ? "warning" : "online";
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        block_rate_card: { kind: "gauge", metric: "block_rate_pct", title: "BLOCK RATE", format: "percent1", color: (value) => this.block_rate_color(value) },
        queries_card: {
          kind: "share",
          title: "QUERIES",
          format: "count_comma",
          parts: [
            { metric: "queries_blocked", label: "Blocked", color: "accent" },
            { metric: "queries_forwarded", label: "Forwarded", color: "series-2" },
            { metric: "queries_cached", label: "Cached", color: "series-3" },
          ],
        },
        gravity_card: { title: "BLOCKLIST", metrics: ["gravity_domains", "gravity_age_seconds"], format_fn: (values) => this.gravity_text(values), color_fn: (values) => this.gravity_color(values) },
        clients_card: { metric: "clients_active", title: "ACTIVE CLIENTS", format: "int" },
        blocking_card: {
          metric: "blocking_enabled",
          title: "BLOCKING",
          format: (value) => (value === null ? "--" : value >= 1.0 ? "ENABLED" : "DISABLED"),
          color: (value) => (value === null ? null : value >= 1.0 ? "online" : "failed"),
        },
      },
      chart: { metric: "block_rate_pct", title: "BLOCK RATE (%)" },
      events: true,
    };
  }
}
