// Every call the API serves, written once over the engine: the REST routes scripts have always used, the page's own
// routes, the call-by-name API, MCP and the OpenAPI document all run these.

// ── Imports ──────────────────────────────────────────────────────────────────

import { CollectResult } from "../core/connectors/types.ts";
import { create_logger_for } from "../core/logging.ts";
import { is_pushable } from "../core/contracts.ts";
import type { JobsGateway } from "../core/coordination/jobs.ts";
import type { ServerEngine, ServerPlugin } from "./engine_api.ts";
import { find_monitor, iter_monitors, restates_children } from "../core/coordination/monitor_graph.ts";
import type { NotificationEngine } from "./notifications/index.ts";
import type { Plugin } from "../monitors/base/plugin_base.ts";
import type { ActionReply } from "../shared/page_view.ts";
import {
  browse_folder, cancel_job, job_log_view, JobWatches, logs_view, monitor_page_view, notifications_view, overview_view, run_cell_toggle, run_header_toggle,
  run_page_action, schedule_rows, search_kwargs, search_logs, set_child_open, sidebar_view, start_job, type NotificationsLike,
} from "./views/index.ts";

const log = create_logger_for("x_monitor.core.ui.api");

// ── Errors ───────────────────────────────────────────────────────────────────

// A refusal with the status and body the route answers with.
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `HTTP ${status}`));
    this.status = status;
    this.body = body;
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

export interface MethodContext {
  engine: ServerEngine;
  // The notification engine now running, which a config reload replaces.
  notifications: () => NotificationEngine | null;
}

// Who asked, for the audit trail, and whether the page asked, which leaves no audit line.
export interface Caller {
  client: string | null;
  from_page: boolean;
}

// The UI settings the page may change, by exact key or prefix.
const UI_SETTING_KEYS = ["drawer_width", "tree_expanded", "tree_accordion"];
const UI_SETTING_PREFIXES = ["group_expanded_"];

// The journal search's choices, as the logs view offers them.
const LOG_SINCE = ["15m", "1h", "6h", "24h", "7d", "boot", ""];

// ── Helpers ──────────────────────────────────────────────────────────────────

function by(caller: Caller): string {
  return caller.client ? ` by ${caller.client}` : "";
}

function action_ids(plugin: ServerPlugin): string[] {
  return typeof plugin.get_actions === "function" ? plugin.get_actions().map((action) => action.action_id) : [];
}

function jobs_of(plugin: ServerPlugin): JobsGateway | null {
  return (plugin.jobs as JobsGateway | null | undefined) ?? null;
}

function find(context: MethodContext, monitor_id: string): ServerPlugin {
  const plugin = find_monitor(context.engine, monitor_id);
  if (plugin === null) throw new ApiError(404, { error: "not found" });
  return plugin;
}

function audit(context: MethodContext, plugin: ServerPlugin, message: string): void {
  context.engine.apply(plugin, new CollectResult({ logs: [[message, "INFO"]] }));
}

function notifications_or_none(context: MethodContext): NotificationEngine | null {
  const notifications = context.notifications();
  return notifications !== null && notifications.channels.size > 0 ? notifications : null;
}

// ── Methods ──────────────────────────────────────────────────────────────────

export function create_methods(context: MethodContext) {
  const { engine } = context;
  const db = engine.db;
  const watches = new JobWatches();

  const monitor_summary = (plugin: ServerPlugin, statuses: Record<string, string>) => ({
    id: plugin.id, name: plugin.name, type: plugin.config?.type ?? null, target: plugin.target ?? null,
    status: statuses[plugin.id] ?? "unavailable", is_group: plugin.children.length > 0,
  });

  return {
    // ── Status ─────────────────────────────────────────────────────────────

    async get_health(): Promise<{ status: string }> {
      return { status: "ok" };
    },

    // Counts of monitors, leaving out plain groups, by status.
    async get_summary(): Promise<Record<string, number>> {
      const statuses = db.latest_statuses();
      const counts: Record<string, number> = { online: 0, info: 0, warning: 0, failed: 0, offline: 0, unavailable: 0 };
      for (const plugin of iter_monitors(engine.plugins)) {
        if (restates_children(plugin)) continue;
        const state = statuses[plugin.id] ?? "unavailable";
        counts[state] = (counts[state] ?? 0) + 1;
      }
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      return { total, ...counts, unhealthy: total - counts.online! - counts.info! };
    },

    // Every backup monitor's health in one list, stalest first.
    async list_backup_monitors() {
      const statuses = db.latest_statuses();
      const rows: Record<string, unknown>[] = [];
      for (const plugin of iter_monitors(engine.plugins)) {
        const summarize = plugin.backup_summary;
        if (restates_children(plugin) || typeof summarize !== "function") continue;
        rows.push({ id: plugin.id, name: plugin.name, target: plugin.target ?? null, status: statuses[plugin.id] ?? "unavailable", ...(summarize.call(plugin) as Record<string, unknown>) });
      }
      const age = (row: Record<string, unknown>) => (row.newest_archive_age === null || row.newest_archive_age === undefined ? Infinity : Number(row.newest_archive_age));
      rows.sort((first, second) => age(second) - age(first));
      const healthy = rows.filter((row) => row.status === "online" || row.status === "info").length;
      return { total: rows.length, healthy, unhealthy: rows.length - healthy, repositories: rows };
    },

    async list_monitors() {
      const statuses = db.latest_statuses();
      return [...iter_monitors(engine.plugins)].map((plugin) => monitor_summary(plugin, statuses));
    },

    async get_monitor(monitor_id: string) {
      const plugin = find(context, monitor_id);
      const statuses = db.latest_statuses();
      return {
        ...monitor_summary(plugin, statuses),
        metrics: db.latest_metrics().filter((row) => row.plugin_id === plugin.id),
        actions: action_ids(plugin),
      };
    },

    async list_metrics() {
      return db.latest_metrics();
    },

    async list_events(level: string | null = null, target: string | null = null, search: string | null = null, limit = 200) {
      const asked = Number(limit);
      const clamped = Math.max(1, Math.min(Number.isFinite(asked) ? Math.trunc(asked) : 200, 2000));
      return db.recent_events(clamped, level || null, target || null, search || null);
    },

    // ── Control ────────────────────────────────────────────────────────────

    async poll_monitor(monitor_id: string, caller: Caller = { client: null, from_page: false }) {
      const plugin = find(context, monitor_id);
      if (!caller.from_page) audit(context, plugin, `Poll requested through the API${by(caller)}`);
      return { polled: Boolean(await plugin.run_cycle()) };
    },

    // One of the monitor's header buttons, which take no arguments.
    async run_header_action(monitor_id: string, action_id: string, caller: Caller = { client: null, from_page: false }) {
      const plugin = find(context, monitor_id);
      if (!action_ids(plugin).includes(action_id)) throw new ApiError(404, { error: "no such action" });
      audit(context, plugin, `Action ${JSON.stringify(action_id)} requested through the API${by(caller)}`);
      try {
        const [success, content] = await plugin.run_action(action_id);
        return { success: Boolean(success), content };
      } catch (error) {
        throw new ApiError(500, { success: false, error: (error as Error).message });
      }
    },

    // Any action the monitor's page offers, with the arguments a dialog or row passes, said under `label` in the
    // notice; a detached job it started is named, so the page opens its log.
    async run_action(monitor_id: string, action_id: string, args: Record<string, unknown> = {}, label: string | null = null, caller: Caller = { client: null, from_page: false }): Promise<ActionReply> {
      const plugin = find(context, monitor_id);
      if (!caller.from_page) audit(context, plugin, `Action ${JSON.stringify(action_id)} requested through the API${by(caller)}`);
      try {
        return await run_page_action(as_plugin(plugin), action_id, args ?? {}, label || action_id);
      } catch (error) {
        throw new ApiError(500, { success: false, error: (error as Error).message });
      }
    },

    // Flips a toggle, a header button's or a table cell's (`row_key` set), then polls so it shows what the target did.
    async run_toggle(monitor_id: string, action_id: string, args: Record<string, unknown> = {}, wanted = true, label = "", row_key: unknown = null): Promise<ActionReply> {
      const plugin = as_plugin(find(context, monitor_id));
      if (row_key === null || row_key === undefined) return run_header_toggle(plugin, label || action_id, action_id, action_id, Boolean(wanted));
      return run_cell_toggle(plugin, label || action_id, row_key, action_id, args ?? {}, Boolean(wanted));
    },

    // Cancels the monitor's running job, or its newest detached action.
    async cancel_job(monitor_id: string): Promise<ActionReply> {
      const plugin = find(context, monitor_id);
      if (jobs_of(plugin) === null) throw new ApiError(404, { error: "this monitor runs no jobs" });
      return cancel_job(as_plugin(plugin));
    },

    // Starts the job panel's run action without waiting for it.
    async start_job(monitor_id: string, action_id: string, label: string | null = null): Promise<ActionReply> {
      return start_job(as_plugin(find(context, monitor_id)), action_id, label);
    },

    // A job's log as its dialog shows it, its lines after `after`.
    async get_job_log(monitor_id: string, job_id: number, after = -1) {
      const plugin = find(context, monitor_id);
      const job = db.get_job(Number(job_id));
      if (job === null || job.plugin_id !== plugin.id) throw new ApiError(404, { error: "no such job" });
      return job_log_view(as_plugin(plugin), Number(job_id), Number(after));
    },

    // Polls a running job every few seconds while its log is open; the page renews the lease it gets back.
    async watch_job(monitor_id: string, job_id: number) {
      const plugin = find(context, monitor_id);
      const job = db.get_job(Number(job_id));
      if (job === null || job.plugin_id !== plugin.id) throw new ApiError(404, { error: "no such job" });
      return { lease: watches.open(as_plugin(plugin), job) };
    },

    async renew_job_watch(lease: string) {
      return { ok: watches.renew(lease) };
    },

    async end_job_watch(lease: string) {
      watches.close(lease);
      return { ok: true };
    },

    // ── Push ───────────────────────────────────────────────────────────────

    push(monitor_id: string, status: string, message: string | null, value: number | null, source: string | null) {
      const plugin = find_monitor(engine, monitor_id);
      if (plugin === null || !is_pushable(plugin)) throw new ApiError(404, { error: "not found" });
      if (status !== "up" && status !== "down") throw new ApiError(400, { error: "status must be 'up' or 'down'" });
      return { success: plugin.record_push(status, message, value, source) };
    },

    // ── Notifications ──────────────────────────────────────────────────────

    async get_notifications() {
      return notifications_view(notifications_like(context.notifications()));
    },

    async send_test_notification(channel_id: string, caller: Caller = { client: null, from_page: false }) {
      const notifications = context.notifications();
      if (notifications === null || !notifications.channels.has(channel_id)) throw new ApiError(404, { error: "no such channel" });
      log.info(`api: test notification through ${JSON.stringify(channel_id)} requested${by(caller)}`);
      // A failed delivery is the answer the caller asked for, not a server error.
      try {
        await notifications.send_test(channel_id);
      } catch (error) {
        throw new ApiError(502, { sent: false, error: (error as Error).message });
      }
      return { sent: true };
    },

    async set_muted(monitor_id: string, muted: boolean) {
      const plugin = find(context, monitor_id);
      const notifications = notifications_or_none(context);
      if (notifications === null) throw new ApiError(404, { error: "no notification channels are configured" });
      notifications.set_muted(plugin.id, Boolean(muted));
      return { muted: Boolean(muted), muted_by: notifications.muted_by(plugin.id), message: `${plugin.name} ${muted ? "muted" : "unmuted"}` };
    },

    // ── System ─────────────────────────────────────────────────────────────

    async list_log_levels() {
      return { levels: engine.log_levels?.() ?? {}, loggers: engine.known_loggers?.() ?? [] };
    },

    async set_log_level(logger: string | null, level: string | null, source = "REST API") {
      if (!engine.set_log_level) throw new ApiError(404, { error: "log levels cannot be changed here" });
      try {
        return { levels: engine.set_log_level(logger ?? null, level ?? null, source) };
      } catch (error) {
        throw new ApiError(400, { error: (error as Error).message });
      }
    },

    async reload_config(source = "REST API") {
      if (!engine.reload_config) throw new ApiError(404, { error: "the config cannot be reloaded here" });
      const result = await engine.reload_config(source);
      if (!result.ok) throw new ApiError(422, result.as_dict());
      return result.as_dict();
    },

    async set_ui_setting(key: string, value: string) {
      if (!UI_SETTING_KEYS.includes(key) && !UI_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) throw new ApiError(400, { error: `${JSON.stringify(key)} is not a setting the page keeps` });
      db.set_setting(key, String(value));
      return { key, value: String(value) };
    },

    // ── The page's views ───────────────────────────────────────────────────

    // The sidebar's monitor tree with each status, and its kept width, open branches and accordion mode.
    async get_sidebar() {
      return sidebar_view({ plugins: engine.plugins, db });
    },

    // Opens or shuts one child card on a monitor's page, keeping the choice.
    async set_child_open(monitor_id: string, child_id: string, open: boolean) {
      set_child_open(db, as_plugin(find(context, monitor_id)), child_id, Boolean(open));
      return { open: Boolean(open) };
    },

    async get_overview() {
      return overview_view({ plugins: engine.plugins as never, db });
    },

    async list_schedules() {
      return schedule_rows(engine.plugins as never, (key) => db.get_setting(key), new Date());
    },

    // The journal monitors the logs view searches, and its default per-host limit.
    async list_journal_monitors() {
      return logs_view({ plugins: engine.plugins as never });
    },

    // Searches the chosen monitors' journals at once, as rows with a line saying which hosts could not be searched.
    async search_logs(monitor_ids: string[], since = "1h", priority = 6, unit = "", text = "", limit = 500) {
      if (!LOG_SINCE.includes(since)) throw new ApiError(400, { error: `since must be one of ${LOG_SINCE.filter((choice) => choice).join(", ")} or empty` });
      return search_logs({ plugins: engine.plugins as never, dispatch_action: (plugin, action_id, args) => engine.dispatch_action(plugin, action_id, args) }, monitor_ids, search_kwargs(since, priority, unit, text, limit));
    },

    // One folder of a borg archive, listing it through the monitor when it has not been listed yet.
    async get_archive_folder(monitor_id: string, archive: string, path = "") {
      return browse_folder(engine, as_plugin(find(context, monitor_id)), archive, path);
    },

    // Everything a monitor's page draws: its header, actions and their states, notification state and body.
    async get_monitor_page(monitor_id: string) {
      return monitor_page_view({ notifications: notifications_like(notifications_or_none(context)) }, as_plugin(find(context, monitor_id)));
    },
  };
}

export type Methods = ReturnType<typeof create_methods>;

// ── Helpers ──────────────────────────────────────────────────────────────────

// The engine's monitors are full Plugins; the server's own type only names what its REST routes read.
function as_plugin(plugin: ServerPlugin): Plugin {
  return plugin as unknown as Plugin;
}

function notifications_like(notifications: NotificationEngine | null): NotificationsLike | null {
  return notifications as unknown as NotificationsLike | null;
}
