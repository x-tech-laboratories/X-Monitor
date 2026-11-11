// The data a monitor and the Connector Engine exchange: the requests a monitor declares, the results that come back,
// the CollectResult a monitor turns them into, and the plans an action makes.
//
// A monitor declares one cycle's IO as a list of requests; the Connector Engine routes each to its connector (a
// command to SSH or the agent, the rest to HTTP, DNS or ICMP) and hands back results in the same order. Each kind is
// told apart by its `kind` field, where the Python app used isinstance.

import type { LogLevel, Status } from "../../shared/status.ts";

// ── Requests ─────────────────────────────────────────────────────────────────

export interface Command {
  readonly kind: "command";
  readonly text: string;
  readonly timeout: number | null;
  readonly action: boolean;
  // Run on this agent instead of the monitor's own target, such as a heavy evaluation offloaded to a bigger host.
  readonly agent: string | null;
}

export function command(text: string, options: { timeout?: number | null; action?: boolean; agent?: string | null } = {}): Command {
  return { kind: "command", text, timeout: options.timeout ?? null, action: options.action ?? false, agent: options.agent ?? null };
}

export interface HttpRequest {
  readonly kind: "http";
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>> | null;
  readonly body: string | null;
  readonly timeout: number | null;
  // HTTP Basic credentials, applied by the connector.
  readonly auth: readonly [user: string, password: string] | null;
  // Case-insensitive body prefixes that mean success, such as a DDNS provider's "good"; empty lets the status decide.
  readonly ok_prefixes: readonly string[];
}

export function http_request(url: string, options: Partial<Omit<HttpRequest, "kind" | "url">> = {}): HttpRequest {
  return {
    kind: "http", url, method: options.method ?? "GET", headers: options.headers ?? null, body: options.body ?? null,
    timeout: options.timeout ?? null, auth: options.auth ?? null, ok_prefixes: options.ok_prefixes ?? [],
  };
}

export interface DnsQuery {
  readonly kind: "dns";
  readonly domain: string;
  readonly record_type: string;
  readonly resolver: string | null;
  readonly port: number;
  readonly timeout: number;
}

export function dns_query(domain: string, options: Partial<Omit<DnsQuery, "kind" | "domain">> = {}): DnsQuery {
  return {
    kind: "dns", domain, record_type: options.record_type ?? "A", resolver: options.resolver ?? null,
    port: options.port ?? 53, timeout: options.timeout ?? 5,
  };
}

export interface PingRequest {
  readonly kind: "ping";
  readonly host: string;
  readonly count: number;
  readonly timeout: number;
}

export function ping_request(host: string, options: { count?: number; timeout?: number } = {}): PingRequest {
  return { kind: "ping", host, count: options.count ?? 1, timeout: options.timeout ?? 2 };
}

export type Request = Command | HttpRequest | DnsQuery | PingRequest;

// ── Results ──────────────────────────────────────────────────────────────────

// A command's outcome; exit code -1 means the transport failed before the command ran.
export interface CmdResult {
  readonly kind: "cmd";
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function cmd_result(exit_code: number, stdout = "", stderr = ""): CmdResult {
  return { kind: "cmd", exit_code, stdout, stderr };
}

export interface HttpResult {
  readonly kind: "http";
  // Null on a transport error, when nothing came back.
  readonly status_code: number | null;
  readonly text: string;
  readonly error: string | null;
  // Wall-clock time the request took; 0 on a transport error.
  readonly elapsed_ms: number;
  // Response headers with lower-case names; empty on a transport error.
  readonly headers: Readonly<Record<string, string>>;
}

export function http_result(status_code: number | null, text: string, options: { error?: string | null; elapsed_ms?: number; headers?: Record<string, string> } = {}): HttpResult {
  return { kind: "http", status_code, text, error: options.error ?? null, elapsed_ms: options.elapsed_ms ?? 0, headers: options.headers ?? {} };
}

// One answer record as node:dns resolves it: a string for A, AAAA, CNAME, NS and PTR, `{ exchange, priority }` for
// MX, the chunks of one TXT record as string[], and node's objects for SOA, SRV and CAA.
export type DnsRecordValue = string | string[] | Record<string, unknown>;

export interface DnsAnswer {
  readonly record_type: string;
  readonly records: readonly DnsRecordValue[];
  // The smallest TTL of the answer's records, when the resolver gave one.
  readonly ttl: number | null;
}

export type DnsResultKind = "ok" | "nxdomain" | "no_answer" | "timeout" | "dns_error";

export interface DnsResult {
  readonly kind: "dns";
  readonly outcome: DnsResultKind;
  // The answer on "ok", null otherwise.
  readonly answer: DnsAnswer | null;
  readonly error: string | null;
}

export function dns_result(outcome: DnsResultKind, answer: DnsAnswer | null = null, error: string | null = null): DnsResult {
  return { kind: "dns", outcome, answer, error };
}

export interface PingResult {
  readonly kind: "ping";
  // Set when ping could not be run at all.
  readonly exception: string | null;
  readonly returncode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function ping_result(exception: string | null, returncode: number | null, stdout = "", stderr = ""): PingResult {
  return { kind: "ping", exception, returncode, stdout, stderr };
}

export type Result = CmdResult | HttpResult | DnsResult | PingResult;

// Whether a result says the transport failed before anything was measured.
export function unreachable(result: unknown): boolean {
  if (typeof result !== "object" || result === null || !("kind" in result)) return false;
  const typed = result as Result;
  switch (typed.kind) {
    case "cmd":
      return typed.exit_code === -1;
    case "http":
      return typed.status_code === null;
    case "dns":
      return typed.outcome === "timeout" || typed.outcome === "dns_error";
    case "ping":
      return typed.exception !== null;
  }
}

// ── Collect result ───────────────────────────────────────────────────────────

export type LogEntry = [message: string, level: LogLevel | string];
export type LogLineEntry = [message: string, level: LogLevel | string, log_time: string | null];

export interface CollectResultFields {
  metrics?: Record<string, number>;
  metadata?: Record<string, string>;
  logs?: LogEntry[];
  log_lines?: LogLineEntry[];
  status?: Status | string | null;
  snapshot?: unknown;
  settings?: Record<string, string>;
  // When it was observed; null means now. An agent's records synced after an offline stretch carry their own time.
  timestamp?: Date | null;
  // Read only when an action returns it, as the action's outcome.
  success?: boolean;
}

// Everything one cycle or action has to persist; the engine writes it.
export class CollectResult {
  metrics: Record<string, number>;
  metadata: Record<string, string>;
  logs: LogEntry[];
  log_lines: LogLineEntry[];
  status: Status | string | null;
  snapshot: unknown;
  settings: Record<string, string>;
  timestamp: Date | null;
  success: boolean;

  constructor(fields: CollectResultFields = {}) {
    this.metrics = fields.metrics ?? {};
    this.metadata = fields.metadata ?? {};
    this.logs = fields.logs ?? [];
    this.log_lines = fields.log_lines ?? [];
    this.status = fields.status ?? null;
    this.snapshot = fields.snapshot ?? null;
    this.settings = fields.settings ?? {};
    this.timestamp = fields.timestamp ?? null;
    this.success = fields.success ?? false;
  }

  static failed(message: string, level: LogLevel | string = "ERROR", status: Status | string = "failed"): CollectResult {
    return new CollectResult({ logs: [[message, level]], status });
  }

  // The host could not be reached or the data could not be gathered, so nothing was measured.
  static unavailable(message: string, level: LogLevel | string = "WARNING"): CollectResult {
    return new CollectResult({ logs: [[message, level]], status: "unavailable" });
  }
}

export function is_collect_result(value: unknown): value is CollectResult {
  return value instanceof CollectResult;
}

// ── Action plans ─────────────────────────────────────────────────────────────

export interface ActionPlan {
  readonly kind: "action_plan";
  readonly command: string;
  readonly timeout: number | null;
  // Run on this other monitor's transport, such as a wake packet sent from inside another subnet.
  readonly via: string | null;
  // Run on this agent instead of the monitor's own target.
  readonly agent: string | null;
  // Launch as a detached job the engine follows to its end; the timeout then bounds the whole run.
  readonly detached: boolean;
}

export function action_plan(command_text: string, options: { timeout?: number | null; via?: string | null; agent?: string | null; detached?: boolean } = {}): ActionPlan {
  return {
    kind: "action_plan", command: command_text, timeout: options.timeout ?? null, via: options.via ?? null,
    agent: options.agent ?? null, detached: options.detached ?? false,
  };
}

// Sequential local IO a single request cannot express; the engine runs `call` and hands its value to interpret_action.
export interface IoActionPlan {
  readonly kind: "io_action";
  readonly call: () => unknown;
}

export function io_action_plan(call: () => unknown): IoActionPlan {
  return { kind: "io_action", call };
}

// What plan_action returns: a write with no IO, local IO, a connector request, a command, or null when unhandled.
export type ActionPlanResult = ActionPlan | IoActionPlan | HttpRequest | DnsQuery | PingRequest | CollectResult | null;

// What interpret_action returns: success, or a CollectResult with `success` set that is also written.
export type ActionOutcome = boolean | CollectResult;

// What dispatch_action returns: success and the metadata of the result it applied, if any.
export type DispatchResult = [success: boolean, metadata: Record<string, string> | null];

// ── Timeouts ─────────────────────────────────────────────────────────────────

// Seconds a cycle's command may take, unless the monitor sets its own `timeout`.
export const COLLECT_TIMEOUT = 30.0;
// Seconds an action's command may take.
export const CONTROL_TIMEOUT = 60.0;
// The error prefix of a command that never reached its host, as opposed to one cut off mid-run.
export const CONNECT_FAILED = "Connect failed";
