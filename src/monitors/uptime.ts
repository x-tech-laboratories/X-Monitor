// Basic host reachability: one ICMP ping request through the ping connector each cycle, with latency parsed out of the
// reply. The shared ssh_config/target_host setting names the host to ping. A reply is online; no reply or a ping
// execution error is failed, with no warning tier.
//
// With `mac:` set it also offers a Wake action that sends a Wake-on-LAN magic packet: broadcast from the X-Monitor
// server by default (wol_broadcast, wol_port, wol_password), or with wake_via from another monitor's host, for a
// machine on a subnet only that host reaches (wake_command overrides how it is sent there). wake_on_down sends one
// automatically when the host goes down, every wake_retry, up to wake_max_attempts times until the host is seen up.

import { default_broadcast, default_port, magic_packet, remote_send_command, send_wake_packet } from "@x-tech-laboratories/x-libs/agent/wake";

import { action_plan, CollectResult, io_action_plan, ping_request, type ActionOutcome, type ActionPlanResult, type CmdResult, type PingResult, type Request, type Result } from "../core/connectors/types.ts";
import { create_logger_for } from "../core/logging.ts";
import { shell_quote } from "../core/shell.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_duration, parse_duration, type PluginConfig } from "./base/plugin_helpers.ts";

const log = create_logger_for("x_monitor.plugins.uptime");

const default_layout: LayoutRow[] = [
  ["host_card", "status_card", "latency_card"],
  ["uptime_strip"],
  ["chart"],
  ["events"],
];

const wake_layout: LayoutRow[] = [
  ["host_card", "status_card", "latency_card"],
  ["wake"],
  ["uptime_strip"],
  ["chart"],
  ["events"],
];

const wake_timeout = 30.0;

// ── str.format ───────────────────────────────────────────────────────────────

// The error Python's str.format raised, kept with the repr() its message is written as.
class FormatError extends Error {
  readonly repr: string;
  constructor(repr: string) {
    super(repr);
    this.repr = repr;
  }
}

// Fills `{name}` fields from `values` as Python's str.format does, with "{{" and "}}" as literal braces; a format spec
// is dropped and only "!r" changes the text.
export function python_format(template: string, values: Record<string, string | number>): string {
  let output = "";
  let index = 0;
  let positional = 0;
  while (index < template.length) {
    const character = template[index];
    if (character === "{") {
      if (template[index + 1] === "{") {
        output += "{";
        index += 2;
        continue;
      }
      const end = template.indexOf("}", index + 1);
      if (end === -1) throw new FormatError(`ValueError("Single '{' encountered in format string")`);
      const field = template.slice(index + 1, end);
      const head = field.split(":", 1)[0];
      const [name, conversion] = head.split("!", 2);
      const key = name.split(/[.[]/, 1)[0];
      if (key === "" || /^\d+$/.test(key)) {
        const number = key === "" ? positional++ : Number(key);
        throw new FormatError(`IndexError('Replacement index ${number} out of range for positional args tuple')`);
      }
      if (!Object.hasOwn(values, key)) throw new FormatError(`KeyError('${key}')`);
      if (key !== name) throw new FormatError(`AttributeError("'${typeof values[key] === "number" ? "int" : "str"}' object has no attribute '${name.slice(key.length + 1)}'")`);
      const value = values[key];
      output += conversion === "r" && typeof value === "string" ? `'${value}'` : String(value);
      index = end + 1;
    } else if (character === "}") {
      if (template[index + 1] !== "}") throw new FormatError(`ValueError("Single '}' encountered in format string")`);
      output += "}";
      index += 2;
    } else {
      output += character;
      index++;
    }
  }
  return output;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Why a remote send failed on a host with neither sender, naming X-Monitor's way around it.
const MISSING_SENDER = "sending a wake packet needs python3 or socat on this host, or a wake_command";

export class Uptime extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  override readonly AVAILABILITY = true;
  readonly mac: string | null;
  readonly wol_broadcast: string;
  readonly wol_port: number;
  readonly wol_password: string | null;
  readonly wake_via: string | null;
  readonly wake_command: string | null;
  readonly wake_on_down: boolean;
  readonly wake_retry: number;
  readonly wake_max_attempts: number;
  wake_attempts = 0;
  last_wake: number | null = null;
  // Sends a packet from the X-Monitor server; a test swaps it for a recorder.
  send_packet: (packet: Buffer, address: string, port: number) => Promise<void> = send_wake_packet;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.mac = (config.mac as string | null | undefined) ?? null;
    this.wol_broadcast = String(config.wol_broadcast || default_broadcast);
    this.wol_port = Math.trunc(Number(config.wol_port || default_port));
    this.wol_password = (config.wol_password as string | null | undefined) ?? null;
    this.wake_via = (config.wake_via as string | null | undefined) ?? null;
    this.wake_command = (config.wake_command as string | null | undefined) ?? null;
    this.wake_on_down = Boolean(config.wake_on_down ?? false);
    this.wake_retry = parse_duration(config.wake_retry ?? "10m");
    this.wake_max_attempts = Math.trunc(Number(config.wake_max_attempts ?? 3));
  }

  override requests(): Request[] {
    return [ping_request(this.target)];
  }

  override parse_results(results: Result[]): CollectResult {
    const host = this.target;
    const result = results[0] as PingResult;

    if (result.exception !== null) {
      log.error(`Uptime plugin error for ${host}: ${result.exception}`);
      return new CollectResult({ metrics: { up: 0.0 }, logs: [[`Ping execution failed: ${result.exception}`, "ERROR"]], status: "failed" });
    }

    if (result.returncode === 0) {
      const metrics: Record<string, number> = { up: 1.0 };
      const latency = /time=([\d.]+)\s*ms/.exec(result.stdout);
      if (latency) metrics.latency_ms = Number(latency[1]);
      return new CollectResult({ metrics, logs: [[`Host ${host} is reachable.`, "INFO"]], status: "online" });
    }

    const error = result.stderr.trim() || "Request timed out";
    return new CollectResult({ metrics: { up: 0.0 }, logs: [[`Host ${host} is unreachable: ${error}`, "ERROR"]], status: "failed" });
  }

  // ── Wake-on-LAN ──────────────────────────────────────────────────────────

  // Asks for a wake when the host is down, spaced by wake_retry and capped until it is seen up again.
  override on_status(status: string, now: number): [string, Record<string, unknown>] | null {
    if (!(this.mac && this.wake_on_down)) return null;
    if (status === "online") {
      this.wake_attempts = 0;
      this.last_wake = null;
      return null;
    }
    if (status !== "failed" || this.wake_attempts >= this.wake_max_attempts) return null;
    if (this.last_wake !== null && now - this.last_wake < this.wake_retry) return null;
    this.wake_attempts += 1;
    this.last_wake = now;
    return ["wake", { automatic: true, attempt: this.wake_attempts }];
  }

  private route(): string {
    if (this.wake_via) return `from monitor ${this.wake_via}`;
    return `to ${this.wol_broadcast}:${this.wol_port}`;
  }

  private wake_outcome(message: string, success: boolean, automatic: boolean, attempt: number): CollectResult {
    let text = message;
    if (automatic) {
      text = `Automatic wake ${attempt} of ${this.wake_max_attempts}: ${text}`;
      if (attempt >= this.wake_max_attempts) text += `; no more automatic wakes until ${this.name} is seen up again`;
    }
    return new CollectResult({ logs: [[text, success ? "INFO" : "ERROR"]], metadata: { content: text }, success });
  }

  private remote_command(packet: Buffer): string {
    if (!this.wake_command) return remote_send_command(packet, this.wol_broadcast, this.wol_port, MISSING_SENDER);
    return python_format(String(this.wake_command), {
      mac: shell_quote(String(this.mac)),
      hex: packet.toString("hex"),
      broadcast: shell_quote(this.wol_broadcast),
      port: this.wol_port,
      password: shell_quote(String(this.wol_password || "")),
    });
  }

  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    if (action_id !== "wake" || !this.mac) return null;
    const automatic = Boolean(args.automatic ?? false);
    const attempt = Number(args.attempt ?? 0);
    let packet: Buffer;
    try {
      packet = magic_packet(String(this.mac), this.wol_password);
    } catch (error) {
      return this.wake_outcome(`Wake ${this.target} failed: ${(error as Error).message}`, false, automatic, attempt);
    }
    if (this.wake_via) {
      let text: string;
      try {
        text = this.remote_command(packet);
      } catch (error) {
        if (!(error instanceof FormatError)) throw error;
        return this.wake_outcome(`Wake ${this.target} failed: bad wake_command (${error.repr})`, false, automatic, attempt);
      }
      return action_plan(text, { timeout: wake_timeout, via: String(this.wake_via) });
    }

    const address = this.wol_broadcast;
    const port = this.wol_port;
    return io_action_plan(async (): Promise<string | null> => {
      try {
        await this.send_packet(packet, address, port);
      } catch (error) {
        return (error as Error).message || (error as Error).name || "Error";
      }
      return null;
    });
  }

  override interpret_action(_action_id: string, result: unknown, args: Record<string, unknown> = {}): ActionOutcome {
    const automatic = Boolean(args.automatic ?? false);
    const attempt = Number(args.attempt ?? 0);
    let error: string | null;
    if (typeof result === "object" && result !== null && (result as CmdResult).kind === "cmd") {
      const command_result = result as CmdResult;
      error = command_result.exit_code === 0 ? null : (command_result.stderr || command_result.stdout).trim() || `exit code ${command_result.exit_code}`;
    } else {
      error = (result as string | null | undefined) ?? null;
    }
    if (error) return this.wake_outcome(`Wake ${this.target} failed ${this.route()}: ${error}`, false, automatic, attempt);
    return this.wake_outcome(`Wake-on-LAN packet for ${this.mac} sent ${this.route()}`, true, automatic, attempt);
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    const spec: UISpec = {
      layout: this.mac ? wake_layout : default_layout,
      cards: {
        status_card: { metric: "up", title: "CURRENT STATUS", on_text: "ONLINE", off_text: "OFFLINE" },
        latency_card: { metric: "latency_ms", title: "LAST LATENCY", format: "seconds_ms" },
        uptime_strip: { kind: "strip", metric: "up", title: "AVAILABILITY" },
      },
      chart: { metric: "latency_ms", title: "RESPONSE TIME HISTORY (ms)" },
      events: true,
    };
    if (this.mac) {
      const auto = this.wake_on_down
        ? ` It is also sent automatically when the host goes down, every ${format_duration(this.wake_retry)}, up to ${this.wake_max_attempts} times.`
        : "";
      spec.buttons = {
        wake: [{ id: "wake", label: "Wake", icon: "power_settings_new", flat: false, confirm: "Send a Wake-on-LAN packet to {plugin.target} ({plugin.mac})?" + auto }],
      };
    }
    return spec;
  }
}
