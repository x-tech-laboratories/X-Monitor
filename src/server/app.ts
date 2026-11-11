// The Fastify app: the starting page until the engine has loaded its state, sign-in, the REST routes scripts have
// always used, the page's calls by name with MCP and OpenAPI beside them, the page's change stream, the state
// database's backups, /metrics and the built page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { timingSafeEqual } from "node:crypto";

import { openapi_document, positional_args } from "@x-tech-laboratories/x-libs/api_spec";
import type { ProxySignIn } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { register_backup_routes, type BackupRoutesOptions } from "@x-tech-laboratories/x-libs/server/backup_routes";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { register_mcp_route } from "@x-tech-laboratories/x-libs/server/mcp";
import type { OidcClient } from "@x-tech-laboratories/x-libs/server/oidc";
import type { Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { metrics_content_type } from "@x-tech-laboratories/x-libs/server/prometheus";
import { register_error_replies, register_lenient_json_body, BAD_JSON } from "@x-tech-laboratories/x-libs/server/replies";
import { register_web_folder } from "@x-tech-laboratories/x-libs/server/web_folder";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { is_pushable, type PushablePlugin } from "../core/contracts.ts";
import { CHANGES, type ChangeKind } from "../core/state/changes.ts";
import { api, is_read_only, takes_caller, type PublicMethods } from "./api_spec.ts";
import { acting_client, register_auth, type Auth } from "./auth.ts";
import type { ServerEngine } from "./engine_api.ts";
import { render } from "./exporters/prometheus.ts";
import { find_monitor } from "../core/coordination/monitor_graph.ts";
import { ApiError, create_methods, type Caller, type Methods } from "./methods.ts";
import type { NotificationEngine } from "./notifications/index.ts";
import { covers_monitor, match_token } from "./tokens.ts";
import { register_starting_page } from "./startup.ts";
import { create_logger_for } from "../core/logging.ts";

const log = create_logger_for("x_monitor.core.ui.api");

// ── Options ──────────────────────────────────────────────────────────────────

export interface AppOptions {
  engine: ServerEngine;
  // The state database the accounts live in.
  database: SqlDatabase;
  auth_settings?: Record<string, unknown> | null;
  accounts_file?: Accounts;
  oidc?: OidcClient | null;
  proxy?: ProxySignIn | null;
  // The notification engine now running, which a reload replaces.
  notifications?: () => NotificationEngine | null;
  // The state database's backups; without them none are served.
  backups?: BackupRoutesOptions;
  // The built page; none is served without it.
  web_folder?: string | null;
  version?: string;
  logger?: boolean;
  // Adds routes others own, such as the agent socket, before the page's catch-all.
  extra_routes?: (app: FastifyInstance) => Promise<void> | void;
  // Paths reached without signing in, beside the push routes, such as a route that checks its own credentials.
  open_paths?: string[];
}

export interface XMonitorApp {
  app: FastifyInstance;
  auth: Auth;
  methods: Methods;
  changes: EventStream;
}

// Seconds a burst of changes waits before the page is told again, as the dashboard's cooldown did.
export const CHANGE_COOLDOWN_SECONDS = 0.5;

// ── Helpers ──────────────────────────────────────────────────────────────────

function caller_of(request: FastifyRequest, stream: EventStream): Caller {
  return { client: acting_client(request), from_page: Boolean(request.headers[stream.client_id_header]) };
}

// Runs a method and answers with its result, or with its refusal's status and body.
async function answer(reply: FastifyReply, run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) return reply.code(error.status).send(error.body);
    throw error;
  }
}

function query_number(value: string | undefined): number | null | typeof Number.NaN {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

// Tells the pages what changed, at once for the first change and then at most once per cooldown.
function follow_changes(stream: EventStream): () => void {
  let kinds = new Set<ChangeKind>();
  let monitors = new Set<string>();
  let cooling: NodeJS.Timeout | null = null;
  const flush = () => {
    if (kinds.size === 0) {
      cooling = null;
      return;
    }
    stream.send(JSON.stringify({ kinds: [...kinds], monitors: [...monitors] }), { event: stream.changed_event });
    kinds = new Set();
    monitors = new Set();
    cooling = setTimeout(flush, CHANGE_COOLDOWN_SECONDS * 1000);
    cooling.unref?.();
  };
  const unsubscribe = CHANGES.subscribe((kind, plugin_id) => {
    kinds.add(kind);
    if (plugin_id) monitors.add(plugin_id);
    if (cooling === null) flush();
  });
  return () => {
    unsubscribe();
    if (cooling !== null) clearTimeout(cooling);
  };
}

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: AppOptions): Promise<XMonitorApp> {
  const { engine } = options;
  const app = fastify({ logger: options.logger ?? false, forceCloseConnections: true });
  const notifications = options.notifications ?? (() => null);
  const methods = create_methods({ engine, notifications });
  const stream = new EventStream();

  register_starting_page(app, () => engine.ready);
  register_lenient_json_body(app);
  register_error_replies(app, { format: "json" });
  const auth = await register_auth(app, {
    database: options.database, auth_settings: options.auth_settings, accounts_file: options.accounts_file,
    oidc: options.oidc, proxy: options.proxy, open_paths: options.open_paths,
  });

  const stop_following = follow_changes(stream);
  app.addHook("onClose", async () => {
    stop_following();
    stream.close();
  });

  await app.register(async (scope) => {
    // ── Status ───────────────────────────────────────────────────────────

    scope.get("/health", async () => methods.get_health());
    scope.get("/summary", async () => methods.get_summary());
    scope.get("/backups", async () => methods.list_backup_monitors());
    scope.get("/monitors", async () => methods.list_monitors());
    scope.get<{ Params: { monitor_id: string } }>("/monitors/:monitor_id", async (request, reply) => answer(reply, () => methods.get_monitor(request.params.monitor_id)));
    scope.get("/metrics", async () => methods.list_metrics());
    scope.get<{ Querystring: { level?: string; target?: string; search?: string; limit?: string } }>("/events", async (request) => {
      const { level, target, search, limit } = request.query;
      return methods.list_events(level ?? null, target ?? null, search ?? null, limit === undefined ? 200 : Number(limit));
    });

    // ── Control ──────────────────────────────────────────────────────────

    scope.post<{ Params: { monitor_id: string } }>("/monitors/:monitor_id/poll", async (request, reply) =>
      answer(reply, () => methods.poll_monitor(request.params.monitor_id, caller_of(request, stream))));
    scope.post<{ Params: { monitor_id: string; action_id: string } }>("/monitors/:monitor_id/actions/:action_id", async (request, reply) =>
      answer(reply, () => methods.run_header_action(request.params.monitor_id, request.params.action_id, caller_of(request, stream))));
    scope.post<{ Params: { channel_id: string } }>("/notifications/:channel_id/test", async (request, reply) =>
      answer(reply, () => methods.send_test_notification(request.params.channel_id, caller_of(request, stream))));

    scope.get("/log-levels", async () => methods.list_log_levels());
    scope.post("/log-levels", async (request, reply) => {
      const body = request.body as unknown;
      // A body that is not a JSON object is the caller's mistake, answered like any other bad value.
      if (body === BAD_JSON || typeof body !== "object" || body === null || Array.isArray(body)) {
        return reply.code(400).send({ error: "expected a JSON object with logger and level" });
      }
      const fields = body as { logger?: string | null; level?: string | null };
      return answer(reply, () => methods.set_log_level(fields.logger ?? null, fields.level ?? null, "REST API"));
    });
    scope.post("/config/reload", async (_request, reply) => answer(reply, () => methods.reload_config("REST API")));

    // ── Push ─────────────────────────────────────────────────────────────

    type PushQuery = { status?: string; msg?: string; value?: string };
    const push = (request: FastifyRequest<{ Querystring: PushQuery }>, reply: FastifyReply, monitor_id: string, source: string | null) => {
      const value = query_number(request.query.value);
      if (Number.isNaN(value)) return reply.code(422).send({ error: "value must be a number" });
      return answer(reply, () => methods.push(monitor_id, request.query.status ?? "up", request.query.msg ?? null, value as number | null, source));
    };
    const with_monitor_token = async (request: FastifyRequest<{ Params: { monitor_id: string; token: string }; Querystring: PushQuery }>, reply: FastifyReply) => {
      const plugin = find_pushable(engine, request.params.monitor_id);
      if (plugin === null) return reply.code(404).send({ error: "not found" });
      if (!plugin.token || !same_token(request.params.token, plugin.token)) return reply.code(401).send({ error: "invalid token" });
      return push(request, reply, request.params.monitor_id, null);
    };
    // A named token travels only in the header, so it never lands in a proxy's access log.
    const with_bearer = async (request: FastifyRequest<{ Params: { monitor_id: string }; Querystring: PushQuery }>, reply: FastifyReply) => {
      if (find_pushable(engine, request.params.monitor_id) === null) return reply.code(404).send({ error: "not found" });
      const header = request.headers.authorization;
      const token = match_token(auth.tokens, /^bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim());
      if (token === null) return reply.code(401).send({ error: "invalid token" });
      if (!covers_monitor(token, request.params.monitor_id)) {
        log.warn(`api: token ${JSON.stringify(token.name)} (${token.scope}) refused a push to ${JSON.stringify(request.params.monitor_id)}`);
        return reply.code(403).send({ error: `token '${token.name}' may not push to ${request.params.monitor_id}` });
      }
      return push(request, reply, request.params.monitor_id, `token '${token.name}'`);
    };
    scope.get("/push/:monitor_id/:token", with_monitor_token);
    scope.post("/push/:monitor_id/:token", with_monitor_token);
    scope.get("/push/:monitor_id", with_bearer);
    scope.post("/push/:monitor_id", with_bearer);

    // ── The page's own routes ────────────────────────────────────────────

    scope.get("/dashboard", async () => methods.get_dashboard());
    scope.get("/overview", async () => methods.get_overview());
    scope.get("/schedules", async () => methods.list_schedules());
    scope.get("/notifications", async () => methods.get_notifications());
    scope.get("/logs/monitors", async () => methods.list_journal_monitors());
    scope.get<{ Params: { monitor_id: string } }>("/monitors/:monitor_id/page", async (request, reply) => answer(reply, () => methods.get_monitor_page(request.params.monitor_id)));
    scope.get<{ Params: { monitor_id: string; job_id: string } }>("/monitors/:monitor_id/jobs/:job_id", async (request, reply) =>
      answer(reply, () => methods.get_job(request.params.monitor_id, Number(request.params.job_id))));
    scope.get<{ Params: { monitor_id: string; job_id: string } }>("/monitors/:monitor_id/jobs/:job_id/log", async (request, reply) =>
      answer(reply, () => methods.get_job_log(request.params.monitor_id, Number(request.params.job_id))));
    scope.post<{ Params: { monitor_id: string } }>("/monitors/:monitor_id/jobs/cancel", async (request, reply) => answer(reply, () => methods.cancel_job(request.params.monitor_id)));
    scope.post<{ Params: { monitor_id: string }; Body: { muted?: unknown } }>("/monitors/:monitor_id/mute", async (request, reply) =>
      answer(reply, () => methods.set_muted(request.params.monitor_id, Boolean(request.body?.muted))));
    scope.post<{ Params: { monitor_id: string }; Body: { action_id?: unknown; args?: unknown } }>("/monitors/:monitor_id/run", async (request, reply) =>
      answer(reply, () => methods.run_action(request.params.monitor_id, String(request.body?.action_id ?? ""), (request.body?.args as Record<string, unknown>) ?? {}, caller_of(request, stream))));
    scope.put<{ Params: { key: string }; Body: { value?: unknown } }>("/ui-settings/:key", async (request, reply) =>
      answer(reply, () => methods.set_ui_setting(request.params.key, String(request.body?.value ?? ""))));

    // The page's change stream; the event log keeps Python's /api/events.
    stream.register(scope, "/changes");

    // ── Calls by name, MCP and OpenAPI ───────────────────────────────────

    const call = async (method: string, args: unknown[], request: FastifyRequest) => {
      const run = (methods as unknown as Record<string, (...given: unknown[]) => Promise<unknown>>)[method]!;
      const given = takes_caller.has(method) ? [...args.slice(0, api[method as keyof PublicMethods].params.length), caller_of(request, stream)] : args;
      return run.apply(methods, given);
    };
    scope.post<{ Params: { method: string } }>("/call/:method", async (request, reply) => {
      const method = request.params.method;
      if (!Object.hasOwn(api, method)) return reply.code(404).send({ error: `no call named ${JSON.stringify(method)}` });
      const body = request.body as unknown;
      const spec = api[method as keyof PublicMethods];
      const args = body === undefined || body === null ? [] : Array.isArray(body) ? body : body !== BAD_JSON && typeof body === "object" ? positional_args(spec, body as Record<string, unknown>) : null;
      if (args === null) return reply.code(400).send({ error: "send the arguments as a JSON list in order, or as an object by name" });
      return answer(reply, () => call(method, args, request));
    });
    await register_mcp_route(scope, {
      name: "x-monitor", version: options.version ?? "0.0.0", api, is_read_only,
      instructions: "X-Monitor watches hosts and services. list_monitors and get_overview are the places to start; a monitor's id comes from them.",
      call: async (method, args, request) => {
        const viewer = request.viewer;
        if (viewer && auth.accounts && !is_read_only(method) && !auth.accounts.has_role(viewer.role, "operator")) {
          throw new Error(`This needs the operator role; ${viewer.name} is a ${viewer.role}.`);
        }
        try {
          return await call(method, args, request);
        } catch (error) {
          if (error instanceof ApiError) throw new Error(String(error.body.error ?? error.message));
          throw error;
        }
      },
    });
    scope.get("/openapi.json", async () => openapi_document(api, { title: "X-Monitor", version: options.version ?? "0.0.0", path_of: (method) => `/api/call/${method}`, is_read_only }));

    if (options.backups) register_backup_routes(scope, { ...options.backups, prefix: "/state-backups" });
  }, { prefix: "/api" });

  app.get("/metrics", async (_request, reply) => reply.type(metrics_content_type).send(render(engine.db)));

  await options.extra_routes?.(app);
  if (options.web_folder) await register_web_folder(app, { folder: options.web_folder, page_fallback: true, api_prefix: "/api", when_missing: "warn" });
  return { app, auth, methods, changes: stream };
}

// ── Push helpers ─────────────────────────────────────────────────────────────

function find_pushable(engine: ServerEngine, monitor_id: string): PushablePlugin | null {
  const plugin = find_monitor(engine, monitor_id);
  return plugin !== null && is_pushable(plugin) ? plugin : null;
}

function same_token(given: string, expected: string): boolean {
  const first = Buffer.from(given);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}
