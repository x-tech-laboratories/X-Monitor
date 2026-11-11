import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { backup_naming } from "@x-tech-laboratories/x-libs/backups";
import { json_backup_schedule } from "@x-tech-laboratories/x-libs/server/backup_routes";
import { sqlite_backups } from "@x-tech-laboratories/x-libs/server/sqlite_backups";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { CHANGES } from "../../src/core/state/changes.ts";
import { CronSchedule } from "../../src/core/coordination/schedule.ts";
import type { XMonitorApp } from "../../src/server/app.ts";
import { NotificationEngine } from "../../src/server/notifications/index.ts";
import { resolve_spec } from "../../src/server/spec.ts";
import { FORMATTERS } from "../../src/shared/ui_registry.ts";
import { CONTROL_TOKEN, READ_TOKEN, bearer, fake_engine, fake_monitor, serve, type FakeEngine } from "./fake_server.ts";

let server: XMonitorApp | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
});

const open = (engine: FakeEngine, options: Parameters<typeof serve>[1] = {}) => serve(engine, { auth_settings: {}, ...options });

// ── The shell and the overview ───────────────────────────────────────────────

describe("the dashboard", () => {
  it("shows the tree with statuses, keyed by path, and the kept sidebar settings", async () => {
    const db = new DatabaseManager();
    db.insert_status("nas", "failed");
    db.set_setting("tree_expanded", "[\"host\"]");
    db.set_setting("drawer_width", "300");
    const nas = fake_monitor("nas");
    const host = fake_monitor("host", { name: "Host", children: [nas], restates_children: true });
    const storage = fake_monitor("storage", { name: "Storage", children: [nas], restates_children: true, links: { nas: "On host" } });
    server = await open(fake_engine([host, storage], db));
    const body = (await server.app.inject({ url: "/api/dashboard" })).json();
    expect(body.tree).toEqual([
      { id: "host", monitor: "host", label: "Host", status: "unavailable", children: [{ id: "host/nas", monitor: "nas", label: "nas", status: "failed" }] },
      { id: "storage", monitor: "storage", label: "Storage", status: "unavailable", children: [{ id: "storage/nas", monitor: "nas", label: "On host", status: "failed" }] },
    ]);
    expect([body.drawer_width, body.tree_expanded, body.tree_accordion, body.notifications_enabled]).toEqual([300, ["host"], false, false]);
  });

  it("keeps only the page's own settings", async () => {
    const engine = fake_engine([]);
    server = await open(engine);
    expect((await server.app.inject({ method: "PUT", url: "/api/ui-settings/tree_accordion", payload: { value: "1" } })).statusCode).toBe(200);
    expect(engine.db.get_setting("tree_accordion")).toBe("1");
    expect((await server.app.inject({ method: "PUT", url: "/api/ui-settings/group_expanded_web", payload: { value: "{}" } })).statusCode).toBe(200);
    expect((await server.app.inject({ method: "PUT", url: "/api/ui-settings/notifications.muted:web", payload: { value: "1" } })).statusCode).toBe(400);
  });
});

describe("the overview", () => {
  it("tallies the monitors and builds the fleet sections", async () => {
    const db = new DatabaseManager();
    db.insert_status("web", "online");
    db.insert_status("backup", "failed");
    for (const value of [1, 0, 1]) db.insert_metric("host.lan", "web", "probe_ok", value);
    db.insert_metric("host.lan", "deploy", "generation", 42);
    db.insert_metric("host.lan", "deploy", "up_to_date", 0);
    db.insert_metric("host.lan", "scan", "vulnerable", 2);
    db.insert_metric("host.lan", "scan", "open_ports", 5);
    const leaves = [
      fake_monitor("web", { config: { type: "http" } }),
      fake_monitor("backup", { name: "Repo", config: { type: "borg" }, max_age: 3600 }),
      fake_monitor("deploy", { name: "Deploy", config: { type: "nixos_upgrade" } }),
      fake_monitor("scan", { name: "Scan", config: { type: "vuln_scan" } }),
    ];
    const host = fake_monitor("host", { name: "Host", children: leaves, restates_children: true, config: { type: "group" } });
    server = await open(fake_engine([host], db));
    const body = (await server.app.inject({ url: "/api/overview" })).json();
    expect(body.monitors.map((row: { id: string }) => row.id)).toEqual(["web", "backup", "deploy", "scan"]);
    expect(body.status_counts).toMatchObject({ online: 1, failed: 1, unavailable: 2 });
    expect(body.type_tiles[0]).toMatchObject({ value: 1 });
    const fleet = body.fleet;
    expect(fleet.sections).toEqual(["hosts", "strips", "backups", "deploys", "findings"]);
    expect(fleet.hosts[0]).toMatchObject({ id: "host", state: "failed", caption: "4 monitors · 1 failed" });
    expect(fleet.strips[0]).toMatchObject({ id: "web", host: "Host", metric: "probe_ok", history: [1, 0, 1] });
    expect(fleet.backups[0]).toMatchObject({ label: "Host · Repo", value_text: "No archive yet", percent: 0, state: "failed" });
    expect(fleet.deploys[0]).toMatchObject({ caption: "gen 42 · drift" });
    expect(fleet.findings[0]).toMatchObject({ vulnerable: 2, text: "2 · 0 · 0 · 5 open ports" });
    expect(body.recent_metrics.length).toBeGreaterThan(0);
  });
});

describe("the schedules", () => {
  it("lists scheduled actions soonest first with their last run, and triggered ones last", async () => {
    const db = new DatabaseManager();
    const entry = { action: "run_backup", cron: CronSchedule.parse("0 3 * * *"), args: {}, result_key: (id: string) => `schedule-result:${id}:run_backup:0 3 * * *` };
    db.set_setting(entry.result_key("nas"), JSON.stringify({ at: 1790000000, ok: false, message: "repository locked" }));
    const trigger = { action: "restart", args: { unit: "x" }, describe: () => "when status is failed", result_key: () => "trigger-result:none" };
    const nas = fake_monitor("nas", { name: "Nas", scheduled_actions: [entry], all_actions: () => [{ action_id: "run_backup", name: "Back up now" }] });
    const web = fake_monitor("web", { name: "Web", triggered_actions: [trigger] });
    server = await open(fake_engine([fake_monitor("host", { name: "Host", children: [nas] }), web], db));
    const rows = (await server.app.inject({ url: "/api/schedules" })).json();
    expect(rows[0]).toMatchObject({ id: "nas:0", monitor: "Host › Nas", action: "Back up now", cron: "0 3 * * *", outcome: "Failed", message: "repository locked" });
    expect(rows[0].next).toMatch(/^\w{3} \d{2} \w{3} 03:00$/);
    expect(rows[1]).toMatchObject({ id: "web:trigger:0", action: "Restart (unit: x)", cron: "When status is failed", next: "on that event", last: "not yet", outcome: "" });
  });
});

// ── A monitor's page ─────────────────────────────────────────────────────────

describe("a monitor's page", () => {
  const inline_format = (value: number | null) => `${value} units`;
  const spec = {
    cards: {
      load: { title: "Load", metric: "load", format: FORMATTERS.decimal1, color: { warning: 1, threshold: 2 } },
      odd: { title: "Odd", metric: "load", format: inline_format },
      items: { title: "Disks", repeat: { source: "snapshot", item_value: "used", item_color_by: (item: Record<string, unknown>) => (Number(item.used) > 50 ? "failed" : "online") } },
    },
    charts: { load: { title: "Load", metric: "load" } },
    tables: { services: { rows_attr: "service_rows", columns: [{ name: "name", field: "name" }] } },
    buttons: { header: [{ id: "reset", label: "Reset", visible_if: (plugin: { allow_reset: boolean }) => plugin.allow_reset }] },
    events: true,
  };

  it("resolves the spec's functions into names and server rules", () => {
    const { spec: resolved, rules } = resolve_spec(spec);
    const cards = (resolved as { cards: Record<string, Record<string, unknown>> }).cards;
    expect(cards.load!.format).toBe("decimal1");
    expect(cards.odd!.format).toEqual({ server_rule: "rule0" });
    expect(rules.map((rule) => rule.applies_to)).toEqual(["value", "item", "plugin"]);
  });

  it("carries the actions, notification state, resolved spec and every reading the widgets show", async () => {
    const db = new DatabaseManager();
    db.insert_metric("host.lan", "web", "load", 1.5);
    db.insert_status("web", "warning");
    db.set_snapshot("web", [{ name: "/", used: 80 }, { name: "/home", used: 10 }]);
    db.write_event("host.lan", "web", "web", "restarted", "INFO");
    const plugin = fake_monitor("web", { UI_SPEC: spec, allow_reset: true, service_rows: () => [{ name: "nginx" }] });
    const notifications = new NotificationEngine(db, {}, null);
    notifications.channels = new Map([["desk", { id: "desk", send: async () => {} }]]);
    notifications.start([plugin]);
    server = await open(fake_engine([plugin], db), { notifications: () => notifications });
    const page = (await server.app.inject({ url: "/api/monitors/web/page" })).json();
    expect(page).toMatchObject({ id: "web", status: "warning", jobs: null, notifications: { maintenance: null, muted_by: null, muted: false } });
    expect(page.actions[0]).toMatchObject({ action_id: "restart", state: "normal" });
    expect(page.data.metrics).toEqual({ load: 1.5 });
    expect(page.data.histories.load.map((point: { value: number }) => point.value)).toEqual([1.5]);
    expect(page.data.rules).toEqual({ rule0: "1.5 units", rule2: true });
    expect(page.data.snapshot.map((item: { __rules: Record<string, unknown> }) => item.__rules.rule1)).toEqual(["failed", "online"]);
    expect(page.data.attributes.service_rows).toMatchObject([{ name: "nginx" }]);
    expect(page.data.events[0].message).toBe("restarted");

    expect((await server.app.inject({ method: "POST", url: "/api/monitors/web/mute", payload: { muted: true } })).json()).toEqual({ muted: true, muted_by: "web" });
    expect((await server.app.inject({ url: "/api/monitors/web/page" })).json().notifications.muted).toBe(true);
    expect((await server.app.inject({ url: "/api/notifications" })).json()).toEqual({ channels: [{ id: "desk", type: "" }], windows: [], muted: [{ id: "web", name: "web" }] });
    notifications.stop();
  });

  it("runs any action with its arguments, auditing only callers other than the page", async () => {
    const plugin = fake_monitor("web");
    const engine = fake_engine([plugin]);
    server = await open(engine);
    const ran = await server.app.inject({ method: "POST", url: "/api/monitors/web/run", headers: { "x-client-id": "page-1" }, payload: { action_id: "save", args: { content: "x" } } });
    expect(ran.json()).toEqual({ success: true, content: "restarted", job_id: null });
    expect(plugin.actions).toEqual([["save", { content: "x" }]]);
    expect(engine.applied).toEqual([]);
  });

  it("is 404 for an unknown monitor", async () => {
    server = await open(fake_engine([]));
    expect((await server.app.inject({ url: "/api/monitors/nope/page" })).statusCode).toBe(404);
  });
});

describe("the logs search", () => {
  it("searches every chosen journal at once, a failing one saying why", async () => {
    const engine = fake_engine([fake_monitor("a", { config: { type: "journal" }, max_entries: 200 }), fake_monitor("b", { config: { type: "journal" } })]);
    engine.dispatch_answer = (plugin_id) => (plugin_id === "a" ? [true, { entries: JSON.stringify([{ epoch: 1, message: "hi" }]) }] : [false, { content: "journalctl failed" }]);
    server = await open(engine);
    expect((await server.app.inject({ url: "/api/logs/monitors" })).json()).toEqual([
      { id: "a", name: "a", target: "host.lan", max_entries: 200 }, { id: "b", name: "b", target: "host.lan", max_entries: 500 },
    ]);
    const found = (await server.app.inject({ method: "POST", url: "/api/call/search_logs", payload: { monitor_ids: ["a", "b"], since: "6h", priority: 4 } })).json();
    expect(found).toEqual([
      { monitor_id: "a", host: "host.lan", error: null, entries: [{ epoch: 1, message: "hi" }] },
      { monitor_id: "b", host: "host.lan", error: "journalctl failed", entries: [] },
    ]);
    expect(engine.dispatched[0]).toEqual(["a", "query_logs", { since: "6h", priority: 4, unit: "", text: "", limit: 500 }]);
  });
});

// ── Calls by name, OpenAPI and MCP ───────────────────────────────────────────

describe("calls by name", () => {
  it("take their arguments in order or by name", async () => {
    const plugin = fake_monitor("web");
    server = await open(fake_engine([plugin]));
    expect((await server.app.inject({ method: "POST", url: "/api/call/get_monitor", payload: ["web"] })).json().id).toBe("web");
    expect((await server.app.inject({ method: "POST", url: "/api/call/get_monitor", payload: { monitor_id: "web" } })).json().id).toBe("web");
    expect((await server.app.inject({ method: "POST", url: "/api/call/poll_monitor", payload: ["web"] })).json()).toEqual({ polled: true });
    expect((await server.app.inject({ method: "POST", url: "/api/call/push", payload: [] })).statusCode).toBe(404);
  });

  it("are described in the OpenAPI document, reads marked as such", async () => {
    server = await serve(fake_engine([]));
    const document = (await server.app.inject({ url: "/api/openapi.json", headers: bearer(READ_TOKEN) })).json();
    expect(Object.keys(document.paths)).toContain("/api/call/get_summary");
    expect(Object.keys(document.paths)).toContain("/api/call/run_action");
  });

  it("are MCP tools, which a read token may list and call when they only read", async () => {
    server = await serve(fake_engine([fake_monitor("web")]));
    const rpc = async (method: string, params: unknown, token: string) => {
      const reply = await server!.app.inject({
        method: "POST", url: "/api/mcp", payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        headers: { ...bearer(token), "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      });
      const data = reply.headers["content-type"]?.includes("text/event-stream") ? /^data: (.+)$/m.exec(reply.body)![1]! : reply.body;
      return JSON.parse(data) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
    };
    const tools = (await rpc("tools/list", {}, READ_TOKEN)).result!.tools!.map((tool) => tool.name);
    expect(tools).toContain("get_summary");
    const summary = await rpc("tools/call", { name: "get_summary", arguments: {} }, READ_TOKEN);
    expect(JSON.parse(summary.result!.content![0]!.text).total).toBe(1);
    const poll = await rpc("tools/call", { name: "poll_monitor", arguments: { monitor_id: "web" } }, CONTROL_TOKEN);
    expect(JSON.parse(poll.result!.content![0]!.text)).toEqual({ polled: true });
    expect((await rpc("tools/call", { name: "poll_monitor", arguments: { monitor_id: "web" } }, READ_TOKEN)).result!.isError).toBe(true);
  });
});

// ── Changes and backups ──────────────────────────────────────────────────────

describe("the change stream", () => {
  it("tells the page which kinds and monitors changed", async () => {
    server = await open(fake_engine([]));
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/changes`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n\n")) text += decoder.decode((await reader.read()).value);
    CHANGES.publish("status", "web");
    while (!text.includes("\"web\"")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain("{\"kinds\":[\"status\"],\"monitors\":[\"web\"]}");
    controller.abort();
  });
});

describe("the state database's backups", () => {
  it("are listed and taken at their own path, beside the backup monitors' /api/backups", async () => {
    const folder = mkdtempSync(join(tmpdir(), "state-"));
    const database = new DatabaseSync(join(folder, "x-monitor.db"));
    const backups = sqlite_backups({ folder: () => join(folder, "backups"), naming: backup_naming("x-monitor", ".sqlite"), database: () => database, database_path: () => join(folder, "x-monitor.db") });
    server = await serve(fake_engine([]), { auth_settings: {}, database, backups: { backups, schedule: json_backup_schedule(join(folder, "schedule.json")) } });
    expect((await server.app.inject({ method: "POST", url: "/api/state-backups" })).statusCode).toBe(200);
    expect((await server.app.inject({ url: "/api/state-backups" })).json()).toHaveLength(1);
    expect((await server.app.inject({ url: "/api/backups" })).json()).toMatchObject({ total: 0 });
  });
});
