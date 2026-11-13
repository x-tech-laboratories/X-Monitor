// Desktop notifications an agent raises itself while X-Monitor is out of reach. The system agent runs the host's
// monitors but has no desktop session, and the notify-only agent in the user's session only hears from the server. So
// the system agent serves notify messages on a local socket, and the desktop agent follows that socket as well as the
// server. While the server is unreachable, the system agent sends each status change of its monitors there; once the
// server is back, notifications come from the server as usual.

import { CHANGES, STATUS } from "../core/state/changes.ts";
import type { NotifyMessage } from "../shared/agent_protocol.ts";

// The statuses a local notification is raised for, and the ones whose end is reported as a recovery.
const PROBLEMS = ["failed", "warning"];

// A notify message, as the server and the system agent both send them.
export function notify(title: string, body: string, urgency: NotifyMessage["urgency"] = "normal", options: { url?: string; icon?: string; key?: string; timeout?: number } = {}): NotifyMessage {
  return { type: "notify", title, body, urgency, ...options };
}

// ── Offline alerts ───────────────────────────────────────────────────────────

// What OfflineAlerts reads of the local engine.
export interface AlertingEngine {
  db: { latest_status(plugin_id: string): string };
  all_monitors(): { id: string; name: string }[];
}

// Turns status changes of the agent's own monitors into local notifications, but only while the server is out of reach.
export class OfflineAlerts {
  readonly notifier: { send(frame: Record<string, unknown>): Promise<void> };
  readonly agent_id: string;
  private readonly engine: () => AlertingEngine | null;
  private readonly connected: () => boolean;
  private readonly last = new Map<string, string>();

  constructor(notifier: { send(frame: Record<string, unknown>): Promise<void> }, engine: () => AlertingEngine | null, connected: () => boolean, agent_id: string) {
    this.notifier = notifier;
    this.engine = engine;
    this.connected = connected;
    this.agent_id = agent_id;
  }

  // Watches the agent's status writes; returns what stops watching.
  start(): () => void {
    return CHANGES.subscribe((kind, plugin_id) => {
      if (kind === STATUS && plugin_id) this.observe(plugin_id);
    });
  }

  // Notes a monitor's new status, notifying when it changed while the server cannot be reached.
  observe(plugin_id: string): void {
    const engine = this.engine();
    if (engine === null) return;
    const status = engine.db.latest_status(plugin_id);
    const previous = this.last.get(plugin_id);
    this.last.set(plugin_id, status);
    if (this.connected() || previous === undefined || previous === status) return;
    const name = engine.all_monitors().find((plugin) => plugin.id === plugin_id)?.name ?? plugin_id;
    const frame = this.frame(plugin_id, name, previous, status);
    if (frame !== null) void this.notifier.send(frame as unknown as Record<string, unknown>);
  }

  // The notification for one change, or null when the change is not worth one.
  frame(plugin_id: string, name: string, previous: string, status: string): NotifyMessage | null {
    const note = `Seen on ${this.agent_id} while X-Monitor was out of reach`;
    if (PROBLEMS.includes(status)) return notify(`${name} is ${status}`, note, status === "failed" ? "critical" : "normal", { key: `local:${plugin_id}` });
    if (PROBLEMS.includes(previous)) return notify(`${name} recovered`, note, "low", { key: `local:${plugin_id}` });
    return null;
  }
}
