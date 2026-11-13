// Syncthing sync health via its REST API over HTTP from the X-Monitor host: system config and connections each cycle,
// plus per-folder /rest/db/status for the folder IDs learned the cycle before. Config: api_url (required,
// X-Monitor-reachable), api_key / api_key_command, folders, devices, stall_warning (minutes, null to turn it off),
// pull_errors_warning (default 1, null to turn it off), api_timeout. An errored or invalid folder, including one sitting
// idle while still needing data, is failed; pull errors at or above pull_errors_warning, folders syncing or scanning
// past stall_warning, and expected devices disconnected are warning; a folder still syncing toward up to date is info;
// an API that did not answer, or answered with an error or something unparseable, is unavailable. The local device,
// which the config lists but the connections map never does, is not an expected device.

import { python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { CollectResult, http_request, type HttpRequest, type HttpResult, type Request, type Result } from "../core/connectors/types.ts";
import type { Status } from "../shared/status.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { limit_from, resolve_secret, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";

const default_layout: LayoutRow[] = [
  ["host_card", "folders_card", "devices_card"],
  ["errors_card", "need_card", "stalled_card"],
  ["folder_tiles"],
  ["chart"],
  ["events"],
];

type Json = Record<string, unknown>;

function monotonic(): number {
  return performance.now() / 1000;
}

// Python's int() of a JSON number, truncating toward zero.
function as_int(value: unknown): number {
  return Math.trunc(Number(value || 0));
}

// ── Decoding ─────────────────────────────────────────────────────────────────

// Decodes /rest/system/config, throwing the user-facing message.
function decode_config(config_result: HttpResult): Json {
  if (config_result.error !== null) throw new Error(`Failed to query Syncthing config: ${config_result.error}`);
  if (config_result.status_code !== 200) throw new Error(`Syncthing config returned HTTP ${config_result.status_code} (check the API key)`);
  try {
    return JSON.parse(config_result.text) as Json;
  } catch (error) {
    throw new Error(`Config response was not JSON (${(error as Error).message})`);
  }
}

// Decodes each /rest/db/status reply in watch order, throwing the user-facing message.
function decode_folder_states(watched_ids: string[], folder_results: HttpResult[]): Map<string, Json> {
  const folder_states = new Map<string, Json>();
  const count = Math.min(watched_ids.length, folder_results.length);
  for (let index = 0; index < count; index++) {
    const folder_id = watched_ids[index];
    const result = folder_results[index];
    if (result.error !== null || result.status_code !== 200) {
      const detail = result.error || `HTTP ${result.status_code}`;
      throw new Error(`Failed to query folder ${python_repr(folder_id)}: ${detail}`);
    }
    try {
      folder_states.set(folder_id, JSON.parse(result.text) as Json);
    } catch (error) {
      throw new Error(`Folder ${python_repr(folder_id)} status was not JSON (${(error as Error).message})`);
    }
  }
  return folder_states;
}

// Decodes /rest/system/connections, throwing the user-facing message.
function decode_connections(connections_result: HttpResult): Record<string, Json> {
  if (connections_result.error !== null || connections_result.status_code !== 200) {
    const detail = connections_result.error || `HTTP ${connections_result.status_code}`;
    throw new Error(`Failed to query connections: ${detail}`);
  }
  let decoded: Json;
  try {
    decoded = JSON.parse(connections_result.text) as Json;
  } catch (error) {
    throw new Error(`Connections response was not JSON (${(error as Error).message})`);
  }
  return (decoded.connections ?? {}) as Record<string, Json>;
}

// ── Classifying ──────────────────────────────────────────────────────────────

// The folder IDs Syncthing reports, narrowed to the watch list when one is set.
function watched_folder_ids(config: Json, folders_filter: string[] | null): string[] {
  const all_folder_ids = ((config.folders ?? []) as Json[]).map((folder) => String(folder.id));
  return all_folder_ids.filter((folder_id) => folders_filter === null || folders_filter.includes(folder_id));
}

// Device IDs expected to be connected: all remote ones, or those matching the watch list by name or ID; the local
// device never has a connection entry, so only devices in /rest/system/connections count.
function expected_device_ids(device_names: Map<string, string>, devices_filter: string[] | null, connections: Record<string, Json>): string[] {
  return [...device_names.keys()].filter((device_id) =>
    Object.hasOwn(connections, device_id) &&
    (devices_filter === null || devices_filter.includes(device_names.get(device_id)!) || devices_filter.includes(device_id)));
}

// Names of expected devices without a live connection.
function disconnected_names(device_names: Map<string, string>, expected_devices: string[], connections: Record<string, Json>): string[] {
  return expected_devices
    .filter((device_id) => !(connections[device_id]?.connected ?? false))
    .map((device_id) => device_names.get(device_id) ?? device_id);
}

function sync_metrics(watched_count: number, errored: string[], stalled: string[], need_bytes: number, pull_errors: number, expected_count: number, disconnected_count: number): Record<string, number> {
  return {
    folders_total: watched_count,
    folders_errored: errored.length,
    folders_stalled: stalled.length,
    need_bytes,
    pull_errors,
    devices_expected: expected_count,
    devices_disconnected: disconnected_count,
  };
}

interface Classified {
  errored_folders: string[];
  stalled_folders: string[];
  total_need_bytes: number;
  total_pull_errors: number;
  stall_since: Map<string, number>;
}

// Sorts folders into errored and stalled and totals their need bytes and pull errors, with a rebuilt stall-start map.
function classify_folders(folder_states: Map<string, Json>, stall_since: Map<string, number>, now: number, stall_warning_secs: number | null): Classified {
  const new_stall_since = new Map(stall_since);
  const errored_folders: string[] = [];
  const stalled_folders: string[] = [];
  let total_need_bytes = 0.0;
  let total_pull_errors = 0;

  for (const [folder_id, status] of folder_states) {
    const state = status.state ?? "unknown";
    const need_bytes = Number(status.needBytes || 0);
    const need_files = as_int(status.needFiles);
    const pull_errors = as_int(status.pullErrors);
    const invalid = status.invalid ?? "";

    total_need_bytes += need_bytes;
    total_pull_errors += pull_errors;

    if (state === "error" || invalid) {
      errored_folders.push(folder_id);
      new_stall_since.delete(folder_id);
      continue;
    }
    if (state === "idle" && (need_files > 0 || need_bytes > 0)) {
      errored_folders.push(folder_id);
      continue;
    }
    if (state === "syncing" || state === "scanning") {
      if (!new_stall_since.has(folder_id)) new_stall_since.set(folder_id, now);
      const started = new_stall_since.get(folder_id)!;
      if (stall_warning_secs !== null && now - started >= stall_warning_secs) stalled_folders.push(folder_id);
    } else {
      new_stall_since.delete(folder_id);
    }
  }
  return { errored_folders, stalled_folders, total_need_bytes, total_pull_errors, stall_since: new_stall_since };
}

// How much of a folder's global data is already local, as a whole percentage.
function sync_percent(status: Json): number {
  const global_bytes = Number(status.globalBytes || 0);
  const need_bytes = Number(status.needBytes || 0);
  if (global_bytes <= 0) return need_bytes > 0 ? 0 : 100;
  const in_sync = status.inSyncBytes;
  const in_sync_bytes = in_sync !== null && in_sync !== undefined ? Number(in_sync) : global_bytes - need_bytes;
  return Math.max(0, Math.min(100, Math.trunc((in_sync_bytes / global_bytes) * 100)));
}

// Whether a folder is pulling data it still needs (syncing, sync-preparing or sync-waiting).
function is_syncing(status: Json): boolean {
  return String(status.state ?? "").startsWith("sync");
}

interface FolderTile {
  state: string;
  caption: string;
  status: string;
}

// One folder's tile state (idle, syncing, error, paused or stalled), its caption and its status color.
function folder_tile(status: Json, errored: boolean, stalled: boolean, paused: boolean): FolderTile {
  const errors = Math.max(as_int(status.pullErrors), as_int(status.errors));
  const state = String(status.state ?? "unknown");
  if (errored) {
    let caption: string;
    if (status.invalid) caption = String(status.invalid);
    else if (state === "error") caption = String(status.error || "error");
    else caption = "out of sync";
    return { state: "error", caption, status: "failed" };
  }
  if (paused || state === "paused") return { state: "paused", caption: "paused", status: "unavailable" };
  if (stalled) return { state: "stalled", caption: `stalled ${sync_percent(status)}%`, status: "warning" };
  if (errors) {
    const caption = errors === 1 ? `${errors} error` : `${errors} errors`;
    return { state: state === "idle" ? "idle" : "syncing", caption, status: "warning" };
  }
  if (state === "syncing") return { state: "syncing", caption: `syncing ${sync_percent(status)}%`, status: "info" };
  if (state === "idle") return { state: "idle", caption: "up to date", status: "online" };
  // Scanning and Syncthing's other passing states read as syncing under their own name.
  return { state: "syncing", caption: state.replaceAll("-", " "), status: is_syncing(status) ? "info" : "online" };
}

// One snapshot item per watched folder, in config order, labelled by its folder label or id.
function folder_items(config: Json, folder_states: Map<string, Json>, errored_folders: string[], stalled_folders: string[]): (FolderTile & { id: string; label: string })[] {
  const folder_configs = new Map(((config.folders ?? []) as Json[]).map((folder) => [String(folder.id), folder]));
  return [...folder_states].map(([folder_id, status]) => {
    const folder_config = folder_configs.get(folder_id) ?? {};
    const tile = folder_tile(status, errored_folders.includes(folder_id), stalled_folders.includes(folder_id), Boolean(folder_config.paused));
    return { id: folder_id, label: String(folder_config.label || folder_id), ...tile };
  });
}

// Folds errored, stalled and syncing folders, pull errors and disconnected devices into one worst-of status.
function accumulate_problems(errored_folders: string[], stalled_folders: string[], syncing_folders: string[], disconnected: string[], total_pull_errors: number, stall_warning_secs: number | null, pull_errors_warning: number | null = 1): StatusAccumulator {
  const accumulator = new StatusAccumulator();
  if (syncing_folders.length > 0) accumulator.escalate("info", `${syncing_folders.length} folder(s) syncing: ${syncing_folders.slice(0, 3).join(", ")}`);
  if (errored_folders.length > 0) accumulator.escalate("failed", `${errored_folders.length} folder(s) errored: ${errored_folders.slice(0, 3).join(", ")}`);
  if (pull_errors_warning !== null && total_pull_errors >= pull_errors_warning) accumulator.escalate("warning", `${total_pull_errors} pull error(s)`);
  if (stalled_folders.length > 0) {
    const limit = stall_warning_secs === null ? "" : ` >= ${(stall_warning_secs / 60).toFixed(0)}m`;
    accumulator.escalate("warning", `${stalled_folders.length} folder(s) stalled${limit}: ${stalled_folders.slice(0, 3).join(", ")}`);
  }
  if (disconnected.length > 0) accumulator.escalate("warning", `${disconnected.length} device(s) disconnected: ${disconnected.slice(0, 3).join(", ")}`);
  return accumulator;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Syncthing extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  readonly api_url: string | null;
  readonly api_key: string | null;
  readonly folders: string[] | null;
  readonly devices: string[] | null;
  readonly stall_warning_secs: number | null;
  // Below this many pull errors a folder is still online; Syncthing retries them on its own.
  readonly pull_errors_warning: number | null;
  readonly api_timeout: number;
  stall_since = new Map<string, number>();
  cached_folder_ids: string[] = [];

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    // X-Monitor fetches this URL directly; it must be X-Monitor-reachable, no default.
    this.api_url = (config.api_url as string | null | undefined) ?? null;
    const key_command = "api_key_command" in config ? (config.api_key_command as string | null) : "cat /Storage/Services/Syncthing/Config/x-monitor-api-key";
    this.api_key = resolve_secret(config.api_key as string | null | undefined, key_command);
    const folders = config.folders as string[] | null | undefined;
    this.folders = folders && folders.length > 0 ? folders : null;
    const devices = config.devices as string[] | null | undefined;
    this.devices = devices && devices.length > 0 ? devices : null;
    const stall_warning = limit_from(config, "stall_warning", 60);
    this.stall_warning_secs = stall_warning === null ? null : stall_warning * 60;
    this.pull_errors_warning = limit_from(config, "pull_errors_warning", 1);
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
  }

  private get_request(path: string): HttpRequest {
    const base = (this.api_url ?? "").replace(/\/+$/, "");
    return http_request(`${base}${path}`, { timeout: this.api_timeout, headers: { "X-API-Key": this.api_key ?? "" } });
  }

  override requests(): Request[] {
    if (!this.api_url) return [];
    return [
      this.get_request("/rest/system/config"),
      this.get_request("/rest/system/connections"),
      ...this.cached_folder_ids.map((folder_id) => this.get_request(`/rest/db/status?folder=${folder_id}`)),
    ];
  }

  // Turns the [config, connections, ...per-folder status] results into folder, device and need-bytes metrics, one
  // summary line, and a worst-of status.
  override parse_results(results: Result[]): CollectResult {
    if (results.length === 0) return CollectResult.unavailable("No 'api_url' configured");

    const [config_result, connections_result] = results as HttpResult[];
    const folder_results = results.slice(2) as HttpResult[];

    let config: Json;
    try {
      config = decode_config(config_result);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const watched_ids = watched_folder_ids(config, this.folders);
    this.cached_folder_ids = watched_ids;

    if (watched_ids.length === 0) return new CollectResult({ logs: [["No matching folders configured in Syncthing", "WARNING"]], status: "warning" });

    // The first cycle after startup, or after the folder list changed, only learns the folder IDs.
    if (folder_results.length === 0) {
      return new CollectResult({ logs: [[`Discovered ${watched_ids.length} folder(s), fetching status next cycle`, "INFO"]], status: "info" });
    }

    let folder_states: Map<string, Json>;
    let connections: Record<string, Json>;
    try {
      folder_states = decode_folder_states(watched_ids, folder_results);
      connections = decode_connections(connections_result);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const device_names = new Map(((config.devices ?? []) as Json[]).map((device) => [String(device.deviceID), String(device.name ?? device.deviceID)]));
    const expected_devices = expected_device_ids(device_names, this.devices, connections);
    const disconnected = disconnected_names(device_names, expected_devices, connections);

    const classified = classify_folders(folder_states, this.stall_since, monotonic(), this.stall_warning_secs);
    this.stall_since = classified.stall_since;
    const { errored_folders, stalled_folders, total_need_bytes, total_pull_errors } = classified;

    const metrics = sync_metrics(watched_ids.length, errored_folders, stalled_folders, total_need_bytes, total_pull_errors, expected_devices.length, disconnected.length);

    const syncing_folders = [...folder_states].filter(([folder_id, status]) => is_syncing(status) && !stalled_folders.includes(folder_id)).map(([folder_id]) => folder_id);
    const accumulator = accumulate_problems(errored_folders, stalled_folders, syncing_folders, disconnected, total_pull_errors, this.stall_warning_secs, this.pull_errors_warning);

    const parts = [`${watched_ids.length} folder(s)`, `${expected_devices.length - disconnected.length}/${expected_devices.length} devices connected`];
    if (accumulator.problems.length > 0) parts.push("| " + accumulator.problems.join("; "));

    return new CollectResult({
      metrics,
      logs: [[parts.join(" | "), accumulator.log_level]],
      status: accumulator.status,
      snapshot: folder_items(config, folder_states, errored_folders, stalled_folders),
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  static folder_caption(item: Record<string, unknown>): string {
    return String(item.caption ?? "--");
  }

  static folder_status(item: Record<string, unknown>): Status | null {
    return (item.status as Status | undefined) ?? null;
  }

  static need_text(values: Record<string, unknown>): string {
    const value = values.need_bytes as number | null | undefined;
    if (value === null || value === undefined) return "--";
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }

  static devices_text(values: Record<string, unknown>): string {
    const expected = values.devices_expected as number | null | undefined;
    const disconnected = values.devices_disconnected as number | null | undefined;
    if (expected === null || expected === undefined || disconnected === null || disconnected === undefined) return "--";
    return `${Math.trunc(expected) - Math.trunc(disconnected)}/${Math.trunc(expected)}`;
  }

  static devices_color(values: Record<string, unknown>): Status | null {
    const disconnected = values.devices_disconnected as number | null | undefined;
    if (disconnected === null || disconnected === undefined) return null;
    return disconnected === 0 ? "online" : "warning";
  }

  static errored_color(errored: number | null): Status | null {
    return errored === null ? null : errored ? "failed" : "online";
  }

  static stalled_color(stalled: number | null): Status | null {
    return stalled === null ? null : stalled ? "warning" : "online";
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        folders_card: { metric: "folders_total", title: "FOLDERS", format: "int" },
        devices_card: { title: "DEVICES", metrics: ["devices_expected", "devices_disconnected"], format_fn: Syncthing.devices_text, color_fn: Syncthing.devices_color },
        errors_card: { metric: "folders_errored", title: "ERRORED", format: "int", color: Syncthing.errored_color },
        need_card: { title: "NEED", metrics: ["need_bytes"], format_fn: Syncthing.need_text },
        stalled_card: { metric: "folders_stalled", title: "STALLED", format: "int", color: Syncthing.stalled_color },
        folder_tiles: {
          title: "FOLDERS BY STATE",
          repeat: {
            source: "snapshot",
            container: "tiles",
            item_format_fn: Syncthing.folder_caption,
            item_color_by: Syncthing.folder_status,
            empty_text: "No folder status yet",
          },
        },
      },
      chart: { metric: "need_bytes", title: "BYTES NEEDED" },
      events: true,
    };
  }
}
