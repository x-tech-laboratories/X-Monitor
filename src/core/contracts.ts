// Contracts that cross subsystem boundaries: the slice of the Coordination Engine monitors and the server call, the
// transport surface SSH and agent connections share, and the push surface a push monitor adds.

import type { DispatchResult, HttpRequest, HttpResult } from "./connectors/types.ts";
import type { DatabaseManager, MetricRowDict } from "./database/database.ts";
import type { CollectResult } from "./connectors/types.ts";

// What SSHConnection and AgentConnection share, which is why no monitor learns which transport it runs over.
export interface TransportConnection {
  readonly host: string;
  execute(command: string, timeout?: number | null): Promise<[exit_code: number, stdout: string, stderr: string]>;
}

// The read-only slice of the Database Engine the exporters and the REST API need.
export interface MetricsSource {
  latest_metrics(): MetricRowDict[];
  latest_statuses(): Record<string, string>;
}

// What a push monitor adds beyond the base plugin, so the push route need not import it.
export interface PushablePlugin {
  token: string | null;
  record_push(status: string, message?: string | null, value?: number | null, source?: string | null): boolean;
}

export function is_pushable(plugin: unknown): plugin is PushablePlugin {
  return typeof plugin === "object" && plugin !== null && "record_push" in plugin && typeof (plugin as PushablePlugin).record_push === "function";
}

// The surface of XMonitorEngine that monitors and the server call; a test double needs only this.
export interface EngineLike {
  readonly db: DatabaseManager;
  readonly ready: boolean;
  readonly plugins: readonly unknown[];
  readonly monitors_version: number;
  dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<DispatchResult>;
  http_fetch(request: HttpRequest): Promise<HttpResult>;
  run_cycle_now(plugin: unknown): Promise<boolean>;
  last_collected(plugin_id: string): number;
  set_setting(key: string, value: string): void;
  apply(plugin: unknown, result: CollectResult): void;
}
