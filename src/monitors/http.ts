// Generic endpoint probe: is this URL reachable and answering sanely, and how fast. An http(s) url is fetched from the
// X-Monitor host (method, headers, body and basic auth configurable); a ws(s) url is probed with websocat on the
// target, sampled locally by the agent on agent-backed hosts. Config: url (required), method, headers, body (request
// body, or the text sent into the websocket), username, password / password_command, request_timeout, check_title,
// and expect: status (int or list, http only, default 200), body_contains (all must appear, case-insensitive) and
// body_contains_any (at least one). A reply matching every expectation is online, with latency recorded on the http
// path; anything else is failed, with no warning tier.

import { python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, http_request, type CmdResult, type Command, type HttpResult, type Request, type Result } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import { register_color_rule, register_formatter } from "../shared/ui_registry.ts";
import type { CardSpec, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { resolve_secret, type PluginConfig } from "./base/plugin_helpers.ts";

// ── Matching ─────────────────────────────────────────────────────────────────

// A scalar-or-list config value as a list.
function as_list(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Whether the body fails the expect block's case-insensitive contains checks.
export function body_mismatch(body: string, expect: Record<string, unknown>): boolean {
  const lowered = body.toLowerCase();
  const needed = as_list(expect.body_contains).map((item) => String(item).toLowerCase());
  if (needed.some((item) => !lowered.includes(item))) return true;
  const any_of = as_list(expect.body_contains_any).map((item) => String(item).toLowerCase());
  return any_of.length > 0 && !any_of.some((item) => lowered.includes(item));
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class HttpCheck extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  override readonly AVAILABILITY = true;
  override readonly SAMPLED = true;
  // An http(s) url is fetched from the X-Monitor host and must be reachable from it.
  readonly url: string | null;
  readonly is_ws: boolean;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly username: string | null;
  readonly password: string | null;
  readonly request_timeout: number;
  readonly expect: Record<string, unknown>;
  readonly check_title: string;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.url = (config.url as string | null | undefined) ?? null;
    this.is_ws = Boolean(this.url) && ["ws", "wss"].includes(this.url!.split(":", 1)[0]);
    this.method = String(config.method ?? "GET");
    this.headers = (config.headers as Record<string, string> | null | undefined) || {};
    this.body = (config.body as string | null | undefined) ?? null;
    this.username = (config.username as string | null | undefined) ?? null;
    // Resolved once, on the X-Monitor host, so requests() stays pure.
    this.password = resolve_secret(config.password as string | null | undefined, config.password_command as string | null | undefined);
    this.request_timeout = Math.trunc(Number(config.request_timeout ?? 10));
    this.expect = (config.expect as Record<string, unknown> | null | undefined) || {};
    this.check_title = String(config.check_title ?? "PROBE");
  }

  override commands(): Command[] {
    if (!(this.is_ws && this.url)) return [];
    const send = this.body ? `echo ${shell_quote(this.body)} | ` : "";
    return [command(`${send}timeout ${this.request_timeout} websocat -n1 ${shell_quote(this.url)}`)];
  }

  override requests(): Request[] {
    if (this.is_ws) return this.commands();
    if (!this.url) return [];
    const auth: [string, string] | null = this.username ? [this.username, this.password || ""] : null;
    return [http_request(this.url, { method: this.method, timeout: this.request_timeout, headers: this.headers, body: this.body, auth })];
  }

  override parse(results: CmdResult[]): CollectResult {
    const result = results[0];
    if (result.exit_code !== 0) {
      return new CollectResult({
        metrics: { probe_ok: 0.0 },
        logs: [[`WebSocket probe failed: ${result.stderr.trim() || "timed out or connection refused"}`, "ERROR"]],
        status: "failed",
      });
    }
    if (body_mismatch(result.stdout, this.expect)) {
      return new CollectResult({
        metrics: { probe_ok: 0.0 },
        logs: [[`WebSocket reply did not match 'expect': ${python_repr(result.stdout.slice(0, 200))}`, "ERROR"]],
        status: "failed",
      });
    }
    return new CollectResult({ metrics: { probe_ok: 1.0 }, logs: [["WebSocket probe OK", "INFO"]], status: "online" });
  }

  override parse_results(results: Result[]): CollectResult {
    if (results.length === 0) return CollectResult.failed("No 'url' configured");
    if (this.is_ws) return this.parse(results as CmdResult[]);

    const result = results[0] as HttpResult;
    if (result.error !== null) {
      return new CollectResult({ metrics: { probe_ok: 0.0 }, logs: [[`Probe request failed: ${result.error}`, "ERROR"]], status: "failed" });
    }

    const status = result.status_code || 0;
    const elapsed_ms = result.elapsed_ms;
    const metrics: Record<string, number> = { probe_status: status, probe_latency_ms: elapsed_ms };

    const listed = as_list(this.expect.status).map((item) => Math.trunc(Number(item)));
    const expected = listed.length > 0 ? listed : [200];
    if (!expected.includes(status)) {
      metrics.probe_ok = 0.0;
      const hint = status === 401 ? " — check the configured credentials" : "";
      return new CollectResult({ metrics, logs: [[`Probe returned unexpected status ${status}${hint}`, "ERROR"]], status: "failed" });
    }

    if (body_mismatch(result.text, this.expect)) {
      metrics.probe_ok = 0.0;
      return new CollectResult({
        metrics,
        logs: [[`Probe returned ${status} but the body did not match 'expect' — likely a login or error page instead of real data`, "ERROR"]],
        status: "failed",
      });
    }

    metrics.probe_ok = 1.0;
    return new CollectResult({ metrics, logs: [[`Probe OK (${status}, ${elapsed_ms.toFixed(0)}ms)`, "INFO"]], status: "online" });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    const probe_card: CardSpec = { metric: "probe_ok", title: this.check_title, format: "probe_ok_text", color: "probe_ok_color" };
    const uptime_strip: CardSpec = { kind: "strip", metric: "probe_ok", title: `${this.check_title} HISTORY` };
    if (this.is_ws) {
      return {
        layout: [["host_card", "probe_card"], ["uptime_strip"], ["chart"], ["events"]],
        cards: { probe_card, uptime_strip },
        chart: { metric: "probe_ok", title: `${this.check_title} OK` },
        events: true,
      };
    }
    return {
      layout: [["host_card", "probe_card", "latency_card"], ["uptime_strip"], ["chart"], ["events"]],
      cards: { probe_card, uptime_strip, latency_card: { metric: "probe_latency_ms", title: "LATENCY", format: "ms0" } },
      chart: { metric: "probe_latency_ms", title: `${this.check_title} LATENCY (ms)` },
      events: true,
    };
  }
}

// ── Page rules ───────────────────────────────────────────────────────────────

// A probe_ok metric as OK or FAILED.
register_formatter("probe_ok_text", (value) => (value === null || value === undefined ? "--" : value >= 1.0 ? "OK" : "FAILED"));

// A probe_ok metric as online or failed.
register_color_rule("probe_ok_color", (value) => (value === null || value === undefined ? null : value >= 1.0 ? "online" : "failed"));
