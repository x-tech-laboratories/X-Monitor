// Trilium Notes liveness via one authenticated GET of the ETAPI metrics endpoint over HTTP from the X-Monitor host.
// Config: api_url (required, X-Monitor-reachable), token / token_command (the ETAPI token), stale_warning (hours, null
// to turn it off), api_timeout. Note counts are recorded as metrics and the age of the last note modification drives
// status: older than stale_warning, or missing from the response, is warning; an unreachable API, a non-200 reply, or a
// malformed payload (usually a bad token) measured nothing, so it is unavailable.

import { python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { CollectResult, http_request, type HttpResult, type Request, type Result } from "../core/connectors/types.ts";
import { fixed, register_formatter } from "../shared/ui_registry.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { level_for, limit_from, resolve_secret, type PluginConfig } from "./base/plugin_helpers.ts";

type Json = Record<string, unknown>;

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parse_response(stdout: string): Json {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`metrics response was not JSON (${(error as Error).message}): ${python_repr(stdout.slice(0, 200))}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || !("statistics" in data)) {
    throw new Error(`response missing 'statistics' (check the ETAPI token): ${python_repr(stdout.slice(0, 200))}`);
  }
  return data as Json;
}

// Hours since an ISO timestamp, read as UTC when it names no zone; null when absent or unreadable.
export function age_hours(iso_timestamp: string | null | undefined): number | null {
  if (!iso_timestamp) return null;
  const text = iso_timestamp.replace("Z", "+00:00");
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?))?([+-]\d{2}:?\d{2})?$/.exec(text);
  if (match === null) return null;
  const [, date, time, zone] = match;
  const moment = Date.parse(`${date}T${time ?? "00:00:00"}${zone ?? "+00:00"}`);
  if (Number.isNaN(moment)) return null;
  return (Date.now() - moment) / 3_600_000;
}

export function format_age(hours: number): string {
  if (hours < 1) return `${Math.trunc(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// The status and message for a known last-modified age judged against stale_warning.
function staleness_verdict(last_modified_age: number, stale_warning: number | null, total_notes: number): ["warning" | "online", string] {
  const notes = `${fixed(Math.trunc(total_notes), 0, true)} total notes`;
  if (stale_warning !== null && last_modified_age >= stale_warning) {
    return ["warning", `no note modified in ${format_age(last_modified_age)} (>= ${format_age(stale_warning)} threshold) | ${notes}`];
  }
  return ["online", `last modified ${format_age(last_modified_age)} ago | ${notes}`];
}

// ── Monitor ──────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "lastmod_card", "notes_card"],
  ["chart"],
  ["events"],
];

export class Trilium extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  readonly api_url: string | null;
  readonly token: string | null;
  readonly stale_warning: number | null;
  readonly api_timeout: number;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.api_url = (config.api_url as string | null | undefined) ?? null;
    this.token = resolve_secret(config.token as string | null | undefined, config.token_command as string | null | undefined);
    this.stale_warning = limit_from(config, "stale_warning", 72);
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
  }

  // Warns once the newest note's age passes the configured staleness limit.
  lastmod_color(value: number | null): "online" | "warning" | "failed" | null {
    if (value === null) return null;
    return level_for(value, this.stale_warning, null);
  }

  override requests(): Request[] {
    if (!this.api_url) return [];
    const base = this.api_url.replace(/\/+$/, "");
    return [http_request(`${base}/etapi/metrics?format=json`, { timeout: this.api_timeout, headers: { Authorization: this.token ?? "" } })];
  }

  // Turns the ETAPI metrics result into note counts and last-modified age, one summary log line, and a status that is
  // warning when no note changed within stale_warning hours (or the timestamp is missing) and unavailable on errors.
  override parse_results(results: Result[]): CollectResult {
    if (results.length === 0) return CollectResult.unavailable("No 'api_url' configured");

    const result = results[0] as HttpResult;
    if (result.error !== null) return CollectResult.unavailable(`Failed to query Trilium ETAPI: ${result.error}`);
    if (result.status_code !== 200) return CollectResult.unavailable(`Trilium ETAPI returned HTTP ${result.status_code} (check the ETAPI token)`);

    let data: Json;
    try {
      data = parse_response(result.text);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const stats = (data.statistics ?? {}) as Json;
    const database = (data.database ?? {}) as Json;

    const last_modified_age = age_hours(stats.lastModified as string | null | undefined);
    const total_notes = Number(database.totalNotes || 0);
    const active_notes = Number(database.activeNotes || 0);

    const metrics: Record<string, number> = { notes_total: total_notes, notes_active: active_notes };
    if (last_modified_age !== null) metrics.last_modified_age_hours = last_modified_age;

    if (last_modified_age === null) {
      return new CollectResult({ metrics, logs: [["No 'lastModified' timestamp in ETAPI response", "WARNING"]], status: "warning" });
    }

    const [level, message] = staleness_verdict(last_modified_age, this.stale_warning, total_notes);
    return new CollectResult({ metrics, logs: [[message, level === "warning" ? "WARNING" : "INFO"]], status: level });
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        lastmod_card: { metric: "last_modified_age_hours", title: "LAST MODIFIED", format: "trilium_age_ago", color: (value) => this.lastmod_color(value) },
        notes_card: { metric: "notes_total", title: "TOTAL NOTES", format: "count_comma" },
      },
      chart: { metric: "last_modified_age_hours", title: "HOURS SINCE LAST MODIFIED" },
      events: true,
    };
  }
}

// ── Page rules ───────────────────────────────────────────────────────────────

register_formatter("trilium_age_ago", (value) => (value === null ? "--" : `${format_age(value)} ago`));
