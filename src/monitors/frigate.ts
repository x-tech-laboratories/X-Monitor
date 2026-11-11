// Frigate NVR camera health, from one GET each of /api/stats and /api/config over HTTP from the X-Monitor host.
// Config: api_url (required, X-Monitor-reachable), cameras (the subset to watch, default all), min_fps_ratio,
// api_timeout, sync_timeout. A camera Frigate has disarmed is reported as disarmed and never faults the monitor; an
// armed one fails when its capture process is gone or its stream has stopped, and warns when it delivers less than
// min_fps_ratio of its configured detect fps. An API answering with an HTTP error is failed; an unreachable API, a
// malformed payload, or a missing api_url is unavailable, since no camera was measured. No matching cameras is a
// warning pointing at the 'cameras' list.

import { python_dumps, python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { CollectResult, http_request, io_action_plan, type ActionOutcome, type ActionPlanResult, type HttpRequest, type HttpResult, type Request, type Result } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import { register_color_rule, register_formatter } from "../shared/ui_registry.ts";
import type { ActionButtonSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";

type Json = Record<string, unknown>;

type CameraState = "stalled" | "degraded" | "disarmed" | "healthy";

// Ordered worst-first, so the lowest rank a survey sees is the one worth showing.
const state_order: Record<CameraState, number> = { stalled: 0, degraded: 1, disarmed: 2, healthy: 3 };

const state_status: Record<CameraState, Status> = { stalled: "failed", degraded: "warning", disarmed: "online", healthy: "online" };

function monotonic(): number {
  return performance.now() / 1000;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// The decoded /api/stats payload, throwing unless it is JSON carrying 'cameras'.
export function parse_response(stdout: string): Json {
  let stats: unknown;
  try {
    stats = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`stats response was not JSON (${(error as Error).message}): ${python_repr(stdout.slice(0, 200))}`);
  }
  if (typeof stats !== "object" || stats === null || Array.isArray(stats) || !("cameras" in stats)) {
    throw new Error(`stats missing 'cameras': ${python_repr(stdout.slice(0, 200))}`);
  }
  return stats as Json;
}

// The per-camera section of the decoded /api/config payload, throwing when it is unusable.
export function parse_config(stdout: string): Record<string, Json> {
  let config: unknown;
  try {
    config = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`config response was not JSON (${(error as Error).message}): ${python_repr(stdout.slice(0, 200))}`);
  }
  const cameras = typeof config === "object" && config !== null && !Array.isArray(config) ? (config as Json).cameras : null;
  if (typeof cameras !== "object" || cameras === null || Array.isArray(cameras)) throw new Error(`config missing 'cameras': ${python_repr(stdout.slice(0, 200))}`);
  return cameras as Record<string, Json>;
}

// The unavailable or failed CollectResult for a transport or HTTP error, or null when the response is usable.
function http_failure(result: HttpResult): CollectResult | null {
  if (result.error !== null) return CollectResult.unavailable(`Failed to query Frigate API: ${result.error}`);
  if (result.status_code !== 200) return CollectResult.failed(`Frigate API returned HTTP ${result.status_code}`);
  return null;
}

// Mean detector inference speed in milliseconds, 0.0 when there are no detectors.
function average_inference_ms(detectors: Record<string, Json>): number {
  const values = Object.values(detectors);
  if (values.length === 0) return 0.0;
  return values.reduce((sum, detector) => sum + Number(detector.inference_speed || 0), 0) / values.length;
}

// Classifies one camera as disarmed, stalled, degraded or healthy, with its measured and configured fps.
function camera_state(camera_data: Json, camera_config: Json, min_fps_ratio: number): [CameraState, number, number] {
  const fps = Number(camera_data.camera_fps || 0);
  const target = Number(((camera_config.detect || {}) as Json).fps || 0);
  // Frigate mutates `enabled` as the camera is armed and disarmed over MQTT; enabled_in_config keeps the file value.
  const setting = (key: string): unknown => (key in camera_config ? camera_config[key] : true);
  const armed = Boolean(setting("enabled") && setting("enabled_in_config"));
  if (!armed) return ["disarmed", fps, target];
  if (!camera_data.ffmpeg_pid || fps <= 0) return ["stalled", fps, target];
  if (target > 0 && fps < target * min_fps_ratio) return ["degraded", fps, target];
  return ["healthy", fps, target];
}

interface Survey {
  counts: Record<CameraState, number>;
  worst_state: CameraState;
  worst_camera: string | null;
  totals: { camera_fps: number; detection_fps: number };
  problems: string[];
}

// Classifies every watched camera into per-state counts, the worst state and its camera, fps totals and problem lines.
function survey_cameras(watched: [string, Json][], camera_configs: Record<string, Json>, min_fps_ratio: number): Survey {
  const counts: Record<CameraState, number> = { stalled: 0, degraded: 0, disarmed: 0, healthy: 0 };
  const totals = { camera_fps: 0.0, detection_fps: 0.0 };
  let worst_state: CameraState = "healthy";
  let worst_camera: string | null = null;
  const problems: string[] = [];

  for (const [camera_name, camera_data] of watched) {
    const [state, fps, target] = camera_state(camera_data, camera_configs[camera_name] || {}, min_fps_ratio);
    counts[state] += 1;
    totals.camera_fps += fps;
    totals.detection_fps += Number(camera_data.detection_fps || 0);
    if (state_order[state] < state_order[worst_state]) {
      worst_state = state;
      worst_camera = camera_name;
    }
    if (state === "stalled") problems.push(`${camera_name}: armed but not streaming (${fps.toFixed(1)} fps)`);
    else if (state === "degraded") problems.push(`${camera_name}: ${fps.toFixed(1)} of ${target.toFixed(0)} fps`);
  }
  return { counts, worst_state, worst_camera, totals, problems };
}

// A camera whose config sets no detect fps is metered against this rate.
const fallback_target_fps = 5.0;

const state_color: Partial<Record<string, Status>> = { stalled: "failed", degraded: "warning", healthy: "online" };

export interface CameraItem {
  label: string;
  state: CameraState;
  fps: number;
  target_fps: number | null;
  fps_pct: number;
}

// One snapshot item per watched camera, by name, with its state, fps and fps as a share of its target.
function camera_items(watched: [string, Json][], camera_configs: Record<string, Json>, min_fps_ratio: number): CameraItem[] {
  const by_name = new Map(watched);
  return [...by_name.keys()].sort().map((camera_name) => {
    const [state, fps, target] = camera_state(by_name.get(camera_name)!, camera_configs[camera_name] || {}, min_fps_ratio);
    const expected = target > 0 ? target : fallback_target_fps;
    return { label: camera_name, state, fps, target_fps: target > 0 ? target : null, fps_pct: (fps / expected) * 100.0 };
  });
}

// One camera's meter text: its fps, or that it is disarmed.
function camera_text(item: Record<string, unknown>): string {
  if (item.state === "disarmed") return "disarmed";
  return `${Number(item.fps || 0.0).toFixed(1)} fps`;
}

// One camera's meter color from its state, leaving a disarmed camera uncolored.
function camera_color(item: Record<string, unknown>): Status | null {
  return state_color[item.state as string] ?? null;
}

const rank_to_label: Record<number, string> = { 0: "STALLED", 1: "DEGRADED", 2: "DISARMED", 3: "HEALTHY" };

register_formatter("frigate_camera_state", (value) => (value === null ? "--" : (rank_to_label[Math.trunc(value)] ?? "UNKNOWN")));

register_color_rule("frigate_camera_state_color", (value) => {
  if (value === null) return null;
  const rank = Math.trunc(value);
  if (rank === 0) return "failed";
  if (rank === 1) return "warning";
  return "online";
});

// ── Recordings sync ──────────────────────────────────────────────────────────

export interface SyncOutcome {
  ok: boolean;
  log: string;
}

// One log line from a finished media sync job's recordings result.
function summarise_sync(name: string, dry_run: boolean, results: Json): SyncOutcome {
  const recordings = (results.recordings || {}) as Json;
  const checked = recordings.files_checked ?? 0;
  const found = recordings.orphans_found ?? 0;
  if (recordings.error) return { ok: false, log: `${name} failed: ${String(recordings.error)}` };
  if (recordings.aborted) {
    return { ok: false, log: `${name} aborted by Frigate's safety threshold: ${found} orphans in ${checked} checked looks like a misconfiguration, so nothing was removed` };
  }
  if (dry_run) return { ok: true, log: `Preview: ${found} orphaned recordings in ${checked} checked; nothing changed` };
  return { ok: true, log: `Sync: removed ${recordings.orphans_deleted ?? 0} of ${found} orphaned recordings in ${checked} checked` };
}

function json_of(result: HttpResult): Json {
  const decoded = JSON.parse(result.text) as unknown;
  return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) ? (decoded as Json) : {};
}

// ── Monitor ──────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "state_card", "fps_card"],
  ["detector_card", "armed_card"],
  ["camera_bars"],
  ["chart"],
  ["events"],
];

export class Frigate extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  // X-Monitor fetches this URL directly, so it must be an address X-Monitor can reach; a missing url fails loudly.
  readonly api_url: string | null;
  readonly cameras: string[] | null;
  readonly min_fps_ratio: number;
  readonly api_timeout: number;
  sync_timeout: number;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.api_url = (config.api_url as string | null | undefined) ?? null;
    const cameras = config.cameras as string[] | null | undefined;
    this.cameras = cameras && cameras.length > 0 ? cameras : null;
    this.min_fps_ratio = Number(config.min_fps_ratio ?? 0.8);
    this.api_timeout = Math.trunc(Number(config.api_timeout ?? 10));
    this.sync_timeout = Math.trunc(Number(config.sync_timeout ?? 300));
  }

  private get_request(path: string): HttpRequest {
    const base = (this.api_url ?? "").replace(/\/+$/, "");
    return http_request(`${base}${path}`, { timeout: this.api_timeout });
  }

  override requests(): Request[] {
    if (!this.api_url) return [];
    return [this.get_request("/api/stats"), this.get_request("/api/config")];
  }

  // Turns the [stats, config] results into camera-count and fps metrics, one summary line, and the worst watched
  // camera's state as status: an armed camera not streaming failed, a degraded one warning, a disarmed one online.
  override parse_results(results: Result[]): CollectResult {
    if (results.length < 2) return CollectResult.unavailable("No 'api_url' configured");

    const [stats_result, config_result] = results as HttpResult[];
    for (const result of [stats_result, config_result]) {
      const failure = http_failure(result);
      if (failure !== null) return failure;
    }

    let stats: Json;
    let camera_configs: Record<string, Json>;
    try {
      stats = parse_response(stats_result.text);
      camera_configs = parse_config(config_result.text);
    } catch (error) {
      return CollectResult.unavailable((error as Error).message);
    }

    const cameras = (stats.cameras ?? {}) as Record<string, Json>;
    const watched = Object.entries(cameras).filter(([name]) => this.cameras === null || this.cameras.includes(name));

    if (watched.length === 0) {
      return CollectResult.failed("No matching cameras reported by Frigate (check the 'cameras' config list against Frigate's own camera names)", "WARNING", "warning");
    }

    const detectors = (stats.detectors ?? {}) as Record<string, Json>;
    const average_inference = average_inference_ms(detectors);

    const { counts, worst_state, worst_camera, totals, problems } = survey_cameras(watched, camera_configs, this.min_fps_ratio);
    const armed = watched.length - counts.disarmed;

    const metrics = {
      cameras_total: watched.length,
      cameras_armed: armed,
      cameras_disarmed: counts.disarmed,
      cameras_degraded: counts.degraded,
      cameras_stalled: counts.stalled,
      camera_fps_total: totals.camera_fps,
      detection_fps_total: totals.detection_fps,
      detector_inference_ms: average_inference,
      worst_camera_rank: state_order[worst_state],
    };

    const level = state_status[worst_state];
    const parts = [
      `${watched.length} camera(s)`,
      `${armed} armed`,
      counts.disarmed ? `${counts.disarmed} disarmed` : "",
      worst_camera ? `worst: ${worst_camera} (${worst_state})` : "",
      `${totals.camera_fps.toFixed(1)} fps`,
    ];
    if (Object.keys(detectors).length > 0) parts.push(`${average_inference.toFixed(1)}ms inference`);
    if (problems.length > 0) parts.push(problems.join("; "));

    return new CollectResult({
      metrics,
      logs: [[parts.filter((part) => part).join(" | "), log_level_of(level)]],
      status: level,
      snapshot: camera_items(watched, camera_configs, this.min_fps_ratio),
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    return [
      { name: "Preview Recordings Sync", action_id: "preview_recordings_sync", variant: "secondary", icon: "search" },
      { name: "Sync Recordings", action_id: "sync_recordings", variant: "danger", icon: "sync" },
    ];
  }

  // Reconciles Frigate's recordings database against what is on disk through its on-demand /api/media/sync job; the
  // preview runs the same job as a dry run, since a real run deletes rows and files.
  override plan_action(action_id: string): ActionPlanResult {
    if (action_id !== "preview_recordings_sync" && action_id !== "sync_recordings") return null;
    const dry_run = action_id === "preview_recordings_sync";
    return io_action_plan(() => this.run_recordings_sync(dry_run));
  }

  // Waits between job polls; a test replaces it.
  pause(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  // Starts the job, waits for it up to sync_timeout, and summarises its result.
  async run_recordings_sync(dry_run: boolean): Promise<SyncOutcome> {
    const name = dry_run ? "Preview" : "Sync";
    if (!this.api_url) return { ok: false, log: `${name}: no 'api_url' configured` };
    const base = this.api_url.replace(/\/+$/, "");
    const response = await this.engine!.http_fetch(http_request(`${base}/api/media/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: python_dumps({ media_types: ["recordings"], dry_run, force: false }),
      timeout: this.api_timeout,
    }));
    if (response.error !== null || response.status_code === null) return { ok: false, log: `${name} request failed: ${response.error}` };

    // 409 means a job is already running, which is the work under way rather than a fault.
    if (response.status_code === 409) return { ok: true, log: "A media sync is already running" };
    if (response.status_code !== 202) return { ok: false, log: `${name} rejected (HTTP ${response.status_code}): ${response.text.slice(0, 200)}` };
    let job_id: unknown = null;
    try {
      job_id = ((json_of(response).job || {}) as Json).id;
    } catch {
      job_id = null;
    }
    if (!job_id) return { ok: false, log: `${name}: Frigate queued a job but returned no id` };

    const deadline = monotonic() + this.sync_timeout;
    while (monotonic() < deadline) {
      const status = await this.engine!.http_fetch(http_request(`${base}/api/media/sync/status/${String(job_id)}`, { timeout: this.api_timeout }));
      if (status.error !== null || status.status_code === null) return { ok: false, log: `${name}: lost track of job ${String(job_id)}: ${status.error}` };
      let job: Json;
      try {
        job = (json_of(status).job || {}) as Json;
      } catch (error) {
        return { ok: false, log: `${name}: lost track of job ${String(job_id)}: ${(error as Error).message}` };
      }
      const state = job.status;
      if (state === "success") return summarise_sync(name, dry_run, (job.results || {}) as Json);
      if (state === "failed" || state === "cancelled") return { ok: false, log: `${name} job ${state}: ${String(job.error_message || "no reason given")}` };
      await this.pause(2);
    }
    return { ok: true, log: `${name} still running after ${this.sync_timeout}s (job ${String(job_id)}); check Frigate's logs` };
  }

  override interpret_action(_action_id: string, result: unknown): ActionOutcome {
    const outcome = result as SyncOutcome;
    if (!outcome.ok) return CollectResult.failed(outcome.log);
    return new CollectResult({ logs: [[outcome.log, "INFO"]], success: true });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        state_card: { metric: "worst_camera_rank", title: "CAMERAS", format: "frigate_camera_state", color: "frigate_camera_state_color" },
        fps_card: { metric: "camera_fps_total", title: "CAMERA FPS", format: "decimal1" },
        detector_card: { metric: "detector_inference_ms", title: "INFERENCE", format: "ms1" },
        armed_card: {
          kind: "share",
          title: "ARMING",
          format: "int",
          parts: [
            { metric: "cameras_armed", label: "Armed", color: "online" },
            { metric: "cameras_disarmed", label: "Disarmed", color: "neutral" },
          ],
        },
        camera_bars: {
          title: "CAMERA FPS BY CAMERA",
          repeat: {
            source: "snapshot",
            container: "bars",
            bar_value: "fps_pct",
            bar_max: 100,
            bar_marker: this.min_fps_ratio * 100.0,
            item_format_fn: camera_text,
            item_color_by: camera_color,
            empty_text: "No cameras reported yet",
          },
        },
      },
      chart: { metric: "camera_fps_total", title: "CAMERA FPS" },
      events: true,
    };
  }
}
