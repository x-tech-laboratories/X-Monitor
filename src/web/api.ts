// Calls the server's JSON API: every route the page uses, named once here, with the shapes it answers with, which
// the server's page-view builders (src/server/views/) make.

import { create_api } from "@x-tech-laboratories/x-libs/web/api";
import { create_accounts_client } from "@x-tech-laboratories/x-libs/web/accounts";
import { backup_client } from "@x-tech-laboratories/x-libs/web/backups";
import { create_watch } from "@x-tech-laboratories/x-libs/web/watch";

import type { ActionReply, MonitorPageView } from "../shared/page_view.ts";
import type { Status } from "../shared/status.ts";
import type { StripState } from "../shared/charts.ts";

// The change feed's client id, sent with every call, so a change the page makes is not audited as a script's.
let feed_client_id = (): string => "";

export function use_feed_client_id(read: () => string): void {
  feed_client_id = read;
}

export const api = create_api({ open_paths: ["/api/login"], headers: (): Record<string, string> => (feed_client_id() ? { "x-client-id": feed_client_id() } : {}) });
export const accounts = create_accounts_client();
// The state database's backups.
export const backups = backup_client(api, "/api/state-backups");

// Bumped whenever the server says something changed, so every open view loads again.
export const changes = create_watch();

// An open view loads again on each change the server announces, and each minute for ages that change on their own.
export const live = { watch: changes, refresh_in_milliseconds: 60_000 };

// The server-sent stream of changes.
export const CHANGES_PATH = "/api/changes";

const encoded = (text: string) => encodeURIComponent(text);

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface TreeNode {
  id: string;
  monitor: string;
  label: string;
  state: Status;
  children?: TreeNode[];
}

export interface SidebarSettings {
  drawer_width: number;
  expanded: string[];
  accordion: boolean;
}

export interface SidebarView {
  nodes: TreeNode[];
  settings: SidebarSettings;
}

export interface HostTile {
  id: string;
  name: string;
  state: string;
  caption: string;
  counts: Record<string, number>;
}

export interface FleetView {
  hosts: HostTile[];
  reachability: { id: string; host: string; name: string; metric: string; states: StripState[]; share_text: string }[];
  deploys: { id: string; name: string; state: string; caption: string }[] | null;
  findings: { id: string; name: string; vulnerable: number; suspected: number; noted: number; text: string }[] | null;
}

export interface MonitorRow {
  id: string;
  name: string;
  type: string;
  host: string;
  status: string;
  status_key: string;
  status_badge: string;
}

export interface OverviewView {
  monitor_count: number;
  lede: string;
  fleet: FleetView | null;
  status_counts: Record<string, number>;
  type_tiles: { name: string; value: number; status: string; breakdown: string }[];
  monitors: MonitorRow[];
  recent_metrics: Record<string, unknown>[];
  recent_events: Record<string, unknown>[];
}

export interface EventRow {
  timestamp: string;
  level: string;
  target: string;
  message: string;
}

export interface ScheduleRow {
  id: string;
  monitor_id: string;
  monitor: string;
  action: string;
  cron: string;
  next: string;
  last: string;
  outcome: string;
  outcome_badge: string;
  message: string;
}

export interface EntryRow {
  key: string;
  monitor_id: string;
  epoch: number;
  time: string;
  host: string;
  unit: string;
  priority: number;
  priority_name: string;
  priority_badge: string;
  message: string;
  parent?: string | null;
  group?: string;
}

export interface LogsView {
  monitors: { id: string; target: string }[];
  default_limit: number;
}

export interface NotificationsView {
  channels: { id: string; type: string }[];
  windows: { name: string; describe: string; active: boolean }[];
  muted: { id: string; name: string }[];
}

export interface JobLog {
  id: number;
  title: string;
  summary: string;
  command: string;
  error: string | null;
  running: boolean;
  lines: { seq: number; stream: string; message: string; timestamp: string }[];
}

// ── Calls ────────────────────────────────────────────────────────────────────

// What a toggle or cell toggle sends.
export interface ToggleRequest {
  action_id: string;
  args?: Record<string, unknown>;
  wanted: boolean;
  label: string;
  row_key?: unknown;
}

export const calls = {
  sidebar: () => api<SidebarView>("/api/sidebar"),
  save_ui_setting: (key: string, value: string) => api<void>(`/api/ui-settings/${encoded(key)}`, "PUT", { value }),
  overview: () => api<OverviewView>("/api/overview"),
  monitor: (id: string) => api<MonitorPageView>(`/api/monitors/${encoded(id)}/page`),
  poll: (id: string) => api<{ polled: boolean }>(`/api/monitors/${encoded(id)}/poll`, "POST"),
  run_action: (id: string, action_id: string, args: Record<string, unknown>, label: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/run`, "POST", { action_id, args, label }),
  toggle: (id: string, body: ToggleRequest) => api<ActionReply>(`/api/monitors/${encoded(id)}/toggle`, "POST", body),
  cancel: (id: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/jobs/cancel`, "POST"),
  start_job: (id: string, action_id: string, label: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/jobs/start`, "POST", { action_id, label }),
  job_log: (id: string, job_id: number, after: number) => api<JobLog>(`/api/monitors/${encoded(id)}/jobs/${job_id}/log?after=${after}`),
  watch_job: (id: string, job_id: number) => api<{ lease: string | null }>(`/api/monitors/${encoded(id)}/jobs/${job_id}/watch`, "POST"),
  renew_watch: (lease: string) => api<{ ok: boolean }>(`/api/job-watches/${encoded(lease)}/renew`, "POST"),
  end_watch: (lease: string) => api<{ ok: boolean }>(`/api/job-watches/${encoded(lease)}`, "DELETE"),
  open_child: (id: string, child_id: string, open: boolean) => api<{ open: boolean }>(`/api/monitors/${encoded(id)}/children/${encoded(child_id)}/open`, "POST", { open }),
  mute: (id: string, muted: boolean) => api<{ message: string }>(`/api/monitors/${encoded(id)}/mute`, "POST", { muted }),
  // Python's REST event log, which the Events page reads.
  events: (filter: { level: string; target: string; search: string }) => api<EventRow[]>(`/api/events?limit=500&level=${encoded(filter.level)}&target=${encoded(filter.target)}&search=${encoded(filter.search)}`),
  schedules: () => api<ScheduleRow[]>("/api/schedules"),
  logs: () => api<LogsView>("/api/logs/monitors"),
  search_logs: (body: { monitor_ids: string[] | null; since: string; priority: number; unit: string; text: string; limit: number }) => api<{ rows: EntryRow[]; summary: string }>("/api/logs/search", "POST", body),
  notifications: () => api<NotificationsView>("/api/notifications"),
  send_test: (channel_id: string) => api<{ sent: boolean }>(`/api/notifications/${encoded(channel_id)}/test`, "POST"),
  log_levels: () => api<{ levels: Record<string, string>; loggers: string[] }>("/api/log-levels"),
  set_log_level: (logger: string, level: string | null) => api<{ levels: Record<string, string> }>("/api/log-levels", "POST", { logger, level }),
  reload: () => api<{ ok: boolean; summary: string; restart_required?: string[] }>("/api/config/reload", "POST"),
};
