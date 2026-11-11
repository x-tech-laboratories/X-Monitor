// The events view's rows, the notifications dialog, and the system menu's log levels and config reload.

import type { DatabaseManager, EventDict } from "../../core/database/database.ts";
import { level_names } from "../../core/logging.ts";
import type { NotificationsLike, ViewEngine } from "./engine.ts";

// ── Events ───────────────────────────────────────────────────────────────────

// How many events the view reads; older ones are reachable only through the API.
export const EVENT_LIMIT = 500;

export const EVENT_LEVELS: [value: string | null, label: string][] = [[null, "All levels"], ["ERROR", "Error"], ["WARNING", "Warning"], ["INFO", "Info"]];

export interface EventFilter {
  level?: string | null;
  target?: string | null;
  search?: string | null;
}

// The most recent events from every monitor, narrowed by level, target and a search over messages.
export function events_view(db: Pick<DatabaseManager, "recent_events">, filter: EventFilter = {}): { lede: string; rows: EventDict[] } {
  const target = (filter.target ?? "").trim() || null;
  const search = (filter.search ?? "").trim() || null;
  return { lede: `The most recent ${EVENT_LIMIT} events from every monitor`, rows: db.recent_events(EVENT_LIMIT, filter.level || null, target, search) };
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface NotificationsView {
  channels: { id: string; type: string }[];
  windows: { name: string; describe: string; active: boolean }[];
  muted: { id: string; name: string }[];
}

// Each channel with its type, every maintenance window and whether it is active now, and every muted monitor by name.
export function notifications_view(notifications: NotificationsLike | null | undefined): NotificationsView {
  if (!notifications) return { channels: [], windows: [], muted: [] };
  const entries = notifications.channels instanceof Map ? [...notifications.channels] : Object.entries(notifications.channels);
  const active = notifications.active_windows();
  return {
    channels: entries.map(([id, channel]) => ({ id, type: channel.TYPE })),
    windows: notifications.windows.map((window) => ({ name: window.name, describe: window.describe(), active: active.includes(window) })),
    muted: [...notifications.muted_monitors()].sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase())).map((plugin) => ({ id: plugin.id, name: plugin.name })),
  };
}

// Mutes or unmutes a monitor, or everything in a group, and says so.
export function set_muted(notifications: NotificationsLike, plugin: { id: string; name: string }, muted: boolean): string {
  notifications.set_muted(plugin.id, muted);
  return `${plugin.name} ${muted ? "muted" : "unmuted"}`;
}

// Sends a test through one channel; a failure is the answer the operator asked for, so it is returned, not thrown.
export async function send_test(notifications: NotificationsLike, channel_id: string): Promise<{ ok: boolean; message: string }> {
  try {
    await notifications.send_test(channel_id);
  } catch (error) {
    return { ok: false, message: `Test to ${channel_id} failed: ${(error as Error).message}` };
  }
  return { ok: true, message: `Test sent to ${channel_id}` };
}

// ── System ───────────────────────────────────────────────────────────────────

export const ROOT_LOGGER = "root";

export interface LogLevelsView {
  levels: Record<string, string>;
  known: string[];
  level_names: readonly string[];
}

export function log_levels_view(engine: Pick<ViewEngine, "log_levels" | "known_loggers">): LogLevelsView {
  return { levels: engine.log_levels?.() ?? {}, known: [ROOT_LOGGER, ...(engine.known_loggers?.() ?? [])], level_names };
}

// Changes one logger's level, or puts it back to inheriting with null; a bad name is the operator's to fix, so it is
// returned rather than thrown.
export function apply_log_level(engine: Pick<ViewEngine, "set_log_level">, logger: string, level: string | null): { ok: boolean; message: string } {
  try {
    engine.set_log_level?.(logger, level, "dashboard");
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  return { ok: true, message: `${logger || ROOT_LOGGER} is now ${level || "inherited"}` };
}

// Re-reads the config now and says what changed, or why nothing did.
export async function reload_config(engine: Pick<ViewEngine, "reload_config">): Promise<{ message: string; tone: "positive" | "warning" | "negative" }> {
  if (!engine.reload_config) return { message: "Reloading is not available", tone: "negative" };
  const result = await engine.reload_config("dashboard");
  return { message: result.summary(), tone: result.ok && !result.restart_required ? "positive" : result.ok ? "warning" : "negative" };
}
