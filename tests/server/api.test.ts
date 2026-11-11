import { afterEach, describe, expect, it } from "vitest";

import type { XMonitorApp } from "../../src/server/app.ts";
import { NotificationEngine } from "../../src/server/notifications/index.ts";
import { DatabaseManager } from "../../src/core/database/database.ts";
import {
  CONTROL_TOKEN, MONITOR_TOKEN, PUSH_ALL, PUSH_NIGHTLY, READ_TOKEN, audit_messages, bearer, fake_engine, fake_monitor, fake_push, serve, sign_in,
} from "./fake_server.ts";

let server: XMonitorApp | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
});

// ── Push ─────────────────────────────────────────────────────────────────────

describe("push with the monitor's own token", () => {
  it("records the heartbeat, refuses a wrong token and a named token in the path", async () => {
    const plugin = fake_push("nightly");
    server = await serve(fake_engine([plugin]));
    const pushed = await server.app.inject({ url: `/api/push/nightly/${MONITOR_TOKEN}?status=down&msg=full` });
    expect(pushed.json()).toEqual({ success: true });
    expect(plugin.pushes).toEqual([{ status: "down", msg: "full", value: null, source: null }]);
    expect((await server.app.inject({ url: "/api/push/nightly/nope" })).statusCode).toBe(401);
    expect((await server.app.inject({ url: `/api/push/nightly/${PUSH_ALL}` })).statusCode).toBe(401);
  });
});

describe("push with a bearer token", () => {
  it("records a heartbeat named after the token", async () => {
    const plugin = fake_push("nightly", null);
    server = await serve(fake_engine([plugin]));
    const pushed = await server.app.inject({ method: "POST", url: "/api/push/nightly?value=3", headers: bearer(PUSH_ALL) });
    expect(pushed.json()).toEqual({ success: true });
    expect(plugin.pushes[0]).toMatchObject({ source: "token 'all-pushes'", value: 3 });
  });

  it("lets a limited token reach only its own monitors", async () => {
    const nightly = fake_push("nightly");
    const weekly = fake_push("weekly");
    server = await serve(fake_engine([nightly, weekly]));
    expect((await server.app.inject({ url: "/api/push/nightly", headers: bearer(PUSH_NIGHTLY) })).statusCode).toBe(200);
    expect(nightly.pushes[0]!.source).toBe("token 'nightly-job'");
    expect((await server.app.inject({ url: "/api/push/weekly", headers: bearer(PUSH_NIGHTLY) })).statusCode).toBe(403);
    expect(weekly.pushes).toEqual([]);
  });

  it("refuses a control token, no token, an unknown token, a bad status and a monitor that is not a push monitor", async () => {
    server = await serve(fake_engine([fake_push("nightly"), fake_monitor("web")]));
    expect((await server.app.inject({ url: "/api/push/nightly", headers: bearer(CONTROL_TOKEN) })).statusCode).toBe(403);
    expect((await server.app.inject({ url: "/api/push/nightly" })).statusCode).toBe(401);
    expect((await server.app.inject({ url: "/api/push/nightly", headers: bearer("vgl_unknown-000000000") })).statusCode).toBe(401);
    expect((await server.app.inject({ url: "/api/push/nightly?status=sideways", headers: bearer(PUSH_ALL) })).statusCode).toBe(400);
    expect((await server.app.inject({ url: "/api/push/web", headers: bearer(PUSH_ALL) })).statusCode).toBe(404);
  });

  it("works with sign-in off", async () => {
    server = await serve(fake_engine([fake_push("nightly")]), { auth_settings: { tokens: [{ name: "all", scope: "push", token_hash: (await import("../../src/server/tokens.ts")).hash_token(PUSH_ALL) }] } });
    expect((await server.app.inject({ url: "/api/push/nightly", headers: bearer(PUSH_ALL) })).statusCode).toBe(200);
  });
});

// ── Control ──────────────────────────────────────────────────────────────────

describe("control routes", () => {
  it("poll and run an action, auditing the token", async () => {
    const plugin = fake_monitor("web");
    const engine = fake_engine([plugin]);
    server = await serve(engine);
    expect((await server.app.inject({ method: "POST", url: "/api/monitors/web/poll", headers: bearer(CONTROL_TOKEN) })).json()).toEqual({ polled: true });
    expect(plugin.polls).toBe(1);
    expect((await server.app.inject({ method: "POST", url: "/api/monitors/web/actions/restart", headers: bearer(CONTROL_TOKEN) })).json()).toEqual({ success: true, content: "restarted" });
    expect(plugin.actions).toEqual([["restart", {}]]);
    expect(audit_messages(engine)).toEqual(["Poll requested through the API by token 'ops'", "Action \"restart\" requested through the API by token 'ops'"]);
  });

  it("refuses an undeclared action and an unknown monitor", async () => {
    const plugin = fake_monitor("web");
    const engine = fake_engine([plugin]);
    server = await serve(engine);
    expect((await server.app.inject({ method: "POST", url: "/api/monitors/web/actions/rm-rf", headers: bearer(CONTROL_TOKEN) })).statusCode).toBe(404);
    expect(plugin.actions).toEqual([]);
    expect(engine.applied).toEqual([]);
    expect((await server.app.inject({ method: "POST", url: "/api/monitors/nope/poll", headers: bearer(CONTROL_TOKEN) })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "POST", url: "/api/monitors/nope/actions/restart", headers: bearer(CONTROL_TOKEN) })).statusCode).toBe(404);
  });

  it("answers a failing action with 500 and the error", async () => {
    server = await serve(fake_engine([fake_monitor("web", { fail: true })]));
    const response = await server.app.inject({ method: "POST", url: "/api/monitors/web/actions/restart", headers: bearer(CONTROL_TOKEN) });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ success: false, error: "ssh went away" });
  });

  it("audits a signed-in user by name, and no one with sign-in off", async () => {
    const engine = fake_engine([fake_monitor("web")]);
    server = await serve(engine);
    const headers = await sign_in(server);
    expect((await server.app.inject({ method: "POST", url: "/api/monitors/web/poll", headers })).statusCode).toBe(200);
    expect(audit_messages(engine)).toEqual(["Poll requested through the API by admin"]);
    await server.app.close();

    const open_engine = fake_engine([fake_monitor("web")]);
    server = await serve(open_engine, { auth_settings: {} });
    expect((await server.app.inject({ method: "POST", url: "/api/monitors/web/poll" })).statusCode).toBe(200);
    expect(audit_messages(open_engine)).toEqual(["Poll requested through the API"]);
  });

  it("lists a monitor's header actions", async () => {
    server = await serve(fake_engine([fake_monitor("web")]));
    expect((await server.app.inject({ url: "/api/monitors/web", headers: bearer(CONTROL_TOKEN) })).json().actions).toEqual(["restart"]);
  });

  it.each(["/api/monitors/web/poll", "/api/monitors/web/actions/restart"])("needs credentials for %s", async (path) => {
    server = await serve(fake_engine([fake_monitor("web")]));
    expect((await server.app.inject({ method: "POST", url: path })).statusCode).toBe(401);
  });
});

// ── Status ───────────────────────────────────────────────────────────────────

describe("summary", () => {
  const counts = async (plugins: ReturnType<typeof fake_monitor>[], statuses: Record<string, string>) => {
    const db = new DatabaseManager();
    for (const [id, status] of Object.entries(statuses)) db.store.statuses.set(id, { plugin_id: id, state: status, timestamp: new Date() });
    server = await serve(fake_engine(plugins, db), { auth_settings: {} });
    const body = (await server.app.inject({ url: "/api/summary" })).json();
    await server.app.close();
    server = null;
    return body;
  };

  it("counts each status, an unknown one included, and a monitor with none yet as unavailable", async () => {
    const body = await counts(["a", "b", "c", "d"].map((id) => fake_monitor(id)), { a: "online", b: "warning", c: "failed", d: "offline" });
    expect([body.total, body.online, body.warning, body.failed, body.offline]).toEqual([4, 1, 1, 1, 1]);
    expect((await counts([fake_monitor("a")], {})).unavailable).toBe(1);
    expect(await counts([fake_monitor("a")], { a: "weird" })).toMatchObject({ total: 1, weird: 1 });
  });

  it("leaves out plain groups but counts a monitor with children of its own", async () => {
    const group = fake_monitor("group", { children: [fake_monitor("leaf")], restates_children: true });
    expect((await counts([group], { group: "online", leaf: "online" })).total).toBe(1);
    const parent = fake_monitor("parent", { children: [fake_monitor("leaf")] });
    expect(await counts([parent], { parent: "failed", leaf: "online" })).toMatchObject({ total: 2, failed: 1 });
  });

  it("counts everything but online and info as unhealthy", async () => {
    const body = await counts(["a", "b", "c"].map((id) => fake_monitor(id)), { a: "online", b: "info", c: "warning" });
    expect([body.info, body.unhealthy]).toEqual([1, 1]);
  });
});

describe("backup monitors", () => {
  it("lists only backup monitors, stalest first", async () => {
    const backup = (id: string, age: number | null) => fake_monitor(id, { config: { type: "borg" }, backup_summary: () => ({ repo: "/r", newest_archive_age: age, fresh: age !== null && age < 100 }) });
    const db = new DatabaseManager();
    db.insert_status("fresh", "online");
    db.insert_status("old", "failed");
    server = await serve(fake_engine([backup("fresh", 10), fake_monitor("cpu"), backup("never", null), backup("old", 500)], db), { auth_settings: {} });
    const body = (await server.app.inject({ url: "/api/backups" })).json();
    expect(body.repositories.map((row: { id: string }) => row.id)).toEqual(["never", "old", "fresh"]);
    expect([body.total, body.healthy, body.unhealthy]).toEqual([3, 1, 2]);
  });
});

describe("events and metrics", () => {
  it("filter events and clamp the limit", async () => {
    const db = new DatabaseManager();
    db.insert_event("ERROR", "boom", "host1");
    db.insert_event("INFO", "unique-token-xyz", "host1");
    server = await serve(fake_engine([], db), { auth_settings: {} });
    const errors = (await server.app.inject({ url: "/api/events?level=ERROR" })).json();
    expect(errors.every((event: { level: string }) => event.level === "ERROR")).toBe(true);
    expect((await server.app.inject({ url: "/api/events?search=unique-token" })).json()).toHaveLength(1);
    expect((await server.app.inject({ url: "/api/events?limit=0" })).json()).toHaveLength(1);
  });

  it("serves the Prometheus page to a read token and refuses it without one", async () => {
    const db = new DatabaseManager();
    db.insert_status("cpu-mon", "online");
    server = await serve(fake_engine([], db));
    const page = await server.app.inject({ url: "/metrics", headers: bearer(READ_TOKEN) });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("version=0.0.4");
    expect(page.body).toContain("x_monitor_up{monitor=\"cpu-mon\",state=\"online\"} 1");
    expect((await server.app.inject({ url: "/metrics" })).statusCode).toBe(401);
  });
});

// ── Notifications, log levels and reloads ────────────────────────────────────

describe("test notifications", () => {
  const with_channel = async (send_test: (channel_id: string) => Promise<void>) => {
    const notifications = new NotificationEngine(new DatabaseManager(), {}, null);
    notifications.channels = new Map([["desk", { id: "desk", send: async () => {} }]]);
    notifications.send_test = send_test;
    server = await serve(fake_engine(), { auth_settings: {}, notifications: () => notifications });
    return server;
  };

  it("send through the named channel", async () => {
    const sent: string[] = [];
    const app = await with_channel(async (channel_id) => void sent.push(channel_id));
    const response = await app.app.inject({ method: "POST", url: "/api/notifications/desk/test" });
    expect([response.statusCode, response.json(), sent]).toEqual([200, { sent: true }, ["desk"]]);
  });

  it("report a failed delivery, and refuse an unknown channel", async () => {
    const app = await with_channel(async () => {
      throw new Error("agent is not connected");
    });
    const response = await app.app.inject({ method: "POST", url: "/api/notifications/desk/test" });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ sent: false, error: "agent is not connected" });
    expect((await app.app.inject({ method: "POST", url: "/api/notifications/nope/test" })).statusCode).toBe(404);
  });
});

describe("log levels", () => {
  const ssh = "x_monitor.core.connectors.ssh_connector";

  it("reads, sets, resets and refuses levels", async () => {
    server = await serve(fake_engine(), { auth_settings: {} });
    const read = (await server.app.inject({ url: "/api/log-levels" })).json();
    expect(read.levels.root).toBe("INFO");
    expect(read.loggers).toContain(ssh);
    const set = await server.app.inject({ method: "POST", url: "/api/log-levels", payload: { logger: ssh, level: "DEBUG" } });
    expect(set.json().levels[ssh]).toBe("DEBUG");
    expect((await server.app.inject({ method: "POST", url: "/api/log-levels", payload: { level: "WARNING" } })).json().levels.root).toBe("WARNING");
    expect((await server.app.inject({ method: "POST", url: "/api/log-levels", payload: { logger: ssh, level: null } })).json().levels).not.toHaveProperty(ssh);
    const bad = await server.app.inject({ method: "POST", url: "/api/log-levels", payload: { logger: ssh, level: "LOUD" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("unknown log level");
    expect((await server.app.inject({ method: "POST", url: "/api/log-levels", headers: { "content-type": "application/json" }, payload: "nope" })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "POST", url: "/api/log-levels", payload: ["DEBUG"] })).statusCode).toBe(400);
  });
});

describe("config reload", () => {
  it("answers 200 when it applied and 422 when it did not", async () => {
    const engine = fake_engine();
    server = await serve(engine, { auth_settings: {} });
    expect((await server.app.inject({ method: "POST", url: "/api/config/reload" })).statusCode).toBe(200);
    engine.reload_answer = { ok: false, summary: () => "refused", as_dict: () => ({ ok: false, summary: "refused" }) };
    const refused = await server.app.inject({ method: "POST", url: "/api/config/reload" });
    expect([refused.statusCode, refused.json()]).toEqual([422, { ok: false, summary: "refused" }]);
  });
});
