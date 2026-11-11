// Health of a BlockURL blocklist service, checked over HTTP from the X-Monitor host with one X-API-Key-authenticated
// GET of its /urls/domains endpoint, plus a write probe run on the agent that blocks, checks and unblocks a reserved
// URL. Config: api_url (required, X-Monitor-reachable), api_key / api_key_command, min_domains, api_timeout,
// write_probe, probe_url. It counts the domains and blocked URLs in the response; fewer than min_domains domains is
// warning (the database may be empty or wiped), while a non-200 reply or a write that does not round-trip is failed.
// An unreachable API, a malformed response or a probe that could not run at all (agent not connected) is unavailable.
//
// Reading alone cannot see a database whose every write fails, which is how a corrupt index once held this monitor
// green while nothing could be blocked.

import { command, CollectResult, http_request, type CmdResult, type HttpResult, type Request, type Result } from "../core/connectors/types.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { resolve_secret, type PluginConfig } from "./base/plugin_helpers.ts";
import { json_dumps, py_str_repr } from "./base/python_text.ts";

const default_key_command = "cut -d= -f2- /run/secrets/blockurl_api_key";

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parse_response(stdout: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`domains response was not JSON (${(error as Error).message}): ${py_str_repr(stdout.slice(0, 200))}`);
  }
  if (!Array.isArray(data)) throw new Error(`domains response was not a list: ${py_str_repr(stdout.slice(0, 200))}`);
  return data;
}

// The probe could not run at all, which is not evidence that writes fail.
export const AGENT_UNAVAILABLE = "agent-unavailable";

// Python's truthiness of a decoded JSON value.
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

// The text split on single spaces at most twice, as Python's str.split(" ", 2) does.
function split_three(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < 2) {
    const at = rest.indexOf(" ");
    if (at === -1) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}

// Why the block, check and unblock round trip failed, or an empty string when it worked.
export function write_probe_error(result: unknown): string {
  if (result === null || result === undefined) return AGENT_UNAVAILABLE;
  if (typeof result !== "object" || (result as CmdResult).kind !== "cmd") {
    const kind = typeof result === "object" ? String((result as { kind?: unknown }).kind ?? "object") : typeof result;
    return `unexpected probe result type ${kind}`;
  }
  const probe = result as CmdResult;
  if (probe.exit_code !== 0) {
    const detail = (probe.stderr || probe.stdout).trim().slice(0, 200);
    if (detail.includes("is not connected")) return AGENT_UNAVAILABLE;
    return `probe command exited ${probe.exit_code}: ${py_str_repr(detail)}`;
  }

  const fields: Record<string, string> = {};
  for (const part of split_three(probe.stdout.trim())) {
    const at = part.indexOf("=");
    if (at !== -1) fields[part.slice(0, at)] = part.slice(at + 1);
  }
  for (const step of ["block", "unblock"]) {
    if (fields[step] !== "200") return `${step} returned HTTP ${fields[step] || "?"}`;
  }
  let checked: unknown;
  try {
    checked = JSON.parse(fields.check ?? "");
  } catch {
    return `check response was not JSON: ${py_str_repr((fields.check ?? "").slice(0, 200))}`;
  }
  if (!(typeof checked === "object" && checked !== null && !Array.isArray(checked) && Object.values(checked).some(truthy))) {
    return "a URL blocked moments earlier did not read back as blocked";
  }
  return "";
}

const default_layout: LayoutRow[] = [
  ["host_card", "domains_card", "urls_card", "write_card"],
  ["chart"],
  ["events"],
];

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Blockurl extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  // X-Monitor fetches this URL directly; it must be X-Monitor-reachable, with no default.
  readonly api_url: string | null;
  readonly api_key: string | null;
  readonly min_domains: number;
  readonly api_timeout: number;
  readonly write_probe: boolean;
  // Reserved and unreachable, so a probe row left behind by a failed cycle blocks nothing real.
  readonly probe_url: string;
  // Re-read on the agent rather than interpolated, to keep the key out of the command text.
  readonly api_key_command: string;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.api_url = (config.api_url as string | null | undefined) ?? null;
    // Resolved once, on the X-Monitor host, so requests() stays pure.
    this.api_key = resolve_secret(config.api_key as string | null | undefined, "api_key_command" in config ? (config.api_key_command as string | null) : default_key_command);
    this.min_domains = Math.trunc(Number(config.min_domains ?? 1));
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
    this.write_probe = Boolean(config.write_probe ?? true);
    this.probe_url = String(config.probe_url ?? "https://x-monitor-write-probe.invalid/blockurl");
    this.api_key_command = "api_key_command" in config ? String(config.api_key_command) : default_key_command;
  }

  // Warns when the blocklist holds fewer domains than the configured floor.
  domains_color(value: number | null): "warning" | "online" | null {
    if (value === null || value === undefined) return null;
    return value < this.min_domains ? "warning" : "online";
  }

  // Blocks, checks and unblocks the reserved URL in that order, printing each step's outcome.
  probe_command(): string {
    const base = this.api_url!.replace(/\/+$/, "");
    const body = json_dumps({ urls: [this.probe_url] });
    // The key reaches curl on stdin, since every user on the host can read a command line in `ps`.
    const call = 'printf "X-API-Key: %s\\n" "$KEY" | ' + `curl -sS -m ${this.api_timeout} -X POST ` + '-H @- -H "Content-Type: application/json" ' + `-d '${body}'`;
    return (
      `KEY=$(${this.api_key_command}); ` +
      `B=$(${call} -o /dev/null -w '%{http_code}' ${base}/urls/block); ` +
      `C=$(${call} ${base}/urls/check); ` +
      `D=$(${call} -o /dev/null -w '%{http_code}' ${base}/urls/unblock); ` +
      'echo "block=$B unblock=$D check=$C"'
    );
  }

  override requests(): Request[] {
    if (!this.api_url) return [];
    const base = this.api_url.replace(/\/+$/, "");
    const requests: Request[] = [http_request(`${base}/urls/domains`, { timeout: this.api_timeout, headers: { "X-API-Key": this.api_key || "" } })];
    if (this.write_probe) requests.push(command(this.probe_command()));
    return requests;
  }

  override parse_results(results: Result[]): CollectResult {
    if (results.length === 0) return CollectResult.failed("No 'api_url' configured");

    const result = results[0] as HttpResult;
    if (result.error !== null) return CollectResult.unavailable(`Failed to query BlockURL API: ${result.error}`);
    if (result.status_code !== 200) return CollectResult.failed(`BlockURL API returned HTTP ${result.status_code ?? "None"}`);

    let data: unknown[];
    try {
      data = parse_response(result.text);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const domain_count = data.length;
    const url_total = data
      .filter((entry): entry is unknown[] => Array.isArray(entry) && entry.length === 2)
      .reduce<number>((sum, entry) => sum + Math.trunc(Number(entry[1])), 0);

    const metrics: Record<string, number> = { domains_total: domain_count, urls_total: url_total };

    let write_error: string | null = null;
    if (this.write_probe) {
      write_error = write_probe_error(results.length > 1 ? results[1] : null);
      // An unrun probe measured nothing, so it neither passes nor fails the write metric.
      if (write_error !== AGENT_UNAVAILABLE) metrics.write_ok = write_error ? 0.0 : 1.0;
    }

    if (write_error === AGENT_UNAVAILABLE) {
      return new CollectResult({ metrics, logs: [["Write probe did not run: agent not connected", "WARNING"]], status: "unavailable" });
    }
    if (write_error) return new CollectResult({ metrics, logs: [[`Write probe failed: ${write_error}`, "ERROR"]], status: "failed" });

    if (domain_count < this.min_domains) {
      return new CollectResult({
        metrics,
        logs: [[`Only ${domain_count} domain(s) in the blocklist (< ${this.min_domains}) — database may be empty or wiped`, "WARNING"]],
        status: "warning",
      });
    }

    return new CollectResult({ metrics, logs: [[`${domain_count} domain(s), ${url_total} blocked URL(s)`, "INFO"]], status: "online" });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        domains_card: { metric: "domains_total", title: "DOMAINS", format: "int", color: (value) => this.domains_color(value) },
        urls_card: { metric: "urls_total", title: "BLOCKED URLS", format: "count_comma" },
        write_card: { metric: "write_ok", title: "WRITES", format: "int", color: "zero_failed" },
      },
      chart: { metric: "urls_total", title: "BLOCKED URLS" },
      events: true,
    };
  }
}
