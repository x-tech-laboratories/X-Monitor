import { describe, expect, it } from "vitest";

import { http_result, type HttpRequest, type HttpResult, type Result } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Syncthing } from "../../src/monitors/syncthing.ts";
import { make_plugin, run_requests, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-syncthing",
  id: "test-syncthing",
  api_url: "http://syncthing.test:8384",
  api_key: "testkey",
  ssh_config: { host: "test.host" },
};

const ok = (payload: unknown): HttpResult => http_result(200, JSON.stringify(payload));

const default_config = {
  folders: [{ id: "docs" }, { id: "photos" }] as Record<string, unknown>[],
  devices: [{ deviceID: "DEV1", name: "Odin" }, { deviceID: "DEV2", name: "Thor" }] as Record<string, unknown>[],
};

function folder_status({ state = "idle", need_files = 0, need_bytes = 0, pull_errors = 0, invalid = "" } = {}): Record<string, unknown> {
  return { state, needFiles: need_files, needBytes: need_bytes, pullErrors: pull_errors, invalid };
}

function connections(connected = true) {
  return { connections: { DEV1: { connected }, DEV2: { connected } } };
}

function syncthing(extra: PluginConfig = {}): Syncthing {
  return make_plugin(Syncthing, { ...base_config, ...extra });
}

// Answers each request in turn from a list.
function in_turn(responses: Result[]): () => Result {
  let index = 0;
  return () => responses[index++];
}

// The first cycle discovers folder IDs from config and connections; the second fetches each discovered folder's status.
function collect_twice(plugin: Syncthing, options: { config?: typeof default_config; folder_statuses?: Record<string, Record<string, unknown>>; connections?: unknown; watched_folders?: string[] } = {}) {
  const config = options.config ?? default_config;
  const watched = options.watched_folders ?? config.folders.map((folder) => String(folder.id));
  const statuses = options.folder_statuses ?? { docs: folder_status(), photos: folder_status() };
  const links = options.connections ?? connections();
  run_requests(plugin, in_turn([ok(config), ok(links)]));
  return run_requests(plugin, in_turn([ok(config), ok(links), ...watched.map((folder_id) => ok(statuses[folder_id]))]));
}

const latest_status = (plugin: Syncthing) => store_of(plugin).store.statuses.get("test-syncthing")?.state ?? null;
const latest_metric = (plugin: Syncthing, name: string) => store_of(plugin).latest_metric("test-syncthing", name)?.value ?? null;
const tiles = (plugin: Syncthing) => Object.fromEntries(plugin.data.latest_snapshot<Record<string, string>[]>()!.map((item) => [item.label, item]));

describe("requests", () => {
  it("asks for config and connections with the api key header", () => {
    const requests = syncthing().requests() as HttpRequest[];
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.kind === "http")).toBe(true);
    expect(requests[0].url).toBe("http://syncthing.test:8384/rest/system/config");
    expect(requests[1].url).toBe("http://syncthing.test:8384/rest/system/connections");
    expect(requests[0].headers).toEqual({ "X-API-Key": "testkey" });
  });

  it("asks nothing without a url", () => {
    expect(make_plugin(Syncthing, { name: "s", id: "s", ssh_config: { host: "h" } }).requests()).toEqual([]);
  });

  it("adds folder requests after discovery", () => {
    const plugin = syncthing();
    plugin.cached_folder_ids = ["docs", "photos"];
    const requests = plugin.requests() as HttpRequest[];
    expect(requests).toHaveLength(4);
    expect(requests[2].url.endsWith("/rest/db/status?folder=docs")).toBe(true);
    expect(requests[3].url.endsWith("/rest/db/status?folder=photos")).toBe(true);
  });
});

describe("collection", () => {
  it("calls idle folders and connected devices online", () => {
    const plugin = syncthing();
    collect_twice(plugin);
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a folder in error", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ state: "error" }), photos: folder_status() } });
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails an idle folder that still needs files", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ state: "idle", need_files: 5, need_bytes: 1000 }), photos: folder_status() } });
    expect(latest_status(plugin)).toBe("failed");
  });

  it("warns on pull errors", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ pull_errors: 2 }), photos: folder_status() } });
    expect(latest_status(plugin)).toBe("warning");
  });

  it("stays online with pull errors below the threshold", () => {
    const plugin = syncthing({ pull_errors_warning: 5 });
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ pull_errors: 4 }), photos: folder_status() } });
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "pull_errors")).toBe(4);
  });

  it("warns on pull errors at the threshold", () => {
    const plugin = syncthing({ pull_errors_warning: 5 });
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ pull_errors: 3 }), photos: folder_status({ pull_errors: 2 }) } });
    expect(latest_status(plugin)).toBe("warning");
  });

  it("does not expect the local device", () => {
    const plugin = syncthing();
    const config = { ...default_config, devices: [...default_config.devices, { deviceID: "SELF", name: "Heimdall" }] };
    collect_twice(plugin, { config });
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "devices_expected")).toBe(2);
    expect(latest_metric(plugin, "devices_disconnected")).toBe(0);
  });

  it("warns on a disconnected device", () => {
    const plugin = syncthing();
    collect_twice(plugin, { connections: connections(false) });
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails an invalid folder", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ invalid: "path missing" }), photos: folder_status() } });
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a config transport error unavailable", () => {
    const plugin = syncthing();
    run_requests(plugin, in_turn([http_result(null, "", { error: "connection refused" }), ok(connections())]));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a bad api key unavailable", () => {
    const plugin = syncthing();
    run_requests(plugin, in_turn([http_result(403, "CSRF"), ok(connections())]));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a folder status error unavailable", () => {
    const plugin = syncthing();
    run_requests(plugin, in_turn([ok(default_config), ok(connections())]));
    run_requests(plugin, in_turn([ok(default_config), ok(connections()), http_result(null, "", { error: "timeout" }), ok(folder_status())]));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a folder still syncing info", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ state: "syncing", need_files: 3, need_bytes: 500 }), photos: folder_status() } });
    expect(latest_status(plugin)).toBe("info");
  });

  it("keeps a scanning folder online", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ state: "scanning" }), photos: folder_status() } });
    expect(latest_status(plugin)).toBe("online");
  });

  it("discovers folders on the first cycle", () => {
    const plugin = syncthing();
    const result = run_requests(plugin, in_turn([ok(default_config), ok(connections())]));
    expect(result.status).toBe("info");
    expect(plugin.cached_folder_ids).toEqual(["docs", "photos"]);
  });

  it("leaves out folders the filter does not name", () => {
    const plugin = syncthing({ folders: ["docs"] });
    collect_twice(plugin, { watched_folders: ["docs"], folder_statuses: { docs: folder_status(), photos: folder_status({ state: "error" }) } });
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(syncthing().plan_action("anything")).toBeNull();
  });
});

describe("folder snapshot", () => {
  it("shows an idle folder as up to date under its label", () => {
    const plugin = syncthing();
    collect_twice(plugin, { config: { ...default_config, folders: [{ id: "docs", label: "Documents" }, { id: "photos" }] } });
    const items = tiles(plugin);
    expect(Object.keys(items)).toEqual(["Documents", "photos"]);
    expect(items.Documents).toMatchObject({ state: "idle", caption: "up to date", status: "online" });
  });

  it("shows a syncing folder's progress", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: { ...folder_status({ state: "syncing", need_bytes: 180 }), globalBytes: 1000 }, photos: folder_status() } });
    expect(tiles(plugin).docs).toMatchObject({ state: "syncing", caption: "syncing 82%", status: "info" });
  });

  it("marks a folder syncing past the stall warning as stalled", () => {
    const plugin = syncthing({ stall_warning: 0 });
    collect_twice(plugin, { folder_statuses: { docs: { ...folder_status({ state: "syncing", need_bytes: 500 }), globalBytes: 1000 }, photos: folder_status() } });
    expect(tiles(plugin).docs).toMatchObject({ state: "stalled", caption: "stalled 50%", status: "warning" });
  });

  it("counts a folder's pull errors", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ pull_errors: 2 }), photos: folder_status() } });
    expect(tiles(plugin).docs).toMatchObject({ caption: "2 errors", status: "warning" });
  });

  it("fails an errored folder", () => {
    const plugin = syncthing();
    collect_twice(plugin, { folder_statuses: { docs: folder_status({ invalid: "path missing" }), photos: folder_status({ state: "idle", need_files: 1, need_bytes: 10 }) } });
    const items = tiles(plugin);
    expect(items.docs).toMatchObject({ state: "error", caption: "path missing", status: "failed" });
    expect(items.photos).toMatchObject({ state: "error", caption: "out of sync" });
  });

  it("shows a paused folder as paused", () => {
    const plugin = syncthing();
    collect_twice(plugin, { config: { ...default_config, folders: [{ id: "docs", paused: true }, { id: "photos" }] } });
    expect(tiles(plugin).docs).toMatchObject({ state: "paused", caption: "paused", status: "unavailable" });
  });
});

describe("folder tiles", () => {
  it("show each folder by its status", () => {
    const spec = syncthing().UI_SPEC;
    const repeat = spec.cards!.folder_tiles.repeat!;
    expect(repeat.source).toBe("snapshot");
    expect(repeat.container).toBe("tiles");
    expect((repeat.item_format_fn as (item: Record<string, unknown>) => string)({ caption: "syncing 82%" })).toBe("syncing 82%");
    expect((repeat.item_color_by as (item: Record<string, unknown>) => unknown)({ status: "failed" })).toBe("failed");
    expect(spec.layout!.some((row) => row.includes("folder_tiles"))).toBe(true);
  });

  it("keep the cards' threshold colors", () => {
    const cards = syncthing().UI_SPEC.cards!;
    expect((cards.errors_card.color as (value: number) => unknown)(1)).toBe("failed");
    expect((cards.stalled_card.color as (value: number) => unknown)(1)).toBe("warning");
  });
});

describe("optional limits", () => {
  it("never stalls with a null stall warning", () => {
    const plugin = syncthing({ stall_warning: null });
    collect_twice(plugin, { folder_statuses: { docs: { ...folder_status({ state: "syncing", need_bytes: 500 }), globalBytes: 1000 }, photos: folder_status() } });
    expect(latest_status(plugin)).toBe("info");
    expect(latest_metric(plugin, "folders_stalled")).toBe(0);
  });
});
