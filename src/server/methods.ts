// Every call the API serves, written once over the engine: the REST routes scripts have always used, the page's own
// routes, the call-by-name API, MCP and the OpenAPI document all run these.

// ── Imports ──────────────────────────────────────────────────────────────────

import { CollectResult } from "../core/connectors/types.ts";
import { create_logger_for } from "../core/logging.ts";
import { is_pushable } from "../core/contracts.ts";
import { action_id_of } from "../core/coordination/jobs.ts";
import type { JobsGateway } from "../core/coordination/jobs.ts";
import type { ServerEngine, ServerPlugin } from "./engine_api.ts";
import type { JsonValue } from "./json.ts";
import { find_monitor, iter_monitors, restates_children } from "./monitor_tree.ts";
import type { NotificationEngine } from "./notifications/index.ts";
import { attribute_names, history_requests, metric_names, read_attribute, resolve_spec, run_rules, to_json, with_item_rules } from "./spec.ts";
import { action_names, build_overview, build_tree_nodes, read_fleet, schedule_rows, when_text } from "./views.ts";

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
  const plugin = find_monitor(context.engine.plugins, monitor_id);
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
      return iter_monitors(engine.plugins).map((plugin) => monitor_summary(plugin, statuses));
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
      const clamped = Math.max(1, Math.min(Math.trunc(Number(limit) || 200), 2000));
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

    // Any action the monitor's page offers, with the arguments a dialog or row passes; a started job is named.
    async run_action(monitor_id: string, action_id: string, args: Record<string, unknown> = {}, caller: Caller = { client: null, from_page: false }) {
      const plugin = find(context, monitor_id);
      if (!caller.from_page) audit(context, plugin, `Action ${JSON.stringify(action_id)} requested through the API${by(caller)}`);
      try {
        const [success, content] = await plugin.run_action(action_id, args);
        const job = success ? jobs_of(plugin)?.action_job(action_id) ?? null : null;
        return { success: Boolean(success), content, job_id: job?.id ?? null };
      } catch (error) {
        throw new ApiError(500, { success: false, error: (error as Error).message });
      }
    },

    async cancel_job(monitor_id: string) {
      const jobs = jobs_of(find(context, monitor_id));
      if (jobs === null) throw new ApiError(404, { error: "this monitor runs no jobs" });
      return { cancelled: Boolean(await (jobs as unknown as { cancel(): Promise<boolean> }).cancel()) };
    },

    async get_job(monitor_id: string, job_id: number) {
      const plugin = find(context, monitor_id);
      const job = db.get_job(Number(job_id));
      if (job === null || job.plugin_id !== plugin.id) throw new ApiError(404, { error: "no such job" });
      const action = action_id_of(job.kind ?? "");
      const names = action_names((plugin.all_actions?.() ?? []) as never);
      return { ...job, title: (action !== null ? names[action] : null) ?? job.kind };
    },

    async get_job_log(monitor_id: string, job_id: number) {
      const plugin = find(context, monitor_id);
      const jobs = jobs_of(plugin);
      if (jobs === null) throw new ApiError(404, { error: "this monitor runs no jobs" });
      return jobs.log(Number(job_id));
    },

    // ── Push ───────────────────────────────────────────────────────────────

    push(monitor_id: string, status: string, message: string | null, value: number | null, source: string | null) {
      const plugin = find_monitor(engine.plugins, monitor_id);
      if (plugin === null || !is_pushable(plugin)) throw new ApiError(404, { error: "not found" });
      if (status !== "up" && status !== "down") throw new ApiError(400, { error: "status must be 'up' or 'down'" });
      return { success: plugin.record_push(status, message, value, source) };
    },

    // ── Notifications ──────────────────────────────────────────────────────

    async get_notifications() {
      const notifications = context.notifications();
      if (notifications === null) return { channels: [], windows: [], muted: [] };
      const now = new Date();
      const active = new Set(notifications.active_windows(now));
      return {
        channels: [...notifications.channels].map(([id, channel]) => ({ id, type: channel.type ?? "" })),
        windows: notifications.windows.map((window) => ({ name: window.name, schedule: window.describe(), active: active.has(window) })),
        muted: notifications.muted_monitors().map((monitor) => ({ id: monitor.id, name: monitor.name })).sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0)),
      };
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
      return { muted: Boolean(muted), muted_by: notifications.muted_by(plugin.id) };
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

    // The shell: the sidebar's tree, its kept settings, and whether notifications are on.
    async get_dashboard() {
      const statuses = db.latest_statuses();
      let expanded: unknown = [];
      try {
        expanded = JSON.parse(db.get_setting("tree_expanded") ?? "[]");
      } catch {
        expanded = [];
      }
      return {
        monitors_version: engine.monitors_version,
        notifications_enabled: notifications_or_none(context) !== null,
        tree: build_tree_nodes(engine.plugins, statuses),
        drawer_width: Number(db.get_setting("drawer_width") ?? 248) || 248,
        tree_expanded: Array.isArray(expanded) ? expanded : [],
        tree_accordion: db.get_setting("tree_accordion") === "1",
      };
    },

    async get_overview() {
      const statuses = db.latest_statuses();
      return {
        ...build_overview(engine.plugins, statuses),
        fleet: read_fleet(engine.plugins, db),
        recent_metrics: db.recent_metrics_raw(20).map((row) => to_json(row)),
        recent_events: db.recent_events_raw(20).map((row) => to_json(row)),
      };
    },

    async list_schedules() {
      return schedule_rows(engine.plugins, (key) => db.get_setting(key), new Date());
    },

    // The monitors whose journals the logs view searches.
    async list_journal_monitors() {
      return iter_monitors(engine.plugins).filter((plugin) => plugin.config?.type === "journal").map((plugin) => ({
        id: plugin.id, name: plugin.name, target: plugin.target, max_entries: Number(plugin.max_entries ?? 500),
      }));
    },

    // Searches the chosen monitors' journals at once; a monitor that fails says why in its own row.
    async search_logs(monitor_ids: string[], since = "1h", priority = 6, unit = "", text = "", limit = 500) {
      if (!LOG_SINCE.includes(since)) throw new ApiError(400, { error: `since must be one of ${LOG_SINCE.filter((choice) => choice).join(", ")} or empty` });
      const chosen = monitor_ids.map((monitor_id) => find(context, monitor_id));
      const outcomes = await Promise.all(chosen.map(async (plugin) => {
        try {
          const [success, metadata] = await engine.dispatch_action(plugin, "query_logs", { since, priority, unit, text, limit });
          if (!success) return { monitor_id: plugin.id, host: plugin.target, error: String(metadata?.content ?? "the search failed"), entries: [] };
          return { monitor_id: plugin.id, host: plugin.target, error: null, entries: JSON.parse(String(metadata?.entries ?? "[]")) as unknown[] };
        } catch (error) {
          return { monitor_id: plugin.id, host: plugin.target, error: (error as Error).message, entries: [] };
        }
      }));
      return outcomes;
    },

    // Everything a monitor's page draws: header, actions with their states, notification state, the resolved spec and
    // every reading its widgets show.
    async get_monitor_page(monitor_id: string) {
      const plugin = find(context, monitor_id);
      const statuses = db.latest_statuses();
      const now = new Date();
      const actions = (plugin.all_actions?.() ?? []) as { action_id: string; kind?: string; metric?: string; job?: unknown; detached?: boolean }[];
      const names = action_names(actions as never);
      const latest = (name: string) => db.latest_metric(plugin.id, name)?.value ?? null;
      const jobs = jobs_of(plugin);
      const notifications = notifications_or_none(context);
      const muted_by = notifications?.muted_by(plugin.id) ?? null;

      const raw_spec = (plugin.UI_SPEC as Record<string, unknown> | null | undefined) ?? null;
      const { spec, rules } = resolve_spec(raw_spec);
      const custom = typeof plugin.custom_view === "function" ? to_json((plugin.custom_view as () => unknown).call(plugin)) : null;
      const data: Record<string, JsonValue> = {};
      if (raw_spec !== null) {
        data.metrics = Object.fromEntries(metric_names(raw_spec).map((name) => [name, latest(name)]));
        data.histories = Object.fromEntries(history_requests(raw_spec).map(([name, limit]) => [name, db.metric_history(plugin.id, name, limit).map((record) => ({ timestamp: record.timestamp.toISOString(), value: record.value }))]));
        data.snapshot = to_json(with_item_rules(db.latest_snapshot(plugin.id, null), rules));
        data.collector_metrics = db.latest_collector_metrics(plugin.id).map((record) => ({ metric_name: record.metric_name, value: record.value }));
        data.attributes = Object.fromEntries(attribute_names(raw_spec).map((name) => [name, to_json(with_item_rules(read_attribute(plugin, name), rules))]));
        data.settings = Object.fromEntries(setting_keys(raw_spec, plugin.id).map((key) => [key, db.get_setting(key)]));
        data.events = raw_spec.events ? db.plugin_events(plugin.id, `[${plugin.name}] `, plugin.target, 100).map((row) => to_json(row)) : [];
        data.log_lines = db.log_lines(plugin.target, plugin.id, 100).map((row) => to_json(row));
        data.rules = run_rules(rules, plugin, latest);
        if (raw_spec.job_panel && jobs !== null) {
          const panel = raw_spec.job_panel as { history_limit?: number; exclude_kinds?: string[] };
          const current = jobs.current_id();
          data.job_panel = to_json({
            running: jobs.is_running(), current_id: current, progress: current !== null ? db.get_job(current)?.progress ?? null : null,
            recent: jobs.recent(panel.history_limit ?? 10, panel.exclude_kinds ?? []),
          });
        }
      }
      return {
        id: plugin.id, name: plugin.name, type: plugin.config?.type ?? null, target: plugin.target, status: statuses[plugin.id] ?? "unavailable",
        monitors_version: engine.monitors_version,
        layout_override: to_json(plugin.config?.layout ?? null),
        schedule: [
          ...((plugin.scheduled_actions as { action: string; cron: { expression: string; next_after(moment: Date): Date | null } }[] | undefined) ?? []).map((entry) => {
            const upcoming = entry.cron.next_after(now);
            return { action: names[entry.action] ?? entry.action, when: entry.cron.expression, next: upcoming ? when_text(upcoming) : "never" };
          }),
          ...((plugin.triggered_actions as { action: string; describe(): string }[] | undefined) ?? []).map((entry) => ({ action: names[entry.action] ?? entry.action, when: entry.describe(), next: null })),
        ],
        actions: actions.map((action) => ({
          ...(to_json(action) as Record<string, JsonValue>),
          state: typeof plugin.action_state === "function" ? plugin.action_state(action as never) : "normal",
          pressed: action.kind === "toggle" && action.metric ? (latest(action.metric) === null ? null : latest(action.metric)! > 0.5) : null,
        })),
        jobs: jobs === null ? null : { any_running: jobs.any_running(), cancellable: actions.some((action) => action.job || action.detached) },
        notifications: notifications === null ? null : {
          maintenance: notifications.maintenance_for(plugin.id),
          muted_by,
          muted_by_name: muted_by !== null ? notifications.monitor_name(muted_by) : null,
          muted: muted_by === plugin.id,
        },
        children: plugin.children.map((child) => ({ id: child.id, name: child.name, status: statuses[child.id] ?? "unavailable" })),
        group_expanded: plugin.children.length > 0 ? to_json(parse_object(db.get_setting(`group_expanded_${plugin.id}`))) : null,
        spec,
        custom_view: custom,
        data,
      };
    },
  };
}

export type Methods = ReturnType<typeof create_methods>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function parse_object(text: string | null): Record<string, unknown> {
  try {
    const parsed = text ? JSON.parse(text) : {};
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The settings a spec's repeats read, with `{plugin_id}` filled.
function setting_keys(spec: unknown, plugin_id: string): string[] {
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "setting_key" && typeof entry === "string") keys.add(entry.replaceAll("{plugin_id}", plugin_id));
        else walk(entry);
      }
    }
  };
  walk(spec);
  return [...keys];
}

