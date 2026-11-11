// Traccar GPS-device freshness via one GET of /api/devices over HTTP from the X-Monitor host, basic-authenticated as a
// dedicated x-monitor account. Config: api_url (required, X-Monitor-reachable), username, password / password_command,
// devices (names to watch, default all enabled), stale_warning / stale_threshold (hours, either null to turn it off),
// api_timeout. A device silent past stale_warning is warning; one past stale_threshold, or that never reported, is
// failed; no matching enabled devices is a warning. Transport, auth and payload errors mean nothing was measured, so
// they are unavailable.

import { CollectResult, http_request, type HttpResult, type Request, type Result } from "../core/connectors/types.ts";
import type { Status } from "../shared/status.ts";
import { register_color_rule } from "../shared/ui_registry.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { level_for, limit_from, resolve_secret, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";
import { py_str_repr } from "./base/python_text.ts";

// ── Parsing ──────────────────────────────────────────────────────────────────

type Device = Record<string, unknown>;

export function parse_response(stdout: string): Device[] {
  let devices: unknown;
  try {
    devices = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`device list was not JSON (${(error as Error).message}): ${py_str_repr(stdout.slice(0, 200))}`);
  }
  if (!Array.isArray(devices)) throw new Error(`device list was not a list: ${py_str_repr(stdout.slice(0, 200))}`);
  return devices as Device[];
}

const iso_pattern = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

// Hours since an ISO timestamp, reading one without a zone as UTC; null when absent or unreadable.
export function age_hours(last_update: unknown): number | null {
  if (!last_update || typeof last_update !== "string") return null;
  const text = last_update.trim();
  const match = iso_pattern.exec(text);
  if (match === null) return null;
  let normalized = text.replace(" ", "T");
  if (!normalized.includes("T")) normalized += "T00:00:00";
  if (match[1] === undefined) normalized += "Z";
  const moment = new Date(normalized);
  if (Number.isNaN(moment.getTime())) return null;
  return (Date.now() - moment.getTime()) / 3_600_000;
}

// The unavailable CollectResult for a transport, auth, or HTTP error, or null when the response is usable.
function http_failure(result: HttpResult): CollectResult | null {
  if (result.error !== null) return CollectResult.unavailable(`Failed to query Traccar API: ${result.error}`);
  if (result.status_code === 401) return CollectResult.unavailable("Traccar rejected the configured credentials (check username / password_command)");
  if (result.status_code !== 200) return CollectResult.unavailable(`Traccar API returned HTTP ${result.status_code}`);
  return null;
}

type Stale = [name: string, age: number];

// Buckets devices into warn and fail staleness lists (age -1 meaning never reported) and finds the oldest update age.
function survey_staleness(watched: Device[], stale_warning: number | null, stale_threshold: number | null): [Stale[], Stale[], number] {
  const stale_warn: Stale[] = [];
  const stale_fail: Stale[] = [];
  let oldest_age = 0.0;
  for (const device of watched) {
    const age = age_hours(device.lastUpdate);
    const name = String(device.name ?? "?");
    if (age === null) {
      stale_fail.push([name, -1]);
      continue;
    }
    oldest_age = Math.max(oldest_age, age);
    const level = level_for(age, stale_warning, stale_threshold);
    if (level === "failed") stale_fail.push([name, age]);
    else if (level === "warning") stale_warn.push([name, age]);
  }
  return [stale_warn, stale_fail, oldest_age];
}

// Folds the stale-device buckets into problem lines and a worst-of status.
function accumulate_staleness(stale_warn: Stale[], stale_fail: Stale[], stale_warning: number | null, stale_threshold: number | null): StatusAccumulator {
  const accumulator = new StatusAccumulator();
  if (stale_fail.length > 0) {
    const names = stale_fail.slice(0, 3).map(([name, age]) => (age < 0 ? `${name} (never reported)` : `${name} (${age.toFixed(0)}h)`)).join(", ");
    const suffix = stale_fail.length > 3 ? ` (+${stale_fail.length - 3} more)` : "";
    const limit = stale_threshold === null ? "" : ` >= ${stale_threshold.toFixed(0)}h`;
    accumulator.escalate("failed", `${stale_fail.length} stale${limit}: ${names}${suffix}`);
  }
  if (stale_warn.length > 0) {
    const names = stale_warn.slice(0, 3).map(([name, age]) => `${name} (${age.toFixed(0)}h)`).join(", ");
    const suffix = stale_warn.length > 3 ? ` (+${stale_warn.length - 3} more)` : "";
    accumulator.escalate("warning", `${stale_warn.length} stale >= ${(stale_warning ?? 0).toFixed(0)}h: ${names}${suffix}`);
  }
  return accumulator;
}

export interface DeviceItem {
  label: string;
  age_hours: number | null;
  state: string;
}

// One snapshot item per watched device, by name, with its update age in hours and its staleness state.
function device_items(watched: Device[], stale_warning: number | null, stale_threshold: number | null): DeviceItem[] {
  const items = watched.map((device): DeviceItem => {
    const age = age_hours(device.lastUpdate);
    const state = age === null ? "failed" : level_for(age, stale_warning, stale_threshold);
    return { label: String(device.name ?? "?"), age_hours: age, state };
  });
  return items.sort((first, second) => (first.label < second.label ? -1 : first.label > second.label ? 1 : 0));
}

// One device's update age in minutes under an hour and in hours past it.
export function age_text(item: Record<string, unknown>): string {
  const age = item.age_hours as number | null | undefined;
  if (age === null || age === undefined) return "never";
  if (age < 1) return `${(age * 60).toFixed(0)} min`;
  return `${age.toFixed(1)} h`;
}

// One device's meter color, which is its staleness state.
function device_color(item: Record<string, unknown>): Status | null {
  return (item.state as Status | undefined) ?? null;
}

register_color_rule("traccar_nonzero_failed", (value) => (value === null ? null : value ? "failed" : "online"));

// ── Monitor ──────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "stale_card", "devices_card"],
  ["device_bars"],
  ["chart"],
  ["events"],
];

export class Traccar extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  readonly api_url: string | null;
  readonly username: string | null;
  readonly password: string | null;
  readonly stale_warning: number | null;
  readonly stale_threshold: number | null;
  readonly devices: string[] | null;
  readonly api_timeout: number;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    // X-Monitor fetches this URL directly; it must be X-Monitor-reachable, no default.
    this.api_url = (config.api_url as string | null | undefined) ?? null;
    this.username = (config.username as string | null | undefined) ?? null;
    this.password = resolve_secret(config.password as string | null | undefined, config.password_command as string | null | undefined);
    this.stale_warning = limit_from(config, "stale_warning", 24);
    this.stale_threshold = limit_from(config, "stale_threshold", 72);
    const devices = config.devices as string[] | null | undefined;
    this.devices = devices && devices.length > 0 ? devices : null;
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
  }

  // The device bars' full scale: twice the highest set limit, or a week when both are off.
  bar_max(): number {
    const limit = this.stale_threshold !== null ? this.stale_threshold : this.stale_warning;
    return limit !== null ? 2 * limit : 168.0;
  }

  override requests(): Request[] {
    if (!this.api_url || !this.username) return [];
    const base = this.api_url.replace(/\/+$/, "");
    return [http_request(`${base}/api/devices`, { timeout: this.api_timeout, auth: [this.username, this.password ?? ""] })];
  }

  // Turns the /api/devices result into device-count and staleness metrics, one summary line, and a status where a
  // device past stale_threshold (or never reporting) is failed and one past stale_warning is warning.
  override parse_results(results: Result[]): CollectResult {
    if (!this.api_url) return CollectResult.unavailable("No 'api_url' configured");
    if (!this.username) return CollectResult.unavailable("No username configured — set username/password_command for the dedicated Traccar x-monitor account");

    const result = results[0] as HttpResult;
    const failure = http_failure(result);
    if (failure !== null) return failure;

    let devices: Device[];
    try {
      devices = parse_response(result.text);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const watched = devices.filter((device) => !device.disabled && (this.devices === null || this.devices.includes(device.name as string)));
    if (watched.length === 0) return new CollectResult({ logs: [["No matching enabled devices reported by Traccar", "WARNING"]], status: "warning" });

    const [stale_warn, stale_fail, oldest_age] = survey_staleness(watched, this.stale_warning, this.stale_threshold);
    const metrics = {
      devices_total: watched.length,
      oldest_update_hours: oldest_age,
      devices_stale: stale_warn.length + stale_fail.length,
    };
    const accumulator = accumulate_staleness(stale_warn, stale_fail, this.stale_warning, this.stale_threshold);

    const parts = [`${watched.length} device(s)`, `oldest update ${oldest_age.toFixed(0)}h ago`];
    if (accumulator.problems.length > 0) parts.push("| " + accumulator.problems.join("; "));

    return new CollectResult({
      metrics,
      logs: [[parts.join(" | "), accumulator.log_level]],
      status: accumulator.status,
      snapshot: device_items(watched, this.stale_warning, this.stale_threshold),
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        stale_card: { metric: "devices_stale", title: "STALE DEVICES", format: "int", color: "traccar_nonzero_failed" },
        devices_card: { metric: "devices_total", title: "DEVICES", format: "int" },
        device_bars: {
          title: "LAST UPDATE BY DEVICE",
          repeat: {
            source: "snapshot",
            container: "bars",
            bar_value: "age_hours",
            bar_max: this.bar_max(),
            bar_marker: 50.0,
            item_format_fn: age_text,
            item_color_by: device_color,
            empty_text: "No devices reported yet",
          },
        },
      },
      chart: { metric: "oldest_update_hours", title: "OLDEST UPDATE (HOURS)" },
      events: true,
    };
  }
}
