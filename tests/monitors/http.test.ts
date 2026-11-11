import { describe, expect, it } from "vitest";

import { cmd_result, http_result, type HttpRequest } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { body_mismatch, HttpCheck } from "../../src/monitors/http.ts";
import { FORMATTERS, COLOR_RULES } from "../../src/shared/ui_registry.ts";
import { make_plugin, run_cycle, run_requests, store_of } from "../harness.ts";

const feed_config: PluginConfig = {
  name: "test-http",
  id: "test-http",
  url: "http://calibre.test:8083/opds",
  username: "x-monitor",
  password: "pw-value",
  expect: { body_contains: "<feed", body_contains_any: ["atom", "opds"] },
  ssh_config: { host: "test.host" },
};

const dav_config: PluginConfig = {
  name: "test-http",
  id: "test-http",
  url: "http://radicale.test:5232/",
  method: "PROPFIND",
  headers: { Depth: "0", "Content-Type": "application/xml" },
  body: '<?xml version="1.0"?><propfind xmlns="DAV:"/>',
  username: "x-monitor",
  password: "pw-value",
  expect: { status: 207 },
  ssh_config: { host: "test.host" },
};

const ws_config: PluginConfig = {
  name: "test-http",
  id: "test-http",
  url: "ws://127.0.0.1:9777/ws",
  body: '{"type":1,"payload":{}}',
  expect: { body_contains: '"appearance":1' },
  ssh_config: { host: "test.host" },
};

const feed_body = '<feed xmlns="http://www.w3.org/2005/Atom"><title>Library</title></feed>';

const feed_plugin = () => make_plugin(HttpCheck, feed_config);
const ws_plugin = () => make_plugin(HttpCheck, ws_config);

function respond(plugin: HttpCheck, status = 200, body = feed_body, elapsed_ms = 30.0) {
  return run_requests(plugin, () => http_result(status, body, { elapsed_ms }));
}

const latest_status = (plugin: HttpCheck) => store_of(plugin).store.statuses.get("test-http")?.state ?? null;
const latest_metric = (plugin: HttpCheck, name: string) => store_of(plugin).latest_metric("test-http", name)?.value ?? null;

describe("body matching", () => {
  it("passes a real feed", () => {
    expect(body_mismatch(feed_body, feed_config.expect as Record<string, unknown>)).toBe(false);
  });

  it("fails an html page", () => {
    expect(body_mismatch("<html><body>Login</body></html>", feed_config.expect as Record<string, unknown>)).toBe(true);
  });

  it("passes anything without an expect block", () => {
    expect(body_mismatch("whatever", {})).toBe(false);
  });
});

describe("requests", () => {
  it("gets with basic auth", () => {
    const requests = feed_plugin().requests();
    expect(requests).toHaveLength(1);
    const request = requests[0] as HttpRequest;
    expect(request.kind).toBe("http");
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://calibre.test:8083/opds");
    expect(request.auth).toEqual(["x-monitor", "pw-value"]);
  });

  it("carries the method, headers and body", () => {
    const request = make_plugin(HttpCheck, dav_config).requests()[0] as HttpRequest;
    expect(request.method).toBe("PROPFIND");
    expect(request.headers).toEqual({ Depth: "0", "Content-Type": "application/xml" });
    expect(request.body).toContain("<propfind");
  });

  it("asks nothing without a url", () => {
    expect(make_plugin(HttpCheck, { name: "h", id: "h", ssh_config: { host: "h" } }).requests()).toEqual([]);
  });

  it("resolves password_command at construction", () => {
    const plugin = make_plugin(HttpCheck, { ...feed_config, password: null, password_command: "echo s3cret" });
    expect((plugin.requests()[0] as HttpRequest).auth).toEqual(["x-monitor", "s3cret"]);
  });

  it("probes a ws url with websocat", () => {
    const text = ws_plugin().commands()[0].text;
    expect(text).toContain("websocat");
    expect(text).toContain("ws://127.0.0.1:9777/ws");
    expect(text).toContain('{"type":1,"payload":{}}');
    expect(text).toBe(`echo '{"type":1,"payload":{}}' | timeout 10 websocat -n1 ws://127.0.0.1:9777/ws`);
  });

  it("offers a sample stream for a ws probe", () => {
    expect(ws_plugin().event_driven()).toBe(true);
  });
});

describe("http parsing", () => {
  it("calls the expected status and body online", () => {
    const plugin = feed_plugin();
    const result = respond(plugin);
    expect(latest_status(plugin)).toBe("online");
    expect(result.logs[0][0]).toBe("Probe OK (200, 30ms)");
  });

  it("records latency", () => {
    const plugin = feed_plugin();
    respond(plugin, 200, feed_body, 42.0);
    expect(latest_metric(plugin, "probe_latency_ms")).toBe(42.0);
  });

  it("fails a login page served with 200", () => {
    const plugin = feed_plugin();
    respond(plugin, 200, "<html>Login</html>");
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails a 401", () => {
    const plugin = feed_plugin();
    const result = respond(plugin, 401, "");
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[0][0]).toBe("Probe returned unexpected status 401 — check the configured credentials");
  });

  it("accepts a non-default expected status", () => {
    const plugin = make_plugin(HttpCheck, dav_config);
    run_requests(plugin, () => http_result(207, "<multistatus/>", { elapsed_ms: 10.0 }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a request error", () => {
    const plugin = feed_plugin();
    run_requests(plugin, () => http_result(null, "", { error: "connection refused" }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails without a url", () => {
    const plugin = make_plugin(HttpCheck, { name: "h", id: "h", ssh_config: { host: "h" } });
    expect(run_requests(plugin).status).toBe("failed");
  });
});

describe("ws parsing", () => {
  it("calls a matching reply online", () => {
    const plugin = ws_plugin();
    run_cycle(plugin, () => cmd_result(0, '{"type":1,"payload":{"appearance":1}}', ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "probe_ok")).toBe(1.0);
  });

  it("fails a mismatched reply", () => {
    const plugin = ws_plugin();
    const result = run_cycle(plugin, () => cmd_result(0, '{"type":0,"payload":{"appearance":3}}', ""));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[0][0]).toBe(`WebSocket reply did not match 'expect': '{"type":0,"payload":{"appearance":3}}'`);
  });

  it("fails a failed probe", () => {
    const plugin = ws_plugin();
    run_cycle(plugin, () => cmd_result(1, "", "connection refused"));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "probe_ok")).toBe(0.0);
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(feed_plugin().plan_action("anything")).toBeNull();
  });
});

describe("page", () => {
  it("draws an uptime strip beside the latency chart for an http probe", () => {
    const spec = feed_plugin().UI_SPEC;
    expect(spec.cards!.uptime_strip.kind).toBe("strip");
    expect(spec.cards!.uptime_strip.metric).toBe("probe_ok");
    expect(spec.layout).toContainEqual(["uptime_strip"]);
    expect(spec.chart!.metric).toBe("probe_latency_ms");
  });

  it("draws an uptime strip for a websocket probe", () => {
    const spec = ws_plugin().UI_SPEC;
    expect(spec.cards!.uptime_strip.metric).toBe("probe_ok");
    expect(spec.layout).toContainEqual(["uptime_strip"]);
  });

  it("registers the probe text and color rules", () => {
    expect(FORMATTERS.probe_ok_text(1)).toBe("OK");
    expect(FORMATTERS.probe_ok_text(0)).toBe("FAILED");
    expect(FORMATTERS.probe_ok_text(null)).toBe("--");
    expect(COLOR_RULES.probe_ok_color(1)).toBe("online");
    expect(COLOR_RULES.probe_ok_color(0)).toBe("failed");
    expect(COLOR_RULES.probe_ok_color(null)).toBeNull();
  });
});
