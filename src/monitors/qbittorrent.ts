// qBittorrent transfer health via its WebUI API, fetched by one curl script over SSH (sampled locally by the agent on
// agent-backed hosts) that logs in, reads transfer info plus the torrent list, and logs the session out on exit.
// Config: api_url, username, password / password_command, stalled_warning, stalled_threshold, error_threshold (each
// null to turn it off), firewalled_warning, min_downloading, api_timeout. A DISCONNECTED connection status, errored
// torrents at error_threshold, or stalls at stalled_threshold are failed; a firewalled connection or stalls at
// stalled_warning are warning (stall counts only apply while at least min_downloading torrents are downloading). An API
// that did not answer, rejected the credentials, or replied unparseably is unavailable.

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import type { Status } from "../shared/status.ts";
import type { ActionButtonSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { dq, level_for, limit_from, password_line, SCRIPT_SEP, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";
import { py_str_repr } from "./base/python_text.ts";

export { SCRIPT_SEP };

export const AUTH_FAILED = "XMONITOR_AUTH_FAILED";

type Torrent = Record<string, unknown>;

// ── States ───────────────────────────────────────────────────────────────────

// Each qBittorrent torrent state belongs to exactly one bucket; an unlisted state counts as stalled.
const state_buckets: Record<string, string> = {
  downloading: "downloading", forcedDL: "downloading", queuedDL: "downloading",
  checkingDL: "downloading", allocating: "downloading", forcedMetaDL: "downloading",
  uploading: "seeding", forcedUP: "seeding", queuedUP: "seeding", checkingUP: "seeding",
  pausedDL: "paused", pausedUP: "paused", stoppedDL: "paused", stoppedUP: "paused",
  stalledDL: "stalled", stalledUP: "stalled", metaDL: "stalled",
  error: "errored", missingFiles: "errored",
};

const bucket_names = ["downloading", "seeding", "paused", "stalled", "errored"] as const;

const stalled_states = new Set(Object.keys(state_buckets).filter((state) => state_buckets[state] === "stalled"));

const error_states = new Set(Object.keys(state_buckets).filter((state) => state_buckets[state] === "errored"));

const active_download_states = new Set(["downloading", "metaDL", "stalledDL", "queuedDL", "forcedDL", "checkingDL", "allocating", "downloadingMetadata"]);

// ── Scripts ──────────────────────────────────────────────────────────────────

function auth_preamble(base: string, timeout: number, password_command: string | null, username: string | null, password: string | null): [lines: string[], auth: string] {
  if (!(username && (password_command || password))) return [[], ""];
  const lines = [password_line(password_command, password)];
  lines.push("__jar=$(mktemp)");
  // Logs the WebUI session out on any exit, then drops the cookie jar, so a poll never leaves a live session behind.
  lines.push(`trap 'curl -s -m ${Math.trunc(timeout)} -b "$__jar" -H ${dq("Referer: " + base)} --data "" ${dq(base + "/api/v2/auth/logout")} >/dev/null 2>&1; rm -f "$__jar"' EXIT INT TERM`);
  lines.push(
    `__login=$(curl -s -m ${timeout} -c "$__jar" ` +
    `-H ${shell_quote("Referer: " + base)} ` +
    `--data-urlencode ${shell_quote("username=" + username)} ` +
    `--data-urlencode "password=$__pw" ` +
    `${shell_quote(base + "/api/v2/auth/login")})`,
  );
  lines.push(`case "$__login" in *Ok.*) ;; *) echo "${AUTH_FAILED}: $__login" >&2; exit 1 ;; esac`);
  return [lines, '-b "$__jar"'];
}

export function build_fetch_script(api_url: string, timeout: number, password_command: string | null, username: string | null, password: string | null): string {
  const base = api_url.replace(/\/+$/, "");
  const lines = ["set -e"];
  const [auth_lines, auth] = auth_preamble(base, timeout, password_command, username, password);
  lines.push(...auth_lines);
  lines.push(`curl -s -m ${timeout} ${auth} ${shell_quote(base + "/api/v2/transfer/info")}`);
  lines.push(`echo "${SCRIPT_SEP}"`);
  lines.push(`curl -s -m ${timeout} ${auth} ${shell_quote(base + "/api/v2/torrents/info")}`);
  return lines.join("\n");
}

function action_curl_line(base: string, timeout: number, auth: string, endpoint: string, params: Record<string, string> | null = null): string {
  const parts = [`curl -s -f -m ${timeout} ${auth}`, `-H ${shell_quote("Referer: " + base)}`];
  for (const [key, value] of Object.entries(params ?? {})) parts.push(`--data-urlencode ${shell_quote(`${key}=${value}`)}`);
  parts.push(shell_quote(base + endpoint));
  return parts.join(" ");
}

export function build_action_script(api_url: string, timeout: number, password_command: string | null, username: string | null, password: string | null, endpoint: string, params: Record<string, string> | null = null): string {
  const base = api_url.replace(/\/+$/, "");
  const lines = ["set -e"];
  const [auth_lines, auth] = auth_preamble(base, timeout, password_command, username, password);
  lines.push(...auth_lines);
  lines.push(action_curl_line(base, timeout, auth, endpoint, params));
  return lines.join("\n");
}

// Tries the modern endpoint, then the legacy one older qBittorrent versions use (start/stop rather than resume/pause).
function build_fallback_action_script(api_url: string, timeout: number, password_command: string | null, username: string | null, password: string | null, modern_endpoint: string, legacy_endpoint: string, params: Record<string, string> | null = null): string {
  const base = api_url.replace(/\/+$/, "");
  const lines = ["set -e"];
  const [auth_lines, auth] = auth_preamble(base, timeout, password_command, username, password);
  lines.push(...auth_lines);
  lines.push(`${action_curl_line(base, timeout, auth, modern_endpoint, params)} || ${action_curl_line(base, timeout, auth, legacy_endpoint, params)}`);
  return lines.join("\n");
}

// Fetches the torrent list, extracts the errored torrents' hashes, and rechecks them, all in one remote round trip.
function build_recheck_script(api_url: string, timeout: number, password_command: string | null, username: string | null, password: string | null): string {
  const base = api_url.replace(/\/+$/, "");
  const lines = ["set -e"];
  const [auth_lines, auth] = auth_preamble(base, timeout, password_command, username, password);
  lines.push(...auth_lines);
  const states = [...error_states].sort().map(shell_quote).join(" ");
  lines.push(`__torrents=$(curl -s -m ${timeout} ${auth} ${shell_quote(base + "/api/v2/torrents/info")})`);
  lines.push(
    "__hashes=$(printf '%s' \"$__torrents\" | python3 -c " +
    "\"import json,sys; states=set(sys.argv[1:]); " +
    "data=json.load(sys.stdin); " +
    "print('|'.join(t['hash'] for t in data if t.get('state') in states and t.get('hash')))\" " +
    `${states})`,
  );
  lines.push('echo "HASHES:$__hashes"');
  lines.push('if [ -n "$__hashes" ]; then');
  lines.push(`  curl -s -f -m ${timeout} ${auth} -H ${shell_quote("Referer: " + base)} --data-urlencode "hashes=$__hashes" ${shell_quote(base + "/api/v2/torrents/recheck")}`);
  lines.push("fi");
  return lines.join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parse_response(stdout: string): [transfer: Record<string, unknown>, torrents: Torrent[]] {
  const at = stdout.indexOf(SCRIPT_SEP);
  if (at === -1) throw new Error(`unexpected API response: ${py_str_repr(stdout.slice(0, 200))}`);
  const transfer_raw = stdout.slice(0, at).trim();
  const torrents_raw = stdout.slice(at + SCRIPT_SEP.length).trim();

  if (transfer_raw.startsWith("Forbidden")) throw new Error("API returned Forbidden (set username/password if auth is required)");

  let transfer: unknown;
  let torrents: unknown;
  try {
    transfer = JSON.parse(transfer_raw);
  } catch (error) {
    throw new Error(`transfer info was not JSON (${(error as Error).message}): ${py_str_repr(transfer_raw.slice(0, 200))}`);
  }
  try {
    torrents = JSON.parse(torrents_raw);
  } catch (error) {
    throw new Error(`torrent list was not JSON (${(error as Error).message}): ${py_str_repr(torrents_raw.slice(0, 200))}`);
  }
  if (typeof transfer !== "object" || transfer === null || Array.isArray(transfer) || !("connection_status" in transfer)) {
    throw new Error(`transfer info missing 'connection_status': ${py_str_repr(transfer_raw.slice(0, 200))}`);
  }
  if (!Array.isArray(torrents)) throw new Error(`torrent list was not a list: ${py_str_repr(torrents_raw.slice(0, 200))}`);
  return [transfer as Record<string, unknown>, torrents as Torrent[]];
}

// Splits the torrent list into stalled, errored, and actively-downloading subsets.
function classify_torrents(torrents: Torrent[]): [Torrent[], Torrent[], Torrent[]] {
  const state = (torrent: Torrent) => torrent.state as string;
  return [
    torrents.filter((torrent) => stalled_states.has(state(torrent))),
    torrents.filter((torrent) => error_states.has(state(torrent))),
    torrents.filter((torrent) => active_download_states.has(state(torrent))),
  ];
}

// Counts the torrents in each state bucket, every torrent landing in exactly one.
function count_state_buckets(torrents: Torrent[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(bucket_names.map((name) => [name, 0]));
  for (const torrent of torrents) {
    const state = torrent.state as string;
    counts[Object.hasOwn(state_buckets, state) ? state_buckets[state] : "stalled"] += 1;
  }
  return counts;
}

// Judges the connection state and the stalled and errored torrent counts against the thresholds.
function accumulate_transfer_problems(connection: string, stalled: Torrent[], errored: Torrent[], downloading: Torrent[], firewalled_warning: boolean, error_threshold: number | null, stalled_warning: number | null, stalled_threshold: number | null, min_downloading: number): StatusAccumulator {
  const accumulator = new StatusAccumulator();
  if (connection === "disconnected") accumulator.escalate("failed", "connection status is DISCONNECTED");
  else if (connection === "firewalled" && firewalled_warning) accumulator.escalate("warning", "connection is firewalled (no inbound peers)");

  if (errored.length > 0 && error_threshold !== null && errored.length >= error_threshold) {
    const names = errored.slice(0, 3).map((torrent) => String(torrent.name ?? "?")).join(", ");
    const suffix = errored.length > 3 ? ` (+${errored.length - 3} more)` : "";
    accumulator.escalate("failed", `${errored.length} errored: ${names}${suffix}`);
  }

  if (downloading.length >= min_downloading) {
    const level = level_for(stalled.length, stalled_warning, stalled_threshold);
    if (level === "failed") accumulator.escalate("failed", `${stalled.length} stalled (>= ${stalled_threshold})`);
    else if (level === "warning") accumulator.escalate("warning", `${stalled.length} stalled (>= ${stalled_warning})`);
  }
  return accumulator;
}

export function format_rate(bytes_per_sec: number): string {
  let value = Number(bytes_per_sec);
  for (const unit of ["B/s", "KiB/s", "MiB/s", "GiB/s"]) {
    if (value < 1024 || unit === "GiB/s") return unit !== "B/s" ? `${value.toFixed(1)} ${unit}` : `${Math.trunc(value)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} GiB/s`;
}

// A torrent-count limit as a whole number, or null when it is set to null.
function count_limit(config: PluginConfig, key: string, fallback: number): number | null {
  const value = limit_from(config, key, fallback);
  return value === null ? null : Math.trunc(value);
}

const default_layout: LayoutRow[] = [
  ["host_card", "connection_card", "speed_card"],
  ["torrents_card", "stalled_card", "errored_card"],
  ["share_card"],
  ["chart"],
  ["events"],
];

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Qbittorrent extends Plugin {
  override readonly SAMPLED = true;
  readonly api_url: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly password_command: string | null;
  readonly stalled_warning: number | null;
  readonly stalled_threshold: number | null;
  readonly error_threshold: number | null;
  readonly firewalled_warning: boolean;
  readonly min_downloading: number;
  readonly api_timeout: number;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.api_url = "api_url" in config ? (config.api_url as string) : "http://127.0.0.1:8080";
    this.username = (config.username as string | null | undefined) ?? null;
    this.password = (config.password as string | null | undefined) ?? null;
    this.password_command = (config.password_command as string | null | undefined) ?? null;
    this.stalled_warning = count_limit(config, "stalled_warning", 3);
    this.stalled_threshold = count_limit(config, "stalled_threshold", 10);
    this.error_threshold = count_limit(config, "error_threshold", 1);
    this.firewalled_warning = Boolean(config.firewalled_warning ?? true);
    this.min_downloading = Math.trunc(Number(config.min_downloading ?? 1));
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
  }

  override commands(): Command[] {
    return [command(build_fetch_script(this.api_url, this.api_timeout, this.password_command, this.username, this.password))];
  }

  // Turns the transfer info and torrent list into speed and count metrics, one summary line, and a status where a
  // DISCONNECTED link, errored torrents, or heavy stalling is failed and a firewalled link or moderate stalling is
  // warning; an API that did not answer, rejected the login, or replied unparseably is unavailable.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) {
      if (stderr.includes(AUTH_FAILED)) return CollectResult.unavailable("qBittorrent rejected the configured credentials (check username / password_command)", "ERROR");
      return CollectResult.unavailable(`Failed to query qBittorrent API: ${stderr.trim()}`);
    }

    let transfer: Record<string, unknown>;
    let torrents: Torrent[];
    try {
      [transfer, torrents] = parse_response(stdout);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const connection = String(transfer.connection_status ?? "unknown");
    const dl_speed = Number(transfer.dl_info_speed || 0);
    const up_speed = Number(transfer.up_info_speed || 0);
    const [stalled, errored, downloading] = classify_torrents(torrents);

    const metrics: Record<string, number> = {
      dl_speed_bytes: dl_speed,
      up_speed_bytes: up_speed,
      torrents_total: torrents.length,
      torrents_stalled: stalled.length,
      torrents_errored: errored.length,
      torrents_downloading: downloading.length,
      dl_session_bytes: Number(transfer.dl_info_data || 0),
      up_session_bytes: Number(transfer.up_info_data || 0),
      connected: connection === "connected" ? 1.0 : 0.0,
    };
    for (const [bucket, count] of Object.entries(count_state_buckets(torrents))) metrics[`torrents_state_${bucket}`] = count;

    const accumulator = accumulate_transfer_problems(connection, stalled, errored, downloading, this.firewalled_warning, this.error_threshold, this.stalled_warning, this.stalled_threshold, this.min_downloading);

    const parts = [connection, `↓ ${format_rate(dl_speed)}`, `↑ ${format_rate(up_speed)}`, `${torrents.length} torrents`, `${downloading.length} downloading`];
    if (accumulator.problems.length > 0) parts.push("| " + accumulator.problems.join("; "));

    return new CollectResult({ metrics, logs: [[parts.join(" | "), accumulator.log_level]], status: accumulator.status });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    return [
      { name: "Resume All", action_id: "resume_all", variant: "primary", icon: "play_arrow" },
      { name: "Recheck Errored", action_id: "recheck_errored", variant: "secondary", icon: "fact_check" },
      { name: "Pause All", action_id: "pause_all", variant: "danger", icon: "pause" },
    ];
  }

  override plan_action(action_id: string): ActionPlanResult {
    if (action_id === "resume_all") {
      return action_plan(build_fallback_action_script(this.api_url, this.api_timeout, this.password_command, this.username, this.password, "/api/v2/torrents/start", "/api/v2/torrents/resume", { hashes: "all" }));
    }
    if (action_id === "pause_all") {
      return action_plan(build_fallback_action_script(this.api_url, this.api_timeout, this.password_command, this.username, this.password, "/api/v2/torrents/stop", "/api/v2/torrents/pause", { hashes: "all" }));
    }
    if (action_id === "recheck_errored") {
      return action_plan(build_recheck_script(this.api_url, this.api_timeout, this.password_command, this.username, this.password));
    }
    return null;
  }

  override interpret_action(action_id: string, result: unknown): ActionOutcome {
    const outcome = result as CmdResult;
    const stderr = outcome.stderr || "";
    if (action_id === "resume_all") {
      if (outcome.exit_code !== 0) {
        if (stderr.includes(AUTH_FAILED)) return CollectResult.failed("resume_all rejected: qBittorrent refused the configured credentials");
        return CollectResult.failed(`resume_all failed: ${stderr.trim()}`);
      }
      return new CollectResult({ logs: [["Resumed all torrents", "INFO"]], success: true });
    }
    if (action_id === "pause_all") {
      if (outcome.exit_code !== 0) {
        if (stderr.includes(AUTH_FAILED)) return CollectResult.failed("pause_all rejected: qBittorrent refused the configured credentials");
        return CollectResult.failed(`pause_all failed: ${stderr.trim()}`);
      }
      return new CollectResult({ logs: [["Paused all torrents", "WARNING"]], success: true });
    }
    if (action_id === "recheck_errored") {
      if (outcome.exit_code !== 0) {
        if (stderr.includes(AUTH_FAILED)) return CollectResult.failed("recheck_errored rejected: qBittorrent refused the configured credentials");
        return CollectResult.failed(`Could not list/recheck torrents: ${stderr.trim()}`);
      }
      const hashes_line = outcome.stdout.split(/\r?\n/).find((line) => line.startsWith("HASHES:")) ?? "HASHES:";
      const hashes = hashes_line.slice("HASHES:".length).split("|").filter((hash) => hash);
      if (hashes.length === 0) return new CollectResult({ logs: [["No errored torrents to recheck", "INFO"]], success: true });
      return new CollectResult({ logs: [[`Rechecking ${hashes.length} errored torrent(s)`, "INFO"]], success: true });
    }
    return outcome.exit_code === 0;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  static connection_format(value: number | null): string {
    return value === null ? "--" : value >= 1.0 ? "CONNECTED" : "DISCONNECTED";
  }

  static connection_color(value: number | null): Status | null {
    return value === null ? null : value >= 1.0 ? "online" : "failed";
  }

  static errored_color(value: number | null): Status | null {
    return value === null ? null : Math.trunc(value) ? "failed" : "online";
  }

  static speed_text(values: Record<string, unknown>): string {
    const download = values.dl_speed_bytes as number | null | undefined;
    const upload = values.up_speed_bytes as number | null | undefined;
    if (download === null || download === undefined || upload === null || upload === undefined) return "--";
    return `↓ ${format_rate(download)}  ↑ ${format_rate(upload)}`;
  }

  static torrents_text(values: Record<string, unknown>): string {
    const total = values.torrents_total as number | null | undefined;
    if (total === null || total === undefined) return "--";
    let text = `${Math.trunc(total)}`;
    const downloading = values.torrents_downloading as number | null | undefined;
    if (downloading !== null && downloading !== undefined) text += ` (${Math.trunc(downloading)} active)`;
    return text;
  }

  stalled_color(value: number | null): Status | null {
    if (value === null) return null;
    return level_for(Math.trunc(value), this.stalled_warning, this.stalled_threshold);
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        connection_card: { metric: "connected", title: "CONNECTION", format: Qbittorrent.connection_format, color: Qbittorrent.connection_color },
        speed_card: { title: "TRANSFER", metrics: ["dl_speed_bytes", "up_speed_bytes"], format_fn: Qbittorrent.speed_text },
        torrents_card: { title: "TORRENTS", metrics: ["torrents_total", "torrents_downloading"], format_fn: Qbittorrent.torrents_text },
        stalled_card: { metric: "torrents_stalled", title: "STALLED", format: "int", color: (value) => this.stalled_color(value) },
        errored_card: { metric: "torrents_errored", title: "ERRORED", format: "int", color: Qbittorrent.errored_color },
        share_card: {
          kind: "share",
          title: "BY STATE",
          format: "int",
          parts: [
            { metric: "torrents_state_downloading", label: "Downloading", color: "accent" },
            { metric: "torrents_state_seeding", label: "Seeding", color: "online" },
            { metric: "torrents_state_paused", label: "Paused", color: "neutral" },
            { metric: "torrents_state_stalled", label: "Stalled", color: "warning" },
            { metric: "torrents_state_errored", label: "Errored", color: "failed" },
          ],
        },
      },
      chart: {
        title: "TRANSFER SPEED (B/s)",
        style: "mirror",
        series: [
          { metric: "dl_speed_bytes", label: "Download" },
          { metric: "up_speed_bytes", label: "Upload" },
        ],
      },
      events: true,
    };
  }
}
