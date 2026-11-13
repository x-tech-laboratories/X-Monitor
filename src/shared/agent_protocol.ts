// X-Monitor's own messages between the server and an agent, carried beside the X-Libs agent protocol.
//
// X-Libs carries the login (challenge and signed hello), running commands, long runs and heartbeats. Everything
// X-Monitor adds rides as an app message on the same socket: event streams the agent watches, desktop
// notifications, sleep inhibitors, and the plan and records of an agent that runs its own monitors.

import type { AgentApp } from "@x-tech-laboratories/x-libs/agent/protocol";
import { shell_app } from "@x-tech-laboratories/x-libs/agent/protocol";

// ── App ──────────────────────────────────────────────────────────────────────

// Version 3 is the first on X-Libs' protocol; the Python agent spoke 2 and is turned away.
export const PROTOCOL_VERSION = 3;

// Bound into the key login's header (x-monitor-agent-host) and its signed challenge.
export const agent_app: AgentApp<string> = shell_app("x-monitor", PROTOCOL_VERSION);

// The capability an agent with a state directory announces: it can run monitors itself and sync their records.
export const ENGINE_CAPABILITY = "engine";

// ── Streams ──────────────────────────────────────────────────────────────────

// One event source an agent watches: `kind` picks the watcher, `params` is its own config, and `id` routes each
// event back to the monitor that asked, as "<monitor id>:<stream name>".
export interface StreamSpec {
  id: string;
  kind: string;
  params: Record<string, unknown>;
}

export function stream_from_wire(raw: unknown): StreamSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!record.id || !record.kind) return null;
  const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params) ? (record.params as Record<string, unknown>) : {};
  return { id: String(record.id), kind: String(record.kind), params };
}

// ── Messages ─────────────────────────────────────────────────────────────────

// Agent to server, once logged in: what the agent can do and the code it runs.
export interface CapabilitiesMessage {
  type: "capabilities";
  hostname: string;
  version: string;
  caps: string[];
  code: string;
}

// Server to agent: the full set of streams to watch from now on, never a delta.
export interface SubscribeMessage {
  type: "subscribe";
  streams: StreamSpec[];
}

// Agent to server: something happened on a stream, at `ts` in epoch seconds.
export interface EventMessage {
  type: "event";
  stream: string;
  ts: number;
  payload: Record<string, unknown>;
}

// Server to agent: show one desktop notification; `key` lets a later message replace or dismiss it.
export interface NotifyMessage {
  type: "notify";
  title: string;
  body: string;
  urgency: "low" | "normal" | "critical";
  url?: string;
  icon?: string;
  key?: string;
  timeout?: number;
}

export interface DismissMessage {
  type: "dismiss";
  key: string;
}

// Server to agent: keep the host from idling into sleep under a key, or let that key go.
export interface InhibitMessage {
  type: "inhibit";
  key: string;
  hold: boolean;
}

// Server to agent: the monitors this agent runs itself, as an X-Monitor config, under a version.
export interface PlanMessage {
  type: "plan";
  version: string;
  config: Record<string, unknown>;
}

export interface PlanAckMessage {
  type: "plan_ack";
  version: string;
}

// One outbox record: [sequence, kind, payload].
export type OutboxRecord = [seq: number, kind: string, payload: Record<string, unknown>];

// Agent to server: a batch of outbox records, oldest first.
export interface RecordsMessage {
  type: "records";
  records: OutboxRecord[];
}

// Server to agent: every record up to and including `through` is stored.
export interface RecordsAckMessage {
  type: "records_ack";
  through: number;
}

// Server to agent, as an X-Libs request (hub.request(host, "monitor_action", ...)): run an action on a monitor the
// agent runs; the reply is a MonitorActionReply.
export interface MonitorActionRequest {
  monitor: string;
  action: string;
  args: Record<string, unknown>;
}

export interface MonitorActionReply {
  success: boolean;
  metadata: Record<string, string>;
}

// Server to agent: run a cycle of one of the agent's monitors now.
export interface PollNowMessage {
  type: "poll_now";
  monitor: string;
}

export type ServerAppMessage =
  | SubscribeMessage | NotifyMessage | DismissMessage | InhibitMessage | PlanMessage | RecordsAckMessage | PollNowMessage;

export type AgentAppMessage = CapabilitiesMessage | EventMessage | PlanAckMessage | RecordsMessage;
