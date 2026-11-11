// The slice of XMonitorEngine the page-view builders read, with the Python engine's names, plus the plugin-attribute read
// they share. A builder takes this rather than the engine class so a test can hand it a stand-in.

import type { DispatchResult } from "../../core/connectors/types.ts";
import type { DatabaseManager } from "../../core/database/database.ts";
import type { Plugin } from "../../monitors/base/plugin_base.ts";

// ── Notifications ────────────────────────────────────────────────────────────

export interface MaintenanceWindowLike {
  name: string;
  describe(): string;
}

// The notification manager the mute toggle and the notifications dialog use.
export interface NotificationsLike {
  readonly channels: Record<string, { TYPE: string }> | Map<string, { TYPE: string }>;
  readonly windows: readonly MaintenanceWindowLike[];
  maintenance_for(plugin_id: string): string | null;
  muted_by(plugin_id: string): string | null;
  monitor_name(plugin_id: string): string;
  set_muted(plugin_id: string, muted: boolean): void;
  muted_monitors(): Plugin[];
  active_windows(): readonly MaintenanceWindowLike[];
  send_test(channel_id: string): Promise<void>;
}

// ── Runtime controls ─────────────────────────────────────────────────────────

export interface ReloadResultLike {
  ok: boolean;
  restart_required: boolean;
  summary(): string;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface ViewEngine {
  readonly db: DatabaseManager;
  readonly plugins: readonly Plugin[];
  readonly monitors_version?: number;
  readonly notifications?: NotificationsLike | null;
  dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<DispatchResult>;
  set_setting(key: string, value: string): void;
  log_levels?(): Record<string, string>;
  known_loggers?(): string[];
  set_log_level?(logger: string, level: string | null, source?: string): void;
  reload_config?(source: string): Promise<ReloadResultLike>;
}

// ── Plugin attributes ────────────────────────────────────────────────────────

// A plugin attribute a spec names, such as `value_attr`; a method is called, a missing one reads as undefined.
export function plugin_attr(plugin: unknown, name: string): unknown {
  const value = (plugin as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as () => unknown).call(plugin) : value;
}
