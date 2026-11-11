// The agent: dials the server through X-Libs' agent client, runs the commands it is sent through a shell runner that
// holds the host awake while they run, and carries X-Monitor's own messages beside them: the event streams the server
// subscribes to, desktop notifications, the server's holds on the host, and the monitors it runs itself with their
// outbox. Only the X-Libs client reconnects; everything here survives a dropped connection.

import { hostname as system_hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { AppMessage } from "@x-tech-laboratories/x-libs/agent/protocol";
import type { AgentSession } from "@x-tech-laboratories/x-libs/agent/session";
import { shell_runner, type TaskRunner } from "@x-tech-laboratories/x-libs/agent/tasks";
import { start_agent, type RunningAgent } from "@x-tech-laboratories/x-libs/agent/client";

import { create_logger_for } from "../core/logging.ts";
import { agent_app, ENGINE_CAPABILITY, stream_from_wire, type CapabilitiesMessage } from "../shared/agent_protocol.ts";
import type { AgentConfig } from "./config.ts";
import { Notifier } from "./desktop.ts";
import { IdleInhibitor } from "./inhibit.ts";
import { LocalRunner } from "./local.ts";
import { follow, LocalNotifier, OfflineAlerts } from "./local_notify.ts";
import { supervise, WATCHERS, type StreamEvent } from "./watchers.ts";

const log = create_logger_for("x_monitor_agent.client");

export const AGENT_VERSION = "0.2.0";

export const NOTIFY = "notify";
export const DISMISS = "dismiss";
export const INHIBIT = "inhibit";

// What this agent can do, sent once logged in, so a server can tell an older agent from a newer one.
export const CAPABILITIES = [...Object.keys(WATCHERS), NOTIFY, DISMISS, INHIBIT].sort();

// How long the outbox pump waits before looking for new records when it found none.
export const PUMP_IDLE_SECONDS = 1.0;

// The answer a notify-only agent gives every command.
export const NOTIFY_ONLY_REFUSAL = "This agent only shows notifications; it runs no commands";

// ── Runner ───────────────────────────────────────────────────────────────────

// A shell runner that holds the host awake while each command runs, or refuses every command on a notify-only agent.
export function agent_runner(inhibitor: IdleInhibitor, notify_only: boolean, base: TaskRunner<string> = shell_runner("x-monitor-agent")): TaskRunner<string> {
  if (notify_only) {
    return {
      run: async () => ({ exit_code: -1, stdout: "", stderr: NOTIFY_ONLY_REFUSAL }),
      launch: () => { throw new Error(NOTIFY_ONLY_REFUSAL); },
    };
  }
  return { ...base, run: (task, options) => inhibitor.held(() => base.run(task, options)) };
}

// ── Agent ────────────────────────────────────────────────────────────────────

export class XMonitorAgent {
  readonly config: AgentConfig;
  readonly hostname: string;
  readonly desktop: Notifier;
  inhibitor: IdleInhibitor;
  readonly runner: LocalRunner | null;
  readonly streams = new Map<string, AbortController>();
  readonly server_holds = new Set<string>();
  private running: RunningAgent<string> | null = null;
  private stops: (() => void)[] = [];
  private pump: AbortController | null = null;

  constructor(config: AgentConfig, options: { desktop?: Notifier; inhibitor?: IdleInhibitor; runner?: LocalRunner | null } = {}) {
    this.config = config;
    this.hostname = config.hostname ?? system_hostname();
    // Kept across reconnects, so a notification can still be clicked or dismissed after a network drop.
    this.desktop = options.desktop ?? new Notifier();
    this.inhibitor = options.inhibitor ?? new IdleInhibitor();
    // The monitors this agent runs itself, which keep running whether or not it is connected.
    this.runner = options.runner !== undefined ? options.runner : config.state_dir && !config.notify_only ? new LocalRunner(config.agent_id, config.state_dir) : null;
  }

  // The capabilities message sent once the hello has gone.
  capabilities(code = ""): CapabilitiesMessage {
    let caps = this.config.notify_only ? [DISMISS, NOTIFY] : [...CAPABILITIES];
    if (this.runner !== null) caps = [...caps, ENGINE_CAPABILITY].sort();
    return { type: "capabilities", hostname: this.hostname, version: AGENT_VERSION, caps, code };
  }

  // Starts the local monitors and notifications, then dials the server and keeps dialling.
  async start(): Promise<void> {
    await this.runner?.start();
    this.stops = await this.start_local_notifications();
    this.running = start_agent<string>({
      app: agent_app,
      runner: agent_runner(this.inhibitor, this.config.notify_only),
      url: this.config.url,
      key_file: this.config.key_file,
      state_directory: this.config.state_dir ?? join(tmpdir(), `x-monitor-agent-${this.config.agent_id}`),
      host: this.config.agent_id,
      agent_version: AGENT_VERSION,
      log: (line) => log.info(line),
      on_hello: (session) => this.on_hello(session),
      on_message: (message) => void this.on_message(message),
      requests: { monitor_action: (message) => this.monitor_action(message) },
    });
  }

  async stop(): Promise<void> {
    for (const stop of this.stops) stop();
    this.stops = [];
    this.stop_streams();
    this.pump?.abort();
    await this.running?.stop();
    await this.runner?.stop();
    await this.inhibitor.close();
    this.desktop.cancel_all();
  }

  // ── Session ────────────────────────────────────────────────────────────────

  private send(message: AppMessage): void {
    const session = this.running?.session() ?? null;
    if (session === null) throw new Error("not connected");
    session.send(message);
  }

  private on_hello(session: AgentSession<string>): void {
    log.info(`connected to ${this.config.url} as '${this.config.agent_id}'`);
    session.send(this.capabilities() as unknown as AppMessage);
    if (this.runner !== null) {
      session.send({ type: "plan_ack", version: this.runner.plan_version });
      this.start_pump(session);
    }
  }

  // Sends the outbox to the server for as long as this session lasts, oldest first, from the first unacknowledged record.
  private start_pump(session: AgentSession<string>): void {
    this.pump?.abort();
    const controller = new AbortController();
    this.pump = controller;
    void (async () => {
      let sent = 0;
      while (!controller.signal.aborted && this.running?.session() === session) {
        const batch = await this.runner!.pending(sent);
        if (batch.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, PUMP_IDLE_SECONDS * 1000));
          continue;
        }
        session.send({ type: "records", records: batch });
        sent = batch.at(-1)![0];
      }
      // A lost session leaves whatever it was given to the next one, its streams and the server's holds with it.
      if (this.running?.session() !== session) this.disconnected();
    })().catch((error: unknown) => log.warn(`record pump stopped: ${(error as Error).message}`));
  }

  // Server messages that are not requests.
  async on_message(message: AppMessage): Promise<void> {
    const type = message.type;
    if (type === NOTIFY) await this.desktop.show(message);
    else if (type === DISMISS) await this.desktop.dismiss(message);
    else if (type === "subscribe" && !this.config.notify_only) this.apply_streams(Array.isArray(message.streams) ? message.streams : []);
    else if (type === INHIBIT && !this.config.notify_only) await this.apply_server_hold(message);
    else if (this.runner !== null && (type === "plan" || type === "records_ack" || type === "poll_now")) await this.handle_engine_message(message);
  }

  // One of the server's messages about the monitors this agent runs itself; a failure is logged and the agent carries on.
  private async handle_engine_message(message: AppMessage): Promise<void> {
    try {
      if (message.type === "plan") {
        const config = message.config;
        await this.runner!.apply_plan(String(message.version ?? ""), typeof config === "object" && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>) : {});
        this.send({ type: "plan_ack", version: this.runner!.plan_version });
      } else if (message.type === "records_ack") {
        this.runner!.acknowledge(Math.trunc(Number(message.through ?? 0)));
      } else if (message.type === "poll_now") {
        await this.runner!.poll_now(String(message.monitor ?? ""));
      }
    } catch (error) {
      log.warn(`could not handle '${message.type}' from the server: ${(error as Error).message}`);
    }
  }

  // Runs an action on one of the agent's own monitors, answering with its outcome and metadata.
  async monitor_action(message: AppMessage): Promise<{ success: boolean; metadata: Record<string, string> }> {
    if (this.runner === null) return { success: false, metadata: { content: "This agent runs no monitors" } };
    const args = typeof message.args === "object" && message.args !== null && !Array.isArray(message.args) ? (message.args as Record<string, unknown>) : {};
    const [success, metadata] = await this.runner.run_action(String(message.id ?? ""), String(message.monitor ?? ""), String(message.action ?? ""), args);
    return { success, metadata };
  }

  // ── Server holds ───────────────────────────────────────────────────────────

  // Takes or drops the idle inhibitor for a task the server runs against this host from elsewhere.
  async apply_server_hold(message: Record<string, unknown>): Promise<void> {
    const key = String(message.key ?? "");
    if (!key) return;
    if (message.hold) {
      if (this.server_holds.has(key)) return;
      this.server_holds.add(key);
      await this.inhibitor.acquire();
    } else if (this.server_holds.delete(key)) {
      this.inhibitor.release();
    }
  }

  // Drops every hold the server took, since a lost connection can no longer release them.
  release_server_holds(): void {
    for (let index = 0; index < this.server_holds.size; index += 1) this.inhibitor.release();
    this.server_holds.clear();
  }

  // What a lost connection ends: its streams and the server's holds.
  disconnected(): void {
    this.stop_streams();
    this.release_server_holds();
  }

  // ── Streams ────────────────────────────────────────────────────────────────

  // Converges on the server's subscription set: stops what is gone, starts what is new, and leaves unchanged streams
  // running so a reconnect does not restart a healthy journal follow.
  apply_streams(raw_streams: unknown[]): void {
    const wanted = new Map(raw_streams.map(stream_from_wire).filter((spec) => spec !== null).map((spec) => [spec.id, spec]));
    for (const stream_id of this.streams.keys()) if (!wanted.has(stream_id)) this.cancel_stream(stream_id);
    for (const [stream_id, spec] of wanted) {
      if (this.streams.has(stream_id)) continue;
      const controller = new AbortController();
      this.streams.set(stream_id, controller);
      void supervise(spec.kind, spec.id, spec.params, (event) => this.emit_event(event), controller.signal);
      log.info(`watching stream '${stream_id}' (${spec.kind})`);
    }
  }

  private async emit_event(event: StreamEvent): Promise<void> {
    this.send({ type: "event", stream: event.stream, ts: event.ts, payload: event.payload });
  }

  private cancel_stream(stream_id: string): void {
    const controller = this.streams.get(stream_id);
    if (controller === undefined) return;
    this.streams.delete(stream_id);
    controller.abort();
    log.info(`stopped watching stream '${stream_id}'`);
  }

  stop_streams(): void {
    for (const stream_id of this.streams.keys()) this.cancel_stream(stream_id);
  }

  // ── Local notifications ────────────────────────────────────────────────────

  // Serves this agent's own notifications on the local socket, or follows it from a desktop agent; returns what stops it.
  private async start_local_notifications(): Promise<(() => void)[]> {
    const socket_path = this.config.local_socket;
    if (!socket_path) return [];
    if (this.config.notify_only) {
      const controller = new AbortController();
      void follow(socket_path, (frame) => (frame.type === NOTIFY ? this.desktop.show(frame) : this.desktop.dismiss(frame)), controller.signal);
      return [() => controller.abort()];
    }
    if (this.runner === null) return [];
    const notifier = new LocalNotifier(socket_path);
    try {
      await notifier.start();
    } catch (error) {
      log.warn(`cannot serve local notifications on ${socket_path}: ${(error as Error).message}`);
      return [];
    }
    const alerts = new OfflineAlerts(notifier, () => this.runner?.engine ?? null, () => this.running?.connected() ?? false, this.config.agent_id);
    return [alerts.start(), () => notifier.close()];
  }
}
