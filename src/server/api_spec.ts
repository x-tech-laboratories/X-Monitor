// Every call the page makes and scripts may make, described once: what it does and a JSON Schema per argument. The
// server serves them by name at /api/call/<method>, as MCP tools at /api/mcp and in /api/openapi.json. Calls that only
// read are named list_, get_ or search_ and are marked read-only.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import type { Methods } from "./methods.ts";

// ── Spec ─────────────────────────────────────────────────────────────────────

// The calls served by name; push keeps to its own routes, since it signs in with a monitor's own token.
export type PublicMethods = Omit<Methods, "push">;

const monitor_id = { name: "monitor_id", schema: { type: "string", description: "A monitor's id, as /api/monitors lists it." } };
const job_id = { name: "job_id", schema: { type: "integer", description: "A job's id, from the monitor's page." } };

export const api: ApiSpec<PublicMethods> = {
  get_health: { description: "Says the server is up.", params: [] },
  get_summary: { description: "Counts the monitors by status, leaving out plain groups, with `unhealthy` for everything not online or info.", params: [] },
  list_backup_monitors: { description: "Lists every backup monitor's health, stalest first, with how many are healthy.", params: [] },
  list_monitors: { description: "Lists every monitor once, with its type, target, status and whether it holds children.", params: [] },
  get_monitor: { description: "Shows one monitor with its latest metrics and the ids of its header actions.", params: [monitor_id] },
  list_metrics: { description: "Lists the latest value of every metric of every monitor.", params: [] },
  list_events: {
    description: "Lists recent events, newest first, optionally of one level, one target or containing some text.",
    params: [
      { name: "level", schema: { type: ["string", "null"], enum: ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL", null] }, optional: true },
      { name: "target", schema: { type: ["string", "null"] }, optional: true },
      { name: "search", schema: { type: ["string", "null"] }, optional: true },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 2000, default: 200 }, optional: true },
    ],
  },
  poll_monitor: { description: "Polls a monitor now, its children first.", params: [monitor_id] },
  run_header_action: {
    description: "Runs one of a monitor's header actions, which take no arguments.",
    params: [monitor_id, { name: "action_id", schema: { type: "string" } }],
  },
  run_action: {
    description: "Runs any action a monitor's page offers, with the arguments its dialog or row passes; says how it went and names the detached job it started, if any.",
    params: [monitor_id, { name: "action_id", schema: { type: "string" } }, { name: "args", schema: { type: "object" }, optional: true }, { name: "label", schema: { type: ["string", "null"], description: "The name the notice gives the action." }, optional: true }],
  },
  run_toggle: {
    description: "Flips a toggle: runs its on or off action, then polls the monitor so the toggle shows what the target did; a table cell's toggle names its row.",
    params: [
      monitor_id, { name: "action_id", schema: { type: "string" } }, { name: "args", schema: { type: "object" }, optional: true },
      { name: "wanted", schema: { type: "boolean" }, optional: true }, { name: "label", schema: { type: "string" }, optional: true }, { name: "row_key", schema: {}, optional: true },
    ],
  },
  cancel_job: { description: "Cancels the job a monitor is running, or its newest detached action.", params: [monitor_id] },
  start_job: { description: "Starts the run action of a monitor's job panel without waiting for it.", params: [monitor_id, { name: "action_id", schema: { type: "string" } }, { name: "label", schema: { type: ["string", "null"] }, optional: true }] },
  get_job_log: { description: "Shows a job's log: its title, one-line summary, command, error and the output lines after a sequence number.", params: [monitor_id, job_id, { name: "after", schema: { type: "integer", default: -1 }, optional: true }] },
  watch_job: { description: "Polls a running job every few seconds while its log is open, returning a lease to renew and end.", params: [monitor_id, job_id] },
  renew_job_watch: { description: "Keeps a job log's watch going for another half minute.", params: [{ name: "lease", schema: { type: "string" } }] },
  end_job_watch: { description: "Ends a job log's watch.", params: [{ name: "lease", schema: { type: "string" } }] },
  get_notifications: { description: "Lists the notification channels, the maintenance windows and which are active, and the muted monitors.", params: [] },
  send_test_notification: { description: "Sends a test notification through one channel.", params: [{ name: "channel_id", schema: { type: "string" } }] },
  set_muted: { description: "Mutes or unmutes a monitor's notifications, or a group's and everything beneath it.", params: [monitor_id, { name: "muted", schema: { type: "boolean" } }] },
  list_log_levels: { description: "Lists the log level of the root logger and of each logger set by name, and every known logger.", params: [] },
  set_log_level: {
    description: "Sets a logger's level, or the root's without a logger; a null level makes a named logger inherit again.",
    params: [
      { name: "logger", schema: { type: ["string", "null"] }, optional: true },
      { name: "level", schema: { type: ["string", "null"], enum: ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL", null] } },
    ],
  },
  reload_config: { description: "Reads config.yaml again and applies it in place, saying what changed.", params: [] },
  set_ui_setting: {
    description: "Keeps one of the page's view settings: drawer_width, tree_expanded, tree_accordion or group_expanded_<monitor id>.",
    params: [{ name: "key", schema: { type: "string" } }, { name: "value", schema: { type: "string" } }],
  },
  get_sidebar: { description: "Shows the sidebar's monitor tree with each status, and its kept width, open branches and accordion mode.", params: [] },
  set_child_open: { description: "Opens or shuts one child card on a monitor's page.", params: [monitor_id, { name: "child_id", schema: { type: "string" } }, { name: "open", schema: { type: "boolean" } }] },
  get_overview: { description: "Shows the overview: the fleet sections, the monitors with their status and type tallies, and the latest metrics and events.", params: [] },
  list_schedules: { description: "Lists every scheduled and triggered action with its next run and how its last run went, soonest first.", params: [] },
  list_journal_monitors: { description: "Lists the journal monitors whose logs can be searched, and the default number of entries per host.", params: [] },
  search_logs: {
    description: "Searches the journals of the chosen monitors at once.",
    params: [
      { name: "monitor_ids", schema: { type: "array", items: { type: "string" } } },
      { name: "since", schema: { type: "string", enum: ["15m", "1h", "6h", "24h", "7d", "boot", ""], default: "1h" }, optional: true },
      { name: "priority", schema: { type: "integer", minimum: 3, maximum: 7, default: 6 }, optional: true },
      { name: "unit", schema: { type: "string", default: "" }, optional: true },
      { name: "text", schema: { type: "string", default: "" }, optional: true },
      { name: "limit", schema: { type: "integer", minimum: 1, default: 500 }, optional: true },
    ],
  },
  get_archive_folder: {
    description: "Lists one folder of a borg archive, listing it through the monitor first when it has not been listed yet.",
    params: [monitor_id, { name: "archive", schema: { type: "string" } }, { name: "path", schema: { type: "string", default: "" }, optional: true }],
  },
  get_monitor_page: { description: "Shows everything a monitor's page draws: its header, its actions and their states, its notification state, its dialogs and its widgets with their readings.", params: [monitor_id] },
};

// The calls that read only, by the standard's naming.
export function is_read_only(method: string): boolean {
  return /^(list_|get_|search_|lookup_|export_)/.test(method);
}

// The calls whose last argument is who asked, which the server fills in.
export const takes_caller = new Set(["poll_monitor", "run_header_action", "run_action", "send_test_notification"]);
