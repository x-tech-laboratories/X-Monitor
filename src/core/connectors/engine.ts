// The Connector Engine: the one engine for all monitor IO. It owns every connector (SSH, the agents, HTTP, DNS and
// ICMP) and routes a monitor's declared request list to the right one, returning results in the same order.
//
// Commands are per target: each monitor talks to one host with its own collect timeout, captured in an ExecContext
// built once by exec_context() and passed back on each call, so the engine holds no per-monitor state while one
// connection per physical target is reused. An ExecContext wraps whichever transport reaches the target: a pooled SSH
// connection, a connected agent when the monitor names `agent:`, or local processes for an agent's own id.

import type { PluginConfig } from "../../monitors/base/plugin_helpers.ts";
import type { TransportConnection } from "../contracts.ts";
import { AgentConnection, AgentRegistry } from "./agent_connector.ts";
import { DnsConnector } from "./dns_connector.ts";
import { HttpConnector } from "./http_connector.ts";
import { IcmpConnector } from "./icmp_connector.ts";
import { LocalConnection } from "./local_connector.ts";
import { resolve_host, SSHConnection, ssh2_dialer, type SshDialer } from "./ssh_connector.ts";
import { action_plan, cmd_result, COLLECT_TIMEOUT, CONTROL_TIMEOUT, type ActionPlan, type CmdResult, type Request, type Result } from "./types.ts";

// ── Exec context ─────────────────────────────────────────────────────────────

// A monitor's command handle: the connection to its host and that monitor's collect timeout.
export class ExecContext {
  readonly conn: TransportConnection;
  readonly collect_timeout: number;

  constructor(conn: TransportConnection, collect_timeout: number = COLLECT_TIMEOUT) {
    this.conn = conn;
    this.collect_timeout = collect_timeout;
  }

  // The host the transport resolved the config to, which the engine keeps the monitor's labels in step with.
  get target(): string {
    return this.conn.host ?? "";
  }

  get is_agent(): boolean {
    return this.conn instanceof AgentConnection;
  }
}

// What each connector a test may replace looks like.
export interface HttpLike {
  fetch: HttpConnector["fetch"];
  close(): void;
}

export interface DnsLike {
  resolve: DnsConnector["resolve"];
}

export interface IcmpLike {
  ping: IcmpConnector["ping"];
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class ConnectorEngine {
  // On an agent, its own id: commands addressed to it run here as local processes instead of over a socket.
  readonly local_agent: string | null;
  private local: LocalConnection | null = null;
  // One shared SSH connection per physical target (host, port, username, key path), however many monitors use it.
  readonly ssh_conns = new Map<string, SSHConnection>();
  // Every configured agent; the connections live for the process and the socket under them comes and goes.
  readonly agents: AgentRegistry;
  ssh_dialer: SshDialer = ssh2_dialer;
  private http_connector: HttpLike | null = null;
  private dns_connector: DnsLike | null = null;
  private icmp_connector: IcmpLike | null = null;

  constructor(local_agent: string | null = null, agents: AgentRegistry = new AgentRegistry()) {
    this.local_agent = local_agent;
    this.agents = agents;
  }

  // ── Commands ───────────────────────────────────────────────────────────

  // A monitor's command handle for its target: `agent: <id>` goes over that agent, anything else over pooled SSH.
  // Nothing is dialled here; SSH connects on first use and an agent connection waits for the agent to dial in.
  exec_context(config: PluginConfig, collect_timeout: number = COLLECT_TIMEOUT): ExecContext {
    const agent_id = config.agent;
    if (agent_id) return new ExecContext(this.agent_connection(String(agent_id)), collect_timeout);
    const ssh_config = (config.ssh_config ?? {}) as Record<string, unknown>;
    const key = JSON.stringify([resolve_host(config), ssh_config.port || 22, ssh_config.username ?? null, ssh_config.key_path ?? null]);
    let conn = this.ssh_conns.get(key);
    if (conn === undefined) {
      conn = SSHConnection.from_config(config, this.ssh_dialer);
      this.ssh_conns.set(key, conn);
    }
    return new ExecContext(conn, collect_timeout);
  }

  // The connection commands for an agent go through: local for this process's own agent id, else that agent's link.
  agent_connection(agent_id: string): TransportConnection {
    if (this.local_agent !== null && agent_id === this.local_agent) {
      this.local ??= new LocalConnection(agent_id);
      return this.local;
    }
    return this.agents.require(agent_id);
  }

  // Runs one command, falling back to `fallback` seconds when it carries no timeout of its own; both transports map
  // their failures to (-1, "", message) themselves.
  private async command(context: ExecContext, text: string, timeout: number | null, fallback: number): Promise<CmdResult> {
    const [exit_code, stdout, stderr] = await context.conn.execute(text, timeout ?? fallback);
    return cmd_result(exit_code, stdout, stderr);
  }

  // Runs an action's command, with the control timeout unless the plan sets one.
  execute(context: ExecContext, plan: ActionPlan): Promise<CmdResult> {
    return this.command(context, plan.command, plan.timeout, CONTROL_TIMEOUT);
  }

  // Runs a one-off command no action models, such as cancelling a detached job.
  execute_raw(context: ExecContext, command: string, timeout: number | null = null): Promise<CmdResult> {
    return this.execute(context, action_plan(command, { timeout }));
  }

  // Closes every pooled SSH connection no live handle uses any more, returning how many closed.
  close_unused(live: Iterable<TransportConnection>): number {
    const keep = new Set(live);
    const unused = [...this.ssh_conns].filter(([, conn]) => !keep.has(conn));
    for (const [key, conn] of unused) {
      this.ssh_conns.delete(key);
      conn.close();
    }
    return unused.length;
  }

  close_ssh(): void {
    for (const conn of this.ssh_conns.values()) conn.close();
    this.ssh_conns.clear();
    this.agents.close();
  }

  // ── HTTP, DNS and ICMP ─────────────────────────────────────────────────

  get http(): HttpLike {
    this.http_connector ??= new HttpConnector();
    return this.http_connector;
  }

  set http(connector: HttpLike) {
    this.http_connector = connector;
  }

  get dns(): DnsLike {
    this.dns_connector ??= new DnsConnector();
    return this.dns_connector;
  }

  set dns(connector: DnsLike) {
    this.dns_connector = connector;
  }

  get icmp(): IcmpLike {
    this.icmp_connector ??= new IcmpConnector();
    return this.icmp_connector;
  }

  set icmp(connector: IcmpLike) {
    this.icmp_connector = connector;
  }

  // ── Routing ────────────────────────────────────────────────────────────

  // Routes each request to its connector, in order, so parse_results() matches results by position; `context` is the
  // monitor's command handle, needed only for commands.
  dispatch(context: ExecContext | null, requests: readonly Request[]): Promise<Result[]> {
    const one = async (request: Request): Promise<Result> => {
      switch (request.kind) {
        case "command": {
          let handle = context;
          if (request.agent) {
            // An offloaded command keeps the same timeout policy on another agent's connection.
            handle = new ExecContext(this.agent_connection(request.agent), context?.collect_timeout ?? COLLECT_TIMEOUT);
          }
          if (handle === null) throw new TypeError("A command needs the monitor's exec context");
          const fallback = request.action ? CONTROL_TIMEOUT : handle.collect_timeout;
          return this.command(handle, request.text, request.timeout, fallback);
        }
        case "http":
          return this.http.fetch(request);
        case "dns":
          return this.dns.resolve(request);
        case "ping":
          return this.icmp.ping(request);
        default:
          throw new TypeError(`Unroutable request kind: ${(request as { kind?: string }).kind}`);
      }
    };
    return Promise.all(requests.map(one));
  }

  close(): void {
    this.http_connector?.close();
    this.close_ssh();
  }
}
