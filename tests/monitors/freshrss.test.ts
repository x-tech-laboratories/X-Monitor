import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { http_result, type HttpRequest } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { fever_api_key, FeverAuthError, Freshrss, parse_response } from "../../src/monitors/freshrss.ts";
import type { ColorRule } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_requests, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-freshrss",
  id: "test-freshrss",
  api_url: "http://freshrss.test:80",
  username: "beatlink",
  api_password: "apipw",
  feed_stale_warning: 48,
  feed_stale_threshold: 168,
  refresh_stale_warning: 6,
  ssh_config: { host: "test.host" },
};

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

function feed(title = "Example", hours_ago = 1.0) {
  return { id: 1, title, last_updated_on_time: Date.now() / 1000 - hours_ago * 3600 };
}

function response(feeds: object[] | null = null, refresh_hours_ago = 1.0, auth = 1): string {
  return JSON.stringify({ api_version: 3, auth, last_refreshed_on_time: Date.now() / 1000 - refresh_hours_ago * 3600, feeds: feeds ?? [feed()] });
}

const plugin = (extra: PluginConfig = {}) => make_plugin(Freshrss, { ...base_config, ...extra });

function respond(monitor: Freshrss, feeds: object[] | null = null, refresh_hours_ago = 1.0, auth = 1) {
  return run_requests(monitor, () => http_result(200, response(feeds, refresh_hours_ago, auth)));
}

const latest_status = (monitor: Freshrss) => store_of(monitor).store.statuses.get("test-freshrss")?.state ?? null;
const latest_metric = (monitor: Freshrss, name: string) => store_of(monitor).latest_metric("test-freshrss", name)?.value ?? null;

describe("requests", () => {
  it("posts the md5 token as a form body", () => {
    const requests = plugin().requests();
    expect(requests).toHaveLength(1);
    const request = requests[0] as HttpRequest;
    expect(request.kind).toBe("http");
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://freshrss.test:80/api/fever.php?api&feeds");
    expect(request.body).toBe(`api_key=${md5("beatlink:apipw")}`);
    expect(request.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
  });

  it("makes the key as the Fever protocol does", () => {
    expect(fever_api_key("u", "p")).toBe(md5("u:p"));
  });

  it("asks nothing without a url", () => {
    expect(make_plugin(Freshrss, { name: "f", id: "f", username: "u", ssh_config: { host: "h" } }).requests()).toEqual([]);
  });

  it("resolves a password command at construction", () => {
    const monitor = plugin({ api_password: null, api_password_command: "printf remotepw" });
    expect((monitor.requests()[0] as HttpRequest).body).toBe(`api_key=${md5("beatlink:remotepw")}`);
  });
});

describe("parse response", () => {
  it("parses the feeds", () => {
    expect((parse_response(response()).feeds as unknown[]).length).toBe(1);
  });

  it("throws an auth error on auth 0", () => {
    expect(() => parse_response(response(null, 1.0, 0))).toThrow(FeverAuthError);
    expect(() => parse_response(response(null, 1.0, 0))).toThrow("rejected the credentials");
  });

  it("throws on malformed JSON", () => {
    expect(() => parse_response("not json")).toThrow();
  });
});

describe("collection", () => {
  it("calls fresh feeds online", () => {
    const monitor = plugin();
    respond(monitor, [feed("Example", 1.0)], 1.0);
    expect(latest_status(monitor)).toBe("online");
  });

  it("warns on a stale feed", () => {
    const monitor = plugin();
    const result = respond(monitor, [feed("Example", 60.0)]);
    expect(latest_status(monitor)).toBe("warning");
    expect(result.logs[0][0]).toContain("1 feed(s) aging: Example (2.5d)");
  });

  it("fails a very stale feed", () => {
    const monitor = plugin();
    respond(monitor, [feed("Example", 200.0)]);
    expect(latest_status(monitor)).toBe("failed");
  });

  it("warns on a stale refresh cycle", () => {
    const monitor = plugin();
    respond(monitor, [feed("Example", 10.0)], 10.0);
    expect(latest_status(monitor)).toBe("warning");
    expect(Math.abs(latest_metric(monitor, "refresh_age_hours")! - 10.0)).toBeLessThan(0.01);
  });

  it("takes the refresh age from the newest fetch, not the Fever field", () => {
    const monitor = plugin();
    respond(monitor, [feed("Paused", 14.0), feed("Live", 1.0)], 14.0);
    expect(latest_status(monitor)).toBe("online");
    expect(Math.abs(latest_metric(monitor, "refresh_age_hours")! - 1.0)).toBeLessThan(0.01);
  });

  it("counts fresh feeds as the total less the stale ones", () => {
    const monitor = plugin();
    respond(monitor, [feed("A", 1.0), feed("B", 2.0), feed("C", 60.0), feed("D", 200.0)]);
    expect(latest_metric(monitor, "feeds_total")).toBe(4);
    expect(latest_metric(monitor, "feeds_stale")).toBe(2);
    expect(latest_metric(monitor, "feeds_fresh")).toBe(2);
  });

  it("fails an auth failure", () => {
    const monitor = plugin();
    respond(monitor, null, 1.0, 0);
    expect(latest_status(monitor)).toBe("failed");
  });

  it("calls a transport error unavailable", () => {
    const monitor = plugin();
    run_requests(monitor, () => http_result(null, "", { error: "connection refused" }));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a non-JSON response unavailable", () => {
    const monitor = plugin();
    run_requests(monitor, () => http_result(200, "<html>"));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a missing username unavailable", () => {
    const config = { ...base_config };
    delete config.username;
    const monitor = make_plugin(Freshrss, config);
    run_requests(monitor, () => http_result(200, "{}"));
    expect(latest_status(monitor)).toBe("unavailable");
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(plugin().plan_action("anything")).toBeNull();
  });
});

describe("page", () => {
  it("draws fresh and stale feeds as one share", () => {
    const spec = plugin().UI_SPEC;
    const card = spec.cards!.share_card;
    expect(card.kind).toBe("share");
    expect(card.parts!.map((part) => [part.metric, part.color])).toEqual([["feeds_fresh", "online"], ["feeds_stale", "warning"]]);
    expect(spec.layout!.flat()).toContain("share_card");
  });

  it("keeps the existing cards and chart", () => {
    const spec = plugin().UI_SPEC;
    for (const name of ["refresh_card", "feeds_card", "stale_card"]) expect(spec.cards).toHaveProperty(name);
    expect(spec.cards!.stale_card.color).toBe("nonzero_warning");
    expect(spec.chart!.metric).toBe("refresh_age_hours");
  });
});

describe("optional limits", () => {
  it("never fails with a feed warning only", () => {
    const monitor = plugin({ feed_stale_threshold: null });
    respond(monitor, [feed("A", 1.0), feed("B", 500.0)]);
    expect(latest_status(monitor)).toBe("warning");
  });

  it("never warns with a feed failure only", () => {
    const monitor = plugin({ feed_stale_warning: null });
    respond(monitor, [feed("A", 1.0), feed("B", 60.0)]);
    expect(latest_status(monitor)).toBe("online");
    respond(monitor, [feed("A", 1.0), feed("B", 200.0)]);
    expect(latest_status(monitor)).toBe("failed");
  });

  it("never warns with a null refresh warning", () => {
    const monitor = plugin({ refresh_stale_warning: null });
    respond(monitor, [feed("A", 10.0)], 10.0);
    expect(latest_status(monitor)).toBe("online");
    expect((monitor.UI_SPEC.cards!.refresh_card.color as ColorRule)(10.0)).toBe("online");
  });
});
