// The server half of the agent link. An agent dials in over a WebSocket, logs in with its host's key through the
// X-Libs agent hub, and stays connected; this module keeps the Python app's view of that link on top of the hub.
//
// AgentConnection is one configured agent, connected or not: its execute() has SSHConnection's shape, so a monitor runs
// unchanged over either. AgentRegistry is the id-to-connection map, owns the hub, and routes what agents send (events,
// synced records, plan acknowledgements) to whoever installed a sink. A configured agent that has not dialled in is no
// error: its connection exists from startup and fails each call with a clear message until the agent arrives.

import { parse_public_key } from "@x-tech-laboratories/x-libs/agent/keys";
import type { AppMessage } from "@x-tech-laboratories/x-libs/agent/protocol";
import type { AgentConnection as HubConnection } from "@x-tech-laboratories/x-libs/server/agents/connection";
import { AgentHub, type AgentStatus, type HubOptions } from "@x-tech-laboratories/x-libs/server/agents/hub";

import {
  agent_app, ENGINE_CAPABILITY, stream_from_wire, type MonitorActionReply, type NotifyMessage, type PlanAckMessage, type RecordsMessage,
  type ServerAppMessage, type StreamSpec,
} from "../../shared/agent_protocol.ts";
import { code_version } from "../code_version.ts";
import type { TransportConnection } from "../contracts.ts";
import { create_logger_for } from "../logging.ts";
import { python_repr } from "../python.ts";

const log = create_logger_for("x_monitor.core.connectors.agent_connector");

export const EXEC_TIMEOUT = 30.0;
export const CONTROL_TIMEOUT = 60.0;

// The capabilities an agent announces for the messages it understands beyond running commands.
export const NOTIFY_CAPABILITY = "notify";
export const DISMISS_CAPABILITY = "dismiss";
export const INHIBIT_CAPABILITY = "inhibit";

// What the hub hands over for one connected agent; a test fakes it.
export type AgentLink = Pick<HubConnection<string>, "is_open" | "run" | "request" | "send" | "close">;

// A synced record batch or a plan acknowledgement, as the agent plans receive them.
export type SyncMessage = RecordsMessage | PlanAckMessage;

// ── Connection ───────────────────────────────────────────────────────────────

// One agent's server-side endpoint, made at config load and kept for the process; the link under it comes and goes.
export class AgentConnection implements TransportConnection {
  readonly agent_id: string;
  host: string;
  hostname: string | null = null;
  version: string | null = null;
  capabilities: string[] = [];
  // The agent's code version, which must match the server's before it is handed monitors to run.
  code = "";
  // Set by the `agents:` entry's run_monitors: the agent runs its host's monitors itself.
  run_monitors = false;
  connected_at: number | null = null;
  link: AgentLink | null = null;
  private readonly stream_specs = new Map<string, StreamSpec>();

  constructor(agent_id: string, host: string) {
    this.agent_id = agent_id;
    this.host = host;
  }

  // ── Liveness ───────────────────────────────────────────────────────────

  get is_connected(): boolean {
    return this.link !== null && this.link.is_open;
  }

  // Binds a freshly logged-in link; a second login for the same id replaces the first, whose socket is assumed dead.
  attach(link: AgentLink, hello: { hostname?: string | null; version?: string | null } = {}): void {
    if (this.link !== null && this.link !== link) {
      log.warn(`agent ${python_repr(this.agent_id)}: replacing an existing connection (the previous socket is assumed dead)`);
    }
    this.link = link;
    this.hostname = hello.hostname ?? null;
    this.version = hello.version ?? null;
    this.capabilities = [];
    this.code = "";
    this.connected_at = Date.now() / 1000;
    log.info(`agent ${python_repr(this.agent_id)} connected from ${this.hostname || this.host} (version ${this.version || "unknown"})`);
  }

  // Takes the capabilities message an agent sends once logged in: what it can do and the code it runs.
  absorb_capabilities(message: Record<string, unknown>): void {
    if (typeof message.hostname === "string" && message.hostname) this.hostname = message.hostname;
    if (typeof message.version === "string" && message.version) this.version = message.version;
    this.capabilities = Array.isArray(message.caps) ? message.caps.map(String) : [];
    this.code = String(message.code || "");
    // Only an agent set to run its host's monitors needs the server's code; for the rest it changes nothing.
    if (this.run_monitors && !this.same_code) {
      log.warn(`agent ${python_repr(this.agent_id)} runs different X-Monitor code (${this.code || "unknown"}, server ${code_version()}), so its monitors stay on the server until it is updated`);
    }
  }

  // Whether the agent runs exactly the server's code, which handing it monitors requires.
  get same_code(): boolean {
    return Boolean(this.code) && this.code === code_version();
  }

  // Drops the link if it is still the current one, so a slow teardown of a replaced link leaves its successor alone.
  detach(link: AgentLink | null = this.link): void {
    if (this.link !== link || link === null) return;
    this.link = null;
    this.connected_at = null;
    log.info(`agent ${python_repr(this.agent_id)} disconnected`);
  }

  // ── Monitors the agent runs itself ─────────────────────────────────────

  // Whether this agent may be handed monitors now: configured to, connected, able to, and on the server's code.
  get runs_engine(): boolean {
    return this.run_monitors && this.is_connected && this.capabilities.includes(ENGINE_CAPABILITY) && this.same_code;
  }

  async send_plan(version: string, config: Record<string, unknown>): Promise<void> {
    this.send({ type: "plan", version, config });
  }

  async ack_records(through: number): Promise<void> {
    this.send({ type: "records_ack", through });
  }

  async poll_now(monitor_id: string): Promise<void> {
    this.send({ type: "poll_now", monitor: monitor_id });
  }

  // Runs an action on a monitor the agent runs, returning success and the metadata it reported; never throws.
  async request_action(monitor_id: string, action_id: string, args: Record<string, unknown>, timeout: number): Promise<[boolean, Record<string, string>]> {
    const link = this.link;
    if (link === null || !link.is_open) return [false, { content: `Agent ${python_repr(this.agent_id)} is not connected, so the action cannot reach it` }];
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeout * 1000);
    });
    try {
      const reply = await Promise.race([link.request("monitor_action", { monitor: monitor_id, action: action_id, args }), expired]);
      if (reply === "timeout") return [false, { content: `Agent ${python_repr(this.agent_id)} did not answer within ${Math.round(timeout)}s` }];
      const answer = (reply ?? {}) as Partial<MonitorActionReply>;
      const metadata = typeof answer.metadata === "object" && answer.metadata !== null ? answer.metadata : {};
      return [Boolean(answer.success), Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)]))];
    } catch (error) {
      return [false, { content: `Could not send the action to agent ${python_repr(this.agent_id)}: ${(error as Error).message}` }];
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────

  // Runs one command on the agent's host; any transport failure or timeout maps to (-1, "", message), as over SSH.
  async execute(command: string, timeout: number | null = EXEC_TIMEOUT): Promise<[number, string, string]> {
    const link = this.link;
    if (link === null || !link.is_open) return [-1, "", `Agent ${python_repr(this.agent_id)} is not connected`];
    try {
      const result = await link.run(command, { timeout_in_seconds: timeout ?? EXEC_TIMEOUT });
      return [result.exit_code, result.stdout, result.stderr];
    } catch (error) {
      return [-1, "", `Agent send failed: ${(error as Error).message}`];
    }
  }

  private send(message: ServerAppMessage): void {
    const link = this.link;
    if (link === null || !link.is_open) throw new Error("not connected");
    link.send(message as unknown as AppMessage);
  }

  // ── Desktop notifications ──────────────────────────────────────────────

  // Asks the agent to show a desktop notification, throwing when it cannot be handed over.
  async notify(title: string, body: string, options: { urgency?: NotifyMessage["urgency"]; url?: string | null; icon?: string | null; key?: string | null; timeout?: number } = {}): Promise<void> {
    this.require(NOTIFY_CAPABILITY, "desktop notifications");
    const message: NotifyMessage = { type: "notify", title, body, urgency: options.urgency ?? "normal" };
    if (options.url) message.url = options.url;
    if (options.icon) message.icon = options.icon;
    if (options.key) message.key = options.key;
    if (options.timeout) message.timeout = options.timeout;
    this.send(message);
  }

  // Asks the agent to close the desktop notification it shows for `key`.
  async dismiss(key: string): Promise<void> {
    this.require(DISMISS_CAPABILITY, "dismissing notifications");
    this.send({ type: "dismiss", key });
  }

  // Asks the agent to hold its host awake under `key`, or let it go; an absent or older agent is skipped.
  async inhibit(key: string, hold: boolean): Promise<void> {
    if (!this.is_connected || !this.capabilities.includes(INHIBIT_CAPABILITY)) return;
    try {
      this.send({ type: "inhibit", key, hold });
    } catch (error) {
      // A dropped socket releases every hold on the agent's side, so a lost release needs no retry.
      log.debug(`agent ${python_repr(this.agent_id)}: could not send inhibit for ${python_repr(key)}: ${(error as Error).message}`);
    }
  }

  private require(capability: string, what: string): void {
    if (!this.is_connected) throw new Error(`agent ${python_repr(this.agent_id)} is not connected`);
    if (!this.capabilities.includes(capability)) throw new Error(`agent ${python_repr(this.agent_id)} does not support ${what} (upgrade it)`);
  }

  // ── Event streams ──────────────────────────────────────────────────────

  register_stream(spec: StreamSpec): void {
    this.stream_specs.set(spec.id, spec);
  }

  unregister_stream(stream_id: string): void {
    this.stream_specs.delete(stream_id);
  }

  get streams(): StreamSpec[] {
    return [...this.stream_specs.values()];
  }

  // Sends the agent its whole stream set, never a delta, so a reconnecting agent converges without the server tracking
  // what it already knows.
  async push_subscriptions(): Promise<void> {
    if (!this.is_connected) return;
    // A dying socket here is tolerable; the agent gets the full set again on reconnect.
    try {
      this.send({ type: "subscribe", streams: this.streams.map((spec) => ({ id: spec.id, kind: spec.kind, params: { ...spec.params } })) });
    } catch (error) {
      log.warn(`agent ${python_repr(this.agent_id)}: could not send subscriptions: ${(error as Error).message}`);
    }
  }

  // Matches SSHConnection.close(), so the Connector Engine tears either transport down the same way.
  close(): void {
    const link = this.link;
    this.link = null;
    this.connected_at = null;
    if (link !== null && link.is_open) link.close(1001, "X-Monitor is shutting down");
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

export type EventSink = (agent_id: string, stream_id: string, timestamp: number, payload: Record<string, unknown>) => void;
export type ConnectSink = (agent_id: string) => void;
export type SyncSink = (agent_id: string, message: SyncMessage) => Promise<void>;

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every configured agent, the hub they log in through, and the routing of what they send.
export class AgentRegistry {
  readonly hub: AgentHub<string>;
  private readonly agents = new Map<string, AgentConnection>();
  private readonly public_keys = new Map<string, string>();
  private event_sink: EventSink | null = null;
  private connect_sink: ConnectSink | null = null;
  private sync_sink: SyncSink | null = null;

  constructor(hub_options: Partial<HubOptions<string>> = {}) {
    this.hub = new AgentHub<string>({ ...hub_options, app: agent_app, on_message: (host, message) => this.on_message(host, message) });
    this.hub.on("connect", (status) => this.on_connect(status));
    this.hub.on("disconnect", (host) => this.agents.get(host)?.detach());
  }

  // Builds the connections from the `agents:` list. Called again on a reload, it keeps each existing agent's
  // connection, so monitors wired to it stay wired, and an agent dropped from the list loses its key.
  configure(agents_config: Record<string, unknown>[] | null | undefined): void {
    const declared = new Set<string>();
    for (const entry of agents_config ?? []) {
      const raw_id = entry.id || entry.name;
      if (!raw_id) {
        log.error(`agents: entry with no \`id\` ignored: ${python_repr(entry)}`);
        continue;
      }
      const agent_id = String(raw_id);
      declared.add(agent_id);
      const public_key = AgentRegistry.parse_public_key(agent_id, entry);
      if (public_key === null) {
        this.public_keys.delete(agent_id);
        log.error(`agent ${python_repr(agent_id)} has no usable public_key and will refuse every connection`);
      } else {
        this.public_keys.set(agent_id, public_key);
      }
      const host = String(entry.host || agent_id);
      let conn = this.agents.get(agent_id);
      if (conn === undefined) {
        conn = new AgentConnection(agent_id, host);
        this.agents.set(agent_id, conn);
        log.info(`Registered agent ${python_repr(agent_id)}`);
      }
      conn.host = host;
      conn.run_monitors = Boolean(entry.run_monitors ?? false);
    }
    for (const agent_id of [...this.public_keys.keys()].filter((id) => !declared.has(id)).sort()) {
      this.public_keys.delete(agent_id);
      log.warn(`agent ${python_repr(agent_id)} is no longer configured and can no longer connect`);
    }
    this.hub.set_agent_keys(new Map(this.public_keys));
  }

  // The entry's `public_key`, an OpenSSH ed25519 line, or null when absent or unreadable.
  private static parse_public_key(agent_id: string, entry: Record<string, unknown>): string | null {
    const line = entry.public_key;
    if (!line) return null;
    try {
      parse_public_key(String(line));
      return String(line).trim();
    } catch (error) {
      log.error(`agent ${python_repr(agent_id)}: could not parse public_key: ${(error as Error).message}`);
      return null;
    }
  }

  get(agent_id: string): AgentConnection | null {
    return this.agents.get(agent_id) ?? null;
  }

  // The named agent's connection, made as a placeholder for an id missing from `agents:`, which shows as a failing
  // monitor with a clear message rather than a crash.
  require(agent_id: string): AgentConnection {
    let conn = this.agents.get(agent_id);
    if (conn === undefined) {
      log.error(`Monitor references agent ${python_repr(agent_id)}, which is not declared in the top-level \`agents:\` config — it can never connect`);
      conn = new AgentConnection(agent_id, agent_id);
      this.agents.set(agent_id, conn);
    }
    return conn;
  }

  public_key_for(agent_id: string): string | null {
    return this.public_keys.get(agent_id) ?? null;
  }

  get all(): AgentConnection[] {
    return [...this.agents.values()];
  }

  // ── Hub ────────────────────────────────────────────────────────────────

  private on_connect(status: AgentStatus): void {
    const link = this.hub.agent(status.host) as HubConnection<string> | null;
    if (link === null) return;
    const conn = this.require(status.host);
    conn.attach(link, { hostname: status.reported_host, version: status.agent_version });
    void conn.push_subscriptions();
  }

  private on_message(host: string, message: AppMessage): void {
    const conn = this.agents.get(host);
    switch (message.type) {
      case "capabilities":
        if (conn === undefined) return;
        conn.absorb_capabilities(message);
        // Only now does the server know what the agent can do, so this is when its monitors can collect.
        this.notify_connected(host);
        return;
      case "event": {
        const payload = message.payload;
        this.dispatch_event(host, String(message.stream || ""), Number(message.ts) || Date.now() / 1000, is_record(payload) ? payload : {});
        return;
      }
      case "records":
      case "plan_ack":
        void this.dispatch_sync(host, message as unknown as SyncMessage);
        return;
      default:
        // A newer agent may send messages this server does not know, which must not break the link.
        return;
    }
  }

  // ── Sinks ──────────────────────────────────────────────────────────────

  // Installs the callback inbound events go to, as (agent id, stream id, epoch seconds, payload).
  set_event_sink(sink: EventSink): void {
    this.event_sink = sink;
  }

  // Installs the callback fired once an agent has logged in and said what it can do, so the engine re-runs the
  // monitors whose first cycle landed before the agent dialled in.
  set_connect_sink(sink: ConnectSink): void {
    this.connect_sink = sink;
  }

  notify_connected(agent_id: string): void {
    if (this.connect_sink === null) return;
    // The engine's connect handler must not break the agent's link.
    try {
      this.connect_sink(agent_id);
    } catch (error) {
      log.error(`agent ${python_repr(agent_id)}: connect handler failed: ${(error as Error).message}`);
    }
  }

  // Installs what an agent's records and plan acknowledgements go to.
  set_sync_sink(sink: SyncSink): void {
    this.sync_sink = sink;
  }

  async dispatch_sync(agent_id: string, message: SyncMessage): Promise<void> {
    if (this.sync_sink === null) return;
    try {
      await this.sync_sink(agent_id, message);
    } catch (error) {
      log.error(`agent ${python_repr(agent_id)}: could not handle ${python_repr(message.type)}: ${(error as Error).message}`);
    }
  }

  dispatch_event(agent_id: string, stream_id: string, timestamp: number, payload: Record<string, unknown>): void {
    if (this.event_sink === null) return;
    try {
      this.event_sink(agent_id, stream_id, timestamp, payload);
    } catch (error) {
      log.error(`agent ${python_repr(agent_id)}: event handler failed for stream ${python_repr(stream_id)}: ${(error as Error).message}`);
    }
  }

  close(): void {
    for (const conn of this.agents.values()) conn.close();
    this.hub.close();
  }
}

export { stream_from_wire };
