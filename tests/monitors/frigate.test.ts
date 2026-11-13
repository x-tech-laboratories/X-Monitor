import { afterEach, describe, expect, it, vi } from "vitest";

import { http_result, type CollectResult, type HttpRequest, type HttpResult, type IoActionPlan, type Request } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Frigate, parse_config, parse_response, type CameraItem } from "../../src/monitors/frigate.ts";
import { FORMATTERS, COLOR_RULES } from "../../src/shared/ui_registry.ts";
import { make_test_plugin, run_requests, store_of, type FakeEngine } from "../harness.ts";

const base_config: PluginConfig = { name: "test-frigate", id: "test-frigate", api_url: "http://frigate.test:5000", ssh_config: { host: "test.host" } };

// One camera's /api/stats entry, with exactly the keys Frigate 0.17 emits.
function camera_stats({ camera_fps = 5.0, detection_fps = 1.0, ffmpeg_pid = 4389 as number | null } = {}) {
  return {
    camera_fps, process_fps: camera_fps, skipped_fps: 0.0, detection_fps, detection_enabled: true,
    pid: 4338, capture_pid: 4390, ffmpeg_pid, audio_rms: 0.0, audio_dBFS: 0.0,
  };
}

// One camera's /api/config entry; `enabled` is the live armed state Frigate mutates over MQTT.
function camera_config({ enabled = true, enabled_in_config = true, fps = 5 } = {}) {
  return { enabled, enabled_in_config, detect: { enabled: true, width: 1280, height: 720, fps } };
}

function stats(cameras?: Record<string, unknown>, detectors?: Record<string, unknown>) {
  return { cameras: cameras ?? { front_door: camera_stats() }, detectors: detectors ?? { coral: { inference_speed: 9.5 } }, camera_fps: 5.0, detection_fps: 1.0 };
}

function config(cameras?: Record<string, unknown>) {
  return { cameras: cameras ?? { front_door: camera_config() } };
}

// Answers each request with its own endpoint's payload.
function responder(stats_payload: unknown = stats(), config_payload: unknown = config()) {
  const stats_body = JSON.stringify(stats_payload);
  const config_body = JSON.stringify(config_payload);
  return (request: Request): HttpResult => http_result(200, (request as HttpRequest).url.endsWith("/api/config") ? config_body : stats_body);
}

function frigate(extra: PluginConfig = {}) {
  return make_test_plugin(Frigate, { ...base_config, ...extra });
}

const latest_status = (plugin: Frigate, id = "test-frigate") => store_of(plugin).store.statuses.get(id)?.state ?? null;
const latest_metric = (plugin: Frigate, name: string) => store_of(plugin).latest_metric("test-frigate", name)?.value ?? null;
const snapshot = (plugin: Frigate) => plugin.data.latest_snapshot<CameraItem[]>()!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fixtures", () => {
  it("carry no invented stats fields", () => {
    for (const camera of Object.values(stats().cameras) as Record<string, unknown>[]) {
      expect(camera).not.toHaveProperty("connection_quality");
      expect(camera).not.toHaveProperty("stalls_last_hour");
      expect(camera).not.toHaveProperty("reconnects_last_hour");
    }
  });
});

describe("requests", () => {
  it("target the stats and config endpoints", () => {
    const requests = frigate().plugin.requests() as HttpRequest[];
    expect(requests.map((request) => request.kind)).toEqual(["http", "http"]);
    expect(requests.map((request) => request.url)).toEqual(["http://frigate.test:5000/api/stats", "http://frigate.test:5000/api/config"]);
  });

  it("are none without a url", () => {
    expect(make_test_plugin(Frigate, { name: "f", id: "f", ssh_config: { host: "h" } }).plugin.requests()).toEqual([]);
  });
});

describe("parse response", () => {
  it("parses cameras", () => {
    expect(parse_response('{"cameras": {"a": {}}}').cameras).toHaveProperty("a");
  });

  it("throws without cameras", () => {
    expect(() => parse_response('{"foo": "bar"}')).toThrow("missing 'cameras'");
  });

  it("throws on malformed JSON", () => {
    expect(() => parse_response("not json")).toThrow();
  });

  it("parses camera configs", () => {
    expect(parse_config('{"cameras": {"a": {"enabled": false}}}').a.enabled).toBe(false);
  });

  it("throws on a config without cameras", () => {
    expect(() => parse_config('{"detectors": {}}')).toThrow("missing 'cameras'");
  });

  it("throws on a malformed config", () => {
    expect(() => parse_config("not json")).toThrow();
  });
});

describe("collection", () => {
  it("calls a streaming camera online", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder());
    expect(latest_status(plugin)).toBe("online");
  });

  it("keeps a disarmed camera online", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(
      stats({ front_door: camera_stats({ camera_fps: 0.0, detection_fps: 0.0, ffmpeg_pid: 0 }) }),
      config({ front_door: camera_config({ enabled: false }) }),
    ));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "cameras_disarmed")).toBe(1.0);
    expect(latest_metric(plugin, "cameras_armed")).toBe(0.0);
    expect(latest_metric(plugin, "cameras_stalled")).toBe(0.0);
  });

  it("fails an armed camera without a stream", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(stats({ front_door: camera_stats({ camera_fps: 0.0, detection_fps: 0.0, ffmpeg_pid: 0 }) })));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "cameras_stalled")).toBe(1.0);
  });

  it("fails an armed camera with a dead ffmpeg", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(stats({ front_door: camera_stats({ ffmpeg_pid: null }) })));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("warns when fps falls below the ratio", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(stats({ front_door: camera_stats({ camera_fps: 2.0 }) })));
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "cameras_degraded")).toBe(1.0);
  });

  it("stays online with fps within the ratio", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(stats({ front_door: camera_stats({ camera_fps: 4.5 }) })));
    expect(latest_status(plugin)).toBe("online");
  });

  it("takes min_fps_ratio from config", () => {
    const { plugin } = frigate({ min_fps_ratio: 0.5 });
    run_requests(plugin, responder(stats({ front_door: camera_stats({ camera_fps: 3.0 }) })));
    expect(latest_status(plugin)).toBe("online");
  });

  it("does not degrade a camera without a configured fps", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(stats({ front_door: camera_stats({ camera_fps: 1.0 }) }), config({ front_door: camera_config({ fps: 0 }) })));
    expect(latest_status(plugin)).toBe("online");
  });

  it("lets the worst camera win", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(
      stats({ good_cam: camera_stats(), bad_cam: camera_stats({ camera_fps: 0.0, ffmpeg_pid: 0 }) }),
      config({ good_cam: camera_config(), bad_cam: camera_config() }),
    ));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("does not let a disarmed camera mask a broken one", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(
      stats({ off_cam: camera_stats({ camera_fps: 0.0, ffmpeg_pid: 0 }), bad_cam: camera_stats({ camera_fps: 0.0, ffmpeg_pid: 0 }) }),
      config({ off_cam: camera_config({ enabled: false }), bad_cam: camera_config() }),
    ));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "cameras_disarmed")).toBe(1.0);
    expect(latest_metric(plugin, "cameras_stalled")).toBe(1.0);
  });

  it("counts a camera disabled in config as disarmed", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(
      stats({ front_door: camera_stats({ camera_fps: 0.0, ffmpeg_pid: 0 }) }),
      config({ front_door: camera_config({ enabled: false, enabled_in_config: false }) }),
    ));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "cameras_disarmed")).toBe(1.0);
  });

  it("records fps and inference metrics", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder());
    expect(latest_metric(plugin, "camera_fps_total")).toBe(5.0);
    expect(latest_metric(plugin, "detection_fps_total")).toBe(1.0);
    expect(latest_metric(plugin, "detector_inference_ms")).toBe(9.5);
    expect(latest_metric(plugin, "cameras_total")).toBe(1.0);
  });

  it("calls a transport error unavailable", () => {
    const { plugin } = frigate();
    run_requests(plugin, () => http_result(null, "", { error: "connection refused" }));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls malformed stats unavailable", () => {
    const { plugin } = frigate();
    run_requests(plugin, () => http_result(200, "not json"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("fails a non-200 reply", () => {
    const { plugin } = frigate();
    run_requests(plugin, () => http_result(502, ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails a config endpoint failure", () => {
    const { plugin } = frigate();
    run_requests(plugin, (request) => ((request as HttpRequest).url.endsWith("/api/config") ? http_result(500, "") : http_result(200, JSON.stringify(stats()))));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a missing url unavailable", () => {
    const { plugin } = make_test_plugin(Frigate, { name: "f", id: "f", ssh_config: { host: "h" } });
    run_requests(plugin, responder());
    expect(latest_status(plugin, "f")).toBe("unavailable");
  });

  it("leaves out cameras the filter does not name", () => {
    const { plugin } = frigate({ cameras: ["only_this"] });
    run_requests(plugin, responder(
      stats({ only_this: camera_stats(), ignored: camera_stats({ camera_fps: 0.0, ffmpeg_pid: 0 }) }),
      config({ only_this: camera_config(), ignored: camera_config() }),
    ));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "cameras_total")).toBe(1.0);
  });

  it("warns with no matching cameras", () => {
    const { plugin } = frigate({ cameras: ["nonexistent"] });
    run_requests(plugin, responder());
    expect(latest_status(plugin)).toBe("warning");
  });
});

describe("actions", () => {
  it("handles no other action", () => {
    expect(frigate().plugin.plan_action("anything")).toBeNull();
  });
});

describe("recordings sync actions", () => {
  const queued = { job: { id: "abc123", status: "queued" } };

  function job(status: string, recordings: unknown = null, error_message: string | null = null): HttpResult {
    const results = recordings !== null ? { recordings } : null;
    return http_result(200, JSON.stringify({ job: { id: "abc123", status, results, error_message } }));
  }

  // Answers the POST with `post` and each status GET in turn from `gets`, never sleeping between polls.
  async function run(plugin: Frigate, engine: FakeEngine, action_id: string, post: HttpResult, gets: HttpResult[]) {
    const posted: HttpRequest[] = [];
    let index = 0;
    engine.http_fetch_handler = (request) => {
      if (request.method === "POST") {
        posted.push(request);
        return post;
      }
      return gets[index++];
    };
    vi.spyOn(plugin, "pause").mockResolvedValue();
    const plan = plugin.plan_action(action_id) as IoActionPlan;
    const outcome = plugin.interpret_action(action_id, await plan.call()) as CollectResult;
    return { outcome, posted };
  }

  it("lists both actions", () => {
    expect(frigate().plugin.get_actions().map((action) => action.action_id)).toEqual(["preview_recordings_sync", "sync_recordings"]);
  });

  it("plans no unknown action", () => {
    expect(frigate().plugin.plan_action("anything")).toBeNull();
  });

  it("plans io actions", () => {
    const { plugin } = frigate();
    expect((plugin.plan_action("preview_recordings_sync") as IoActionPlan).kind).toBe("io_action");
    expect((plugin.plan_action("sync_recordings") as IoActionPlan).kind).toBe("io_action");
  });

  it("previews as a dry run and reports what it found", async () => {
    const { plugin, engine } = frigate();
    const recordings = { files_checked: 40, orphans_found: 3, orphans_deleted: 0, aborted: false };
    const { outcome, posted } = await run(plugin, engine, "preview_recordings_sync", http_result(202, JSON.stringify(queued)), [job("running"), job("success", recordings)]);
    expect(outcome.success).toBe(true);
    expect(outcome.logs[0][0]).toContain("3 orphaned recordings in 40 checked; nothing changed");
    expect(posted[0].url).toBe("http://frigate.test:5000/api/media/sync");
    expect(JSON.parse(posted[0].body!)).toEqual({ media_types: ["recordings"], dry_run: true, force: false });
  });

  it("syncs as a real run and never forced", async () => {
    const { plugin, engine } = frigate();
    const recordings = { files_checked: 40, orphans_found: 3, orphans_deleted: 3, aborted: false };
    const { outcome, posted } = await run(plugin, engine, "sync_recordings", http_result(202, JSON.stringify(queued)), [job("success", recordings)]);
    expect(outcome.success).toBe(true);
    expect(outcome.logs[0][0]).toContain("removed 3 of 3");
    expect(JSON.parse(posted[0].body!)).toEqual({ media_types: ["recordings"], dry_run: false, force: false });
  });

  it("fails on a safety threshold abort", async () => {
    const { plugin, engine } = frigate();
    const recordings = { files_checked: 40, orphans_found: 39, orphans_deleted: 0, aborted: true };
    const { outcome } = await run(plugin, engine, "sync_recordings", http_result(202, JSON.stringify(queued)), [job("success", recordings)]);
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][0]).toContain("safety threshold");
  });

  it("fails a failed job with its reason", async () => {
    const { plugin, engine } = frigate();
    const { outcome } = await run(plugin, engine, "sync_recordings", http_result(202, JSON.stringify(queued)), [job("failed", null, "disk on fire")]);
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][0]).toContain("disk on fire");
  });

  it("does not fault a job already running", async () => {
    const { plugin, engine } = frigate();
    const { outcome } = await run(plugin, engine, "sync_recordings", http_result(409, JSON.stringify({ error: "already running" })), []);
    expect(outcome.success).toBe(true);
    expect(outcome.logs[0][0]).toContain("already running");
  });

  it("fails a rejected request", async () => {
    const { plugin, engine } = frigate();
    const { outcome } = await run(plugin, engine, "sync_recordings", http_result(500, "boom"), []);
    expect(outcome.success).toBe(false);
  });

  it("reports, not fails, a job outlasting the timeout", async () => {
    const { plugin, engine } = frigate();
    plugin.sync_timeout = 0;
    const { outcome } = await run(plugin, engine, "preview_recordings_sync", http_result(202, JSON.stringify(queued)), []);
    expect(outcome.success).toBe(true);
    expect(outcome.logs[0][0]).toContain("still running");
  });

  it("fails an unreachable api", async () => {
    const { plugin, engine } = frigate();
    engine.http_fetch_handler = () => http_result(null, "", { error: "boom" });
    const plan = plugin.plan_action("sync_recordings") as IoActionPlan;
    expect((plugin.interpret_action("sync_recordings", await plan.call()) as CollectResult).success).toBe(false);
  });

  it("fails without an api url", async () => {
    const { plugin } = make_test_plugin(Frigate, { name: "f", id: "f", ssh_config: { host: "h" } });
    const plan = plugin.plan_action("sync_recordings") as IoActionPlan;
    expect((plugin.interpret_action("sync_recordings", await plan.call()) as CollectResult).success).toBe(false);
  });
});

describe("page", () => {
  it("shows armed and disarmed cameras as one share", () => {
    const spec = frigate().plugin.UI_SPEC;
    const card = spec.cards!.armed_card;
    expect(card.kind).toBe("share");
    expect(card.parts!.map((part) => [part.metric, part.color])).toEqual([["cameras_armed", "online"], ["cameras_disarmed", "neutral"]]);
    expect(spec.cards).not.toHaveProperty("disarmed_card");
    expect(spec.layout!.every((row) => !row.includes("disarmed_card"))).toBe(true);
  });

  it("names and colors the worst camera rank", () => {
    expect(FORMATTERS.frigate_camera_state(1)).toBe("DEGRADED");
    expect(FORMATTERS.frigate_camera_state(null)).toBe("--");
    expect(COLOR_RULES.frigate_camera_state_color(0)).toBe("failed");
    expect(COLOR_RULES.frigate_camera_state_color(2)).toBe("online");
  });
});

describe("camera snapshot", () => {
  it("makes each watched camera one item with its fps against its target", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(
      stats({ front_door: camera_stats({ camera_fps: 4.9 }), yard: camera_stats({ camera_fps: 5.0 }) }),
      config({ front_door: camera_config({ fps: 10 }), yard: camera_config({ fps: 5 }) }),
    ));
    const items = snapshot(plugin);
    expect(items.map((item) => item.label)).toEqual(["front_door", "yard"]);
    expect(items[0].fps).toBe(4.9);
    expect(items[0].target_fps).toBe(10.0);
    expect(items[0].fps_pct).toBeCloseTo(49.0);
    expect(items[0].state).toBe("degraded");
    expect(items[1].state).toBe("healthy");
  });

  it("measures a camera without a configured fps against five", () => {
    const { plugin } = frigate();
    run_requests(plugin, responder(undefined, config({ front_door: { enabled: true } })));
    const item = snapshot(plugin)[0];
    expect(item.target_fps).toBeNull();
    expect(item.fps_pct).toBeCloseTo(100.0);
  });

  it("leaves out unwatched cameras", () => {
    const { plugin } = frigate({ cameras: ["yard"] });
    run_requests(plugin, responder(stats({ front_door: camera_stats(), yard: camera_stats() }), config({ front_door: camera_config(), yard: camera_config() })));
    expect(snapshot(plugin).map((item) => item.label)).toEqual(["yard"]);
  });
});

describe("camera bars", () => {
  it("meter each camera against its target", () => {
    const spec = frigate().plugin.UI_SPEC;
    const repeat = spec.cards!.camera_bars.repeat!;
    expect(repeat.source).toBe("snapshot");
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_value).toBe("fps_pct");
    expect(repeat.bar_max).toBe(100);
    expect(repeat.bar_marker).toBeCloseTo(80.0);
    expect(spec.layout!.some((row) => row.includes("camera_bars"))).toBe(true);
  });

  it("read in fps and say disarmed", () => {
    const format_item = frigate().plugin.UI_SPEC.cards!.camera_bars.repeat!.item_format_fn as (item: Record<string, unknown>) => string;
    expect(format_item({ fps: 4.94, state: "healthy" })).toBe("4.9 fps");
    expect(format_item({ fps: 0.0, state: "disarmed" })).toBe("disarmed");
  });

  it("warn when slow and fail when stalled", () => {
    const color_item = frigate().plugin.UI_SPEC.cards!.camera_bars.repeat!.item_color_by as (item: Record<string, unknown>) => unknown;
    expect(color_item({ state: "healthy" })).toBe("online");
    expect(color_item({ state: "degraded" })).toBe("warning");
    expect(color_item({ state: "stalled" })).toBe("failed");
    expect(color_item({ state: "disarmed" })).toBeNull();
  });
});
