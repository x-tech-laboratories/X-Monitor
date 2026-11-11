// Mosquitto broker health, proved by a full publish/subscribe round trip: one shell script over SSH, sampled locally by
// the agent on agent-backed hosts, subscribes to a probe topic, publishes a nonce, and requires that same nonce back.
// Config: host, port, username, password / password_command, probe_topic, probe_timeout. A completed round trip is
// online; a delivery timeout, a payload mismatch, or any other script failure is failed, with no warning tier. Only a
// host missing the mosquitto clients is unavailable, since the broker was never probed.

import { randomUUID } from "node:crypto";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import { register_color_rule, register_formatter } from "../shared/ui_registry.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { py_str_repr } from "./base/python_text.ts";

export const TIMED_OUT = "XMONITOR_MQTT_TIMEOUT";
export const MISMATCH = "XMONITOR_MQTT_MISMATCH";

// ── Script ───────────────────────────────────────────────────────────────────

export function auth_flags(username: string | null, password_command: string | null, password: string | null): string {
  if (!username) return "";
  if (password_command) return `-u ${shell_quote(username)} -P "$__pw"`;
  if (password) return `-u ${shell_quote(username)} -P ${shell_quote(password)}`;
  return `-u ${shell_quote(username)}`;
}

export function build_probe_script(host: string, port: number, topic: string, timeout: number, username: string | null, password_command: string | null, password: string | null): string {
  const lines = ["set -e"];
  if (password_command) lines.push(`__pw=$(${password_command})`);

  const auth = auth_flags(username, password_command, password);
  const nonce = `x-monitor-probe-${randomUUID().replaceAll("-", "")}`;
  const seconds = Math.trunc(timeout);
  const port_number = Math.trunc(port);

  lines.push(`__nonce=${shell_quote(nonce)}`);
  lines.push(
    `__got=$(timeout ${seconds} mosquitto_sub -h ${shell_quote(host)} ` +
    `-p ${port_number} -t ${shell_quote(topic)} -C 1 -W ${seconds} ${auth} & ` +
    "__sub_pid=$!; " +
    "sleep 0.3; " +
    `mosquitto_pub -h ${shell_quote(host)} -p ${port_number} ` +
    `-t ${shell_quote(topic)} -m "$__nonce" ${auth}; ` +
    'wait "$__sub_pid")',
  );
  lines.push(`if [ -z "$__got" ]; then echo "${TIMED_OUT}" >&2; exit 1; fi`);
  lines.push(`if [ "$__got" != "$__nonce" ]; then echo "${MISMATCH}: expected $__nonce, got $__got" >&2; exit 1; fi`);
  lines.push('echo "$__nonce"');
  return lines.join("\n");
}

// ── Monitor ──────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "roundtrip_card", "latency_card"],
  ["uptime_strip"],
  ["chart"],
  ["events"],
];

export class Mosquitto extends Plugin {
  override readonly SAMPLED = true;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  readonly password_command: string | null;
  readonly probe_topic: string;
  readonly probe_timeout: number;
  private started: number | null = null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.host = String(config.host ?? "127.0.0.1");
    this.port = Math.trunc(Number(config.port ?? 1883));
    this.username = (config.username as string | null | undefined) ?? null;
    this.password = (config.password as string | null | undefined) ?? null;
    this.password_command = (config.password_command as string | null | undefined) ?? null;
    this.probe_topic = String(config.probe_topic ?? `x_monitor/probe/${this.id}`);
    this.probe_timeout = Math.trunc(Number(config.probe_timeout ?? 5));
  }

  override commands(): Command[] {
    this.started = performance.now() / 1000;
    return [command(build_probe_script(this.host, this.port, this.probe_topic, this.probe_timeout, this.username, this.password_command, this.password))];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stderr } = results[0];
    const elapsed_ms = this.started !== null ? (performance.now() / 1000 - this.started) * 1000.0 : 0.0;

    if (exit_code !== 0) {
      let message: string;
      if (stderr.includes(TIMED_OUT)) {
        message = `Publish/subscribe round trip on ${py_str_repr(this.probe_topic)} timed out after ${this.probe_timeout}s — broker accepted the connection but did not deliver the message`;
      } else if (stderr.includes(MISMATCH)) {
        message = `Publish/subscribe round trip returned an unexpected payload: ${stderr.trim()}`;
      } else if (stderr.includes("not found")) {
        return CollectResult.unavailable(`Cannot run the MQTT round trip, the mosquitto clients are missing: ${stderr.trim()}`);
      } else {
        message = `Failed to run MQTT round trip: ${stderr.trim()}`;
      }
      return new CollectResult({ metrics: { roundtrip_ok: 0.0 }, logs: [[message, "ERROR"]], status: "failed" });
    }

    return new CollectResult({
      metrics: { roundtrip_ok: 1.0, roundtrip_ms: elapsed_ms },
      logs: [[`Round trip OK on ${this.probe_topic} (${elapsed_ms.toFixed(0)}ms)`, "INFO"]],
      status: "online",
    });
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        roundtrip_card: { metric: "roundtrip_ok", title: "ROUND TRIP", format: "mosquitto_ok_text", color: "mosquitto_ok_color" },
        latency_card: { metric: "roundtrip_ms", title: "LATENCY", format: "ms0" },
        uptime_strip: { kind: "strip", metric: "roundtrip_ok", title: "ROUND TRIP HISTORY" },
      },
      chart: { metric: "roundtrip_ms", title: "ROUND TRIP LATENCY (ms)" },
      events: true,
    };
  }
}

// ── Page rules ───────────────────────────────────────────────────────────────

register_formatter("mosquitto_ok_text", (value) => (value === null ? "--" : value >= 1.0 ? "OK" : "FAILED"));
register_color_rule("mosquitto_ok_color", (value) => (value === null ? null : value >= 1.0 ? "online" : "failed"));
