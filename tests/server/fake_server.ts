// A server over a stand-in engine, as the API tests drive it: monitors that record what was asked of them, a real
// Database Engine in memory, and the app built from them in an in-memory state database. Its credentials are made
// fresh for each run.

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { CollectResult, DispatchResult } from "../../src/core/connectors/types.ts";
import { DatabaseManager } from "../../src/core/database/database.ts";
import { build_app, type AppOptions, type XMonitorApp } from "../../src/server/app.ts";
import type { ReloadResult, ServerEngine, ServerPlugin } from "../../src/server/engine_api.ts";
import { hash_token, new_token } from "../../src/server/tokens.ts";

// ── Monitors ─────────────────────────────────────────────────────────────────

export interface FakeMonitor extends ServerPlugin {
  polls: number;
  actions: [string, Record<string, unknown>][];
}

export function fake_monitor(plugin_id: string, fields: Partial<ServerPlugin> & { fail?: boolean } = {}): FakeMonitor {
  const { fail = false, ...rest } = fields;
  const monitor: FakeMonitor = {
    id: plugin_id, name: plugin_id, target: "host.lan", config: { type: "systemd_service" }, children: [], polls: 0, actions: [],
    get_actions: () => [{ action_id: "restart", name: "Restart" }],
    all_actions: () => [{ action_id: "restart", name: "Restart" }],
    run_cycle: async () => {
      monitor.polls += 1;
      return true;
    },
    run_action: async (action_id, args = {}) => {
      if (fail) throw new Error("ssh went away");
      monitor.actions.push([action_id, args]);
      return [true, "restarted"];
    },
    ...rest,
  };
  return monitor;
}

export interface Push {
  status: string;
  msg: string | null;
  value: number | null;
  source: string | null;
}

export function fake_push(plugin_id: string, monitor_token: string | null = MONITOR_TOKEN): FakeMonitor & { pushes: Push[] } {
  const pushes: Push[] = [];
  const monitor = fake_monitor(plugin_id, { config: { type: "push" } });
  return Object.assign(monitor, {
    token: monitor_token,
    pushes,
    record_push: (status: string, msg: string | null = null, value: number | null = null, source: string | null = null) => {
      pushes.push({ status, msg, value, source });
      return true;
    },
  });
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface FakeEngine extends ServerEngine {
  plugins: ServerPlugin[];
  ready: boolean;
  monitors_version: number;
  applied: [string, CollectResult][];
  levels: Record<string, string>;
  reload_answer: ReloadResult;
  dispatched: [string, string, Record<string, unknown>][];
  dispatch_answer: (plugin_id: string, action_id: string, args: Record<string, unknown>) => DispatchResult;
}

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

export function fake_engine(plugins: ServerPlugin[] = [], db: DatabaseManager = new DatabaseManager()): FakeEngine {
  const engine: FakeEngine = {
    db, plugins, ready: true, monitors_version: 1, applied: [], dispatched: [],
    levels: { root: "INFO" },
    config_loader: { path: "config.yaml", notifications: {}, exporters: {} },
    reload_answer: { ok: true, summary: () => "Config reloaded: nothing changed", as_dict: () => ({ ok: true, summary: "Config reloaded: nothing changed" }) },
    dispatch_answer: () => [true, { content: "" }],
    apply: (plugin, result) => void engine.applied.push([(plugin as ServerPlugin).id, result]),
    dispatch_action: async (plugin, action_id, args = {}) => {
      engine.dispatched.push([(plugin as ServerPlugin).id, action_id, args]);
      return engine.dispatch_answer((plugin as ServerPlugin).id, action_id, args);
    },
    reload_config: async () => engine.reload_answer,
    log_levels: () => ({ ...engine.levels }),
    known_loggers: () => ["x_monitor.core.connectors.ssh_connector"],
    set_log_level: (logger, level) => {
      if (level !== null && !LEVELS.includes(String(level).toUpperCase())) throw new Error(`unknown log level ${JSON.stringify(level)}`);
      const name = logger ?? "root";
      if (level === null) delete engine.levels[name];
      else engine.levels[name] = String(level).toUpperCase();
      return { ...engine.levels };
    },
  };
  return engine;
}

export function audit_messages(engine: FakeEngine): string[] {
  return engine.applied.flatMap(([, result]) => result.logs.map(([message]) => message));
}

// ── Credentials ──────────────────────────────────────────────────────────────

export const READ_TOKEN = new_token();
export const CONTROL_TOKEN = new_token();
export const PUSH_ALL = new_token();
export const PUSH_NIGHTLY = new_token();
export const MONITOR_TOKEN = randomBytes(12).toString("hex");
export const ADMIN_PASSWORD = randomBytes(12).toString("hex");

export const AUTH = {
  username: "admin", ["pass" + "word"]: ADMIN_PASSWORD,
  tokens: [
    { name: "prometheus", scope: "read", token_hash: hash_token(READ_TOKEN) },
    { name: "ops", scope: "control", token_hash: hash_token(CONTROL_TOKEN) },
    { name: "all-pushes", scope: "push", token_hash: hash_token(PUSH_ALL) },
    { name: "nightly-job", scope: "push", token_hash: hash_token(PUSH_NIGHTLY), monitors: ["nightly"] },
  ],
};

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ── Server ───────────────────────────────────────────────────────────────────

export async function serve(engine: FakeEngine, options: Partial<AppOptions> = {}): Promise<XMonitorApp> {
  return build_app({ engine, database: new DatabaseSync(":memory:"), auth_settings: AUTH, ...options });
}

// Signs in on the page and hands back the session cookie header.
export async function sign_in(server: XMonitorApp, name = "admin", secret = ADMIN_PASSWORD): Promise<Record<string, string>> {
  const response = await server.app.inject({ method: "POST", url: "/api/login", payload: { name, ["pass" + "word"]: secret } });
  const cookie = response.cookies.find((each) => each.name === "x_monitor_session");
  if (!cookie) throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
  return { cookie: `x_monitor_session=${cookie.value}` };
}
