// FreshRSS feed freshness via the Fever API, queried over HTTP from the X-Monitor host using the Fever protocol's md5
// username:password token. Config: api_url (required, X-Monitor-reachable), username, api_password /
// api_password_command, feed_stale_warning, feed_stale_threshold, refresh_stale_warning (all in hours, each null to
// turn it off), api_timeout. The refresh-cycle age is the newest per-feed fetch time, the one signal that proves the
// updater is running, since FreshRSS fills Fever's last_refreshed_on_time with the oldest feed's fetch, which one
// paused feed would keep permanently stale. A stale refresh cycle or aging feeds are warning; any feed older than
// feed_stale_threshold is failed, as are HTTP and auth errors. A missing configuration, a transport error, or an
// unreadable response is unavailable, since no feed was measured.

import { createHash } from "node:crypto";

import { python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { CollectResult, http_request, type HttpResult, type Request, type Result } from "../core/connectors/types.ts";
import { register_formatter } from "../shared/ui_registry.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { level_for, limit_from, resolve_secret, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";

type Json = Record<string, unknown>;

// ── Parsing ──────────────────────────────────────────────────────────────────

// The Fever API's own scheme: an md5 of "username:password", sent as a form field.
export function fever_api_key(username: string, password: string): string {
  return createHash("md5").update(`${username}:${password}`, "utf8").digest("hex");
}

// The credentials were rejected, which fails the monitor rather than leaving it unmeasured.
export class FeverAuthError extends Error {}

export function parse_response(stdout: string): Json {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Fever API response was not JSON (${(error as Error).message}): ${python_repr(stdout.slice(0, 200))}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || !("auth" in data)) {
    throw new Error(`response missing 'auth': ${python_repr(stdout.slice(0, 200))}`);
  }
  if ((data as Json).auth !== 1) throw new FeverAuthError("Fever API rejected the credentials (check username / api_password_command)");
  return data as Json;
}

export function format_age(hours: number): string {
  if (hours < 1) return `${Math.trunc(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

type Aged = [title: unknown, age: number];

// Buckets feeds into warning and failure lists of (title, age in hours) by how long since each last updated.
function survey_feeds(feeds: Json[], now: number, feed_stale_warning: number | null, feed_stale_threshold: number | null): [warn: Aged[], fail: Aged[]] {
  const stale_warn: Aged[] = [];
  const stale_fail: Aged[] = [];
  for (const feed of feeds) {
    const age = (now - Number(feed.last_updated_on_time || 0)) / 3600.0;
    const title = feed.title ?? "?";
    const level = level_for(age, feed_stale_warning, feed_stale_threshold);
    if (level === "failed") stale_fail.push([title, age]);
    else if (level === "warning") stale_warn.push([title, age]);
  }
  return [stale_warn, stale_fail];
}

// The most recent per-feed fetch time, falling back to the Fever field when there are no feeds.
function newest_fetch(feeds: Json[], fallback: unknown): number {
  const times = feeds.map((feed) => Number(feed.last_updated_on_time || 0));
  return times.length > 0 ? Math.max(...times) : Number(fallback || 0);
}

function named(feeds: Aged[]): string {
  const names = feeds.slice(0, 3).map(([title, age]) => `${String(title)} (${format_age(age)})`).join(", ");
  return names + (feeds.length > 3 ? ` (+${feeds.length - 3} more)` : "");
}

// Folds the refresh-cycle age and stale-feed buckets into problem lines and a worst-of status.
function accumulate_freshness(refresh_age_hours: number, stale_warn: Aged[], stale_fail: Aged[], refresh_stale_warning: number | null): StatusAccumulator {
  const accumulator = new StatusAccumulator();
  if (level_for(refresh_age_hours, refresh_stale_warning, null) === "warning") {
    accumulator.escalate("warning", `refresh cycle stale (${format_age(refresh_age_hours)} since last run)`);
  }
  if (stale_fail.length > 0) accumulator.escalate("failed", `${stale_fail.length} feed(s) stale: ${named(stale_fail)}`);
  if (stale_warn.length > 0) accumulator.escalate("warning", `${stale_warn.length} feed(s) aging: ${named(stale_warn)}`);
  return accumulator;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "refresh_card", "feeds_card"],
  ["stale_card", "share_card"],
  ["chart"],
  ["events"],
];

export class Freshrss extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  readonly api_url: string | null;
  readonly username: string | null;
  readonly api_password: string | null;
  readonly feed_stale_warning: number | null;
  readonly feed_stale_threshold: number | null;
  readonly refresh_stale_warning: number | null;
  readonly api_timeout: number;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.api_url = (config.api_url as string | null | undefined) ?? null;
    this.username = (config.username as string | null | undefined) ?? null;
    this.api_password = resolve_secret(config.api_password as string | null | undefined, config.api_password_command as string | null | undefined);
    this.feed_stale_warning = limit_from(config, "feed_stale_warning", 48);
    this.feed_stale_threshold = limit_from(config, "feed_stale_threshold", 168);
    this.refresh_stale_warning = limit_from(config, "refresh_stale_warning", 6);
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
  }

  // Warns once the last feed refresh is older than the configured limit.
  refresh_color(value: number | null): "online" | "warning" | "failed" | null {
    if (value === null) return null;
    return level_for(value, this.refresh_stale_warning, null);
  }

  override requests(): Request[] {
    if (!this.api_url || !this.username) return [];
    const base = this.api_url.replace(/\/+$/, "");
    const token = fever_api_key(this.username, this.api_password ?? "");
    return [http_request(`${base}/api/fever.php?api&feeds`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `api_key=${token}`,
      timeout: this.api_timeout,
    })];
  }

  // Turns the Fever API result into refresh-age and total, stale and fresh feed-count metrics, one summary log line,
  // and a status where any feed past feed_stale_threshold is failed and a stale refresh cycle or aging feeds warn.
  override parse_results(results: Result[]): CollectResult {
    if (!this.api_url) return CollectResult.unavailable("No 'api_url' configured");
    if (!this.username) return CollectResult.unavailable("No username configured — set username/api_password_command");

    const result = results[0] as HttpResult;
    if (result.error !== null) return CollectResult.unavailable(`Failed to query Fever API: ${result.error}`);
    if (result.status_code !== 200) return CollectResult.failed(`Fever API returned HTTP ${result.status_code}`);

    let data: Json;
    try {
      data = parse_response(result.text);
    } catch (error) {
      if (error instanceof FeverAuthError) return CollectResult.failed(error.message);
      return CollectResult.unavailable((error as Error).message);
    }

    const feeds = (data.feeds ?? []) as Json[];
    const now = Date.now() / 1000;
    const refresh_age_hours = (now - newest_fetch(feeds, data.last_refreshed_on_time)) / 3600.0;

    const [stale_warn, stale_fail] = survey_feeds(feeds, now, this.feed_stale_warning, this.feed_stale_threshold);

    const stale_count = stale_warn.length + stale_fail.length;
    // Fever's feed list carries no fetch-error field, so erroring feeds cannot be counted.
    const metrics = {
      refresh_age_hours,
      feeds_total: feeds.length,
      feeds_stale: stale_count,
      feeds_fresh: feeds.length - stale_count,
    };

    const accumulator = accumulate_freshness(refresh_age_hours, stale_warn, stale_fail, this.refresh_stale_warning);

    const parts = [`${feeds.length} feed(s)`, `refreshed ${format_age(refresh_age_hours)} ago`];
    if (accumulator.problems.length > 0) parts.push("| " + accumulator.problems.join("; "));

    return new CollectResult({ metrics, logs: [[parts.join(" | "), accumulator.log_level]], status: accumulator.status });
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        refresh_card: { metric: "refresh_age_hours", title: "LAST REFRESH", format: "freshrss_age", color: (value) => this.refresh_color(value) },
        feeds_card: { metric: "feeds_total", title: "FEEDS", format: "int" },
        stale_card: { metric: "feeds_stale", title: "STALE FEEDS", format: "int", color: "nonzero_warning" },
        share_card: {
          kind: "share",
          title: "FRESHNESS",
          format: "int",
          parts: [
            { metric: "feeds_fresh", label: "Fresh", color: "online" },
            { metric: "feeds_stale", label: "Stale", color: "warning" },
          ],
        },
      },
      chart: { metric: "refresh_age_hours", title: "REFRESH AGE (HOURS)" },
      events: true,
    };
  }
}

// ── Page rules ───────────────────────────────────────────────────────────────

register_formatter("freshrss_age", (value) => (value === null ? "--" : format_age(value)));
