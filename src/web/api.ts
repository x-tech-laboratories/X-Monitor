// Calls the server's JSON API: every route the page uses, named once here, with the shapes it answers with, which
// the server's page-view builders (src/server/views/) make.

import { create_api } from "@x-tech-laboratories/x-libs/web/api";
import { create_accounts_client } from "@x-tech-laboratories/x-libs/web/accounts";
import { backup_client } from "@x-tech-laboratories/x-libs/web/backups";
import { create_watch } from "@x-tech-laboratories/x-libs/web/watch";

import type { ActionReply, MonitorPageView } from "../shared/page_view.ts";
import type { Status } from "../shared/status.ts";
import type { StripState } from "../shared/charts.ts";

export const api = create_api({ open_paths: ["/api/login"] });
export const accounts = create_accounts_client();
export const backups = backup_client(api);

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
  backups: { id: string; label: string; value_text: string; percent: number; state: string }[] | null;
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

export interface LogLevelsView {
  levels: Record<string, string>;
  known: string[];
  level_names: string[];
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

export interface BrowseFolder {
  status: string;
  rows: { name: string; path: string; dir: boolean; size: string; size_bytes: number | null; mtime: string }[];
}

export interface Message {
  ok: boolean;
  message: string;
  tone?: "positive" | "warning" | "negative";
}

// ── Calls ────────────────────────────────────────────────────────────────────

export const calls = {
  sidebar: () => api<SidebarView>("/api/sidebar"),
  save_sidebar: (changes_made: Partial<SidebarSettings>) => api<void>("/api/sidebar", "PUT", changes_made),
  overview: () => api<OverviewView>("/api/overview"),
  monitor: (id: string) => api<MonitorPageView>(`/api/monitors/${encoded(id)}/page`),
  poll: (id: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/poll`, "POST"),
  run_action: (id: string, action_id: string, args: Record<string, unknown>, label: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/actions/${encoded(action_id)}`, "POST", { args, label }),
  run_header_action: (id: string, action_id: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/header-actions/${encoded(action_id)}`, "POST"),
  toggle: (id: string, body: { name: string; on_action_id: string; off_action_id: string; wanted: boolean }) => api<ActionReply>(`/api/monitors/${encoded(id)}/toggle`, "POST", body),
  cell_toggle: (id: string, body: { column_label: string; row_key: unknown; action_id: string; args: Record<string, unknown>; wanted: boolean }) => api<ActionReply>(`/api/monitors/${encoded(id)}/cell-toggle`, "POST", body),
  cancel: (id: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/cancel`, "POST"),
  start_job: (id: string, action_id: string, label: string) => api<ActionReply>(`/api/monitors/${encoded(id)}/jobs/start`, "POST", { action_id, label }),
  job_log: (id: string, job_id: number, after: number) => api<JobLog>(`/api/monitors/${encoded(id)}/jobs/${job_id}/log?after=${after}`),
  watch_job: (id: string, job_id: number) => api<{ lease: string | null }>(`/api/monitors/${encoded(id)}/jobs/${job_id}/watch`, "POST"),
  renew_watch: (lease: string) => api<{ ok: boolean }>(`/api/job-watches/${encoded(lease)}/renew`, "POST"),
  end_watch: (lease: string) => api<void>(`/api/job-watches/${encoded(lease)}`, "DELETE"),
  open_child: (id: string, child_id: string, open: boolean) => api<void>(`/api/monitors/${encoded(id)}/children/${encoded(child_id)}/open`, "POST", { open }),
  browse: (id: string, archive: string, path: string) => api<BrowseFolder>(`/api/monitors/${encoded(id)}/browse?archive=${encoded(archive)}&path=${encoded(path)}`),
  mute: (id: string, muted: boolean) => api<{ message: string }>(`/api/monitors/${encoded(id)}/mute`, "POST", { muted }),
  events: (filter: { level: string; target: string; search: string }) => api<{ lede: string; rows: EventRow[] }>(`/api/event-log?level=${encoded(filter.level)}&target=${encoded(filter.target)}&search=${encoded(filter.search)}`),
  schedules: () => api<ScheduleRow[]>("/api/schedules"),
  logs: () => api<LogsView>("/api/logs"),
  search_logs: (body: { monitor_ids: string[] | null; since: string; priority: number; unit: string; text: string; limit: number }) => api<{ rows: EntryRow[]; summary: string }>("/api/logs/search", "POST", body),
  notifications: () => api<NotificationsView>("/api/notifications"),
  send_test: (channel_id: string) => api<Message>(`/api/notifications/test/${encoded(channel_id)}`, "POST"),
  log_levels: () => api<LogLevelsView>("/api/system/log-levels"),
  set_log_level: (logger: string, level: string | null) => api<Message>("/api/system/log-levels", "PUT", { logger, level }),
  reload: () => api<Message>("/api/system/reload", "POST"),
};
