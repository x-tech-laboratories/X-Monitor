import { describe, expect, it } from "vitest";

import { http_result, type HttpRequest } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { age_hours, parse_response, Trilium } from "../../src/monitors/trilium.ts";
import type { ColorRule } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_requests, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-trilium",
  id: "test-trilium",
  api_url: "http://trilium.test:8080",
  token: "abc123",
  stale_warning: 72,
  ssh_config: { host: "test.host" },
};

function iso(hours_ago: number): string {
  return new Date(Date.now() - hours_ago * 3_600_000).toISOString();
}

function response(hours_ago = 1.0, total_notes = 5000): string {
  return JSON.stringify({
    version: { app: "0.90.4" },
    database: { totalNotes: total_notes, activeNotes: total_notes - 100 },
    statistics: { lastModified: iso(hours_ago) },
  });
}

const plugin = (extra: PluginConfig = {}) => make_plugin(Trilium, { ...base_config, ...extra });

function run(monitor: Trilium, hours_ago = 1.0, total_notes = 5000) {
  const payload = response(hours_ago, total_notes);
  return run_requests(monitor, () => http_result(200, payload));
}

const latest_status = (monitor: Trilium) => store_of(monitor).store.statuses.get("test-trilium")?.state ?? null;
const latest_metric = (monitor: Trilium, name: string) => store_of(monitor).latest_metric("test-trilium", name)?.value ?? null;

describe("age hours", () => {
  it("reads a recent timestamp", () => {
    expect(Math.abs(age_hours(iso(3.0))! - 3.0)).toBeLessThan(0.1);
  });

  it("is null without a timestamp", () => {
    expect(age_hours(null)).toBeNull();
  });

  it("reads a timestamp without a zone as UTC", () => {
    const text = iso(3.0).replace("Z", "");
    expect(Math.abs(age_hours(text)! - 3.0)).toBeLessThan(0.1);
  });
});

describe("parse response", () => {
  it("parses the statistics", () => {
    expect(parse_response(response()).statistics).toHaveProperty("lastModified");
  });

  it("throws without statistics", () => {
    expect(() => parse_response('{"foo": "bar"}')).toThrow("statistics");
  });
});

describe("requests", () => {
  it("asks the metrics endpoint with the token header", () => {
    const requests = plugin().requests();
    expect(requests).toHaveLength(1);
    const request = requests[0] as HttpRequest;
    expect(request.kind).toBe("http");
    expect(request.url).toBe("http://trilium.test:8080/etapi/metrics?format=json");
    expect(request.headers).toEqual({ Authorization: "abc123" });
  });

  it("asks nothing without a url", () => {
    expect(make_plugin(Trilium, { name: "t", id: "t", ssh_config: { host: "h" } }).requests()).toEqual([]);
  });

  it("resolves a token command at construction", () => {
    const monitor = plugin({ token: null, token_command: "printf tok-xyz" });
    expect((monitor.requests()[0] as HttpRequest).headers).toEqual({ Authorization: "tok-xyz" });
  });
});

describe("collection", () => {
  it("calls a recent modification online", () => {
    const monitor = plugin();
    run(monitor, 1.0);
    expect(latest_status(monitor)).toBe("online");
  });

  it("warns on a stale modification", () => {
    const monitor = plugin();
    const result = run(monitor, 100.0);
    expect(latest_status(monitor)).toBe("warning");
    expect(result.logs[0][0]).toBe("no note modified in 4.2d (>= 3.0d threshold) | 5,000 total notes");
  });

  it("calls a transport error unavailable", () => {
    const monitor = plugin();
    run_requests(monitor, () => http_result(null, "", { error: "connection refused" }));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a 401 unavailable", () => {
    const monitor = plugin();
    run_requests(monitor, () => http_result(401, ""));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a malformed payload unavailable", () => {
    const monitor = plugin();
    run_requests(monitor, () => http_result(200, "{}"));
    expect(latest_status(monitor)).toBe("unavailable");
    expect(latest_metric(monitor, "notes_total")).toBeNull();
  });

  it("records the note count", () => {
    const monitor = plugin();
    run(monitor, 1.0, 1234);
    expect(latest_metric(monitor, "notes_total")).toBe(1234);
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(plugin().plan_action("anything")).toBeNull();
  });
});

describe("optional limits", () => {
  it("never warns with a null stale warning", () => {
    const monitor = plugin({ stale_warning: null });
    run(monitor, 1000.0);
    expect(latest_status(monitor)).toBe("online");
    expect((monitor.UI_SPEC.cards!.lastmod_card.color as ColorRule)(1000.0)).toBe("online");
  });
});
