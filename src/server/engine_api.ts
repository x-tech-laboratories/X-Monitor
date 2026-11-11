// The part of XMonitorEngine the server calls, named as the Python engine names it, so the server and its tests need
// only this slice; the core's engine satisfies it.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { CollectResult, DispatchResult } from "../core/connectors/types.ts";
import type { DatabaseManager } from "../core/database/database.ts";
import type { AgentDirectory } from "./notifications/channels.ts";
import type { GraphView } from "../core/coordination/monitor_graph.ts";

// ── Monitors ─────────────────────────────────────────────────────────────────

// A monitor as the server reads it: the Plugin base plus the extras some monitor types add.
export interface ServerPlugin extends GraphView {
  id: string;
  name: string;
  target: string;
  config: Record<string, unknown>;
  children: ServerPlugin[];
  restates_children?: boolean;
  get_actions?(): { action_id: string; name?: string }[];
  all_actions?(): { action_id: string; name?: string; [key: string]: unknown }[];
  action_state?(action: never): string;
  run_cycle(): Promise<boolean>;
  run_action(action_id: string, args?: Record<string, unknown>): Promise<[boolean, string]>;
  [extra: string]: unknown;
}

// ── Engine ───────────────────────────────────────────────────────────────────

// What reloading the config did.
export interface ReloadResult {
  ok: boolean;
  restart_required?: boolean;
  summary(): string;
  as_dict(): Record<string, unknown>;
}

// The parts of config.yaml the server reads, through the engine's config loader.
export interface ConfigLoader {
  path: string;
  auth_settings?: Record<string, unknown>;
  notifications?: Record<string, unknown>;
  exporters?: Record<string, unknown>;
}

export interface ServerEngine {
  readonly db: DatabaseManager;
  readonly ready: boolean;
  readonly plugins: readonly ServerPlugin[];
  readonly monitors_version: number;
  readonly config_loader?: ConfigLoader;
  readonly connectors?: { agents: AgentDirectory };
  db_path?: string;
  // Set by the server, since the core cannot build the notification engine; the engine sends summaries through it.
  notifications?: unknown;
  apply(plugin: unknown, result: CollectResult): void;
  dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<DispatchResult>;
  reload_config?(source: string): Promise<ReloadResult>;
  log_levels?(): Record<string, string>;
  known_loggers?(): string[];
  set_log_level?(logger: string | null, level: string | null, source?: string): Record<string, string>;
}
