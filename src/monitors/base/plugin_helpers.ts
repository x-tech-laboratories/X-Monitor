// Small pure helpers the monitors share: secrets from a command, the config every monitor reads, the worst-of status
// accumulator, shell helpers for probe scripts, the threshold helpers, and byte, duration and age text.

import { spawnSync } from "node:child_process";

import { format_duration as x_format_duration, parse_duration as x_parse_duration } from "@x-tech-laboratories/x-libs/durations";

import { log_level_of, severity, status_of, type LogLevel, type Status } from "../../shared/status.ts";
import { format_bytes as shared_format_bytes } from "../../shared/ui_registry.ts";
import { shell_quote } from "../../core/shell.ts";

export type PluginConfig = Record<string, unknown> & {
  name?: string;
  type?: string;
  id?: string;
  interval?: unknown;
  offset?: unknown;
  schedule?: unknown;
  triggers?: unknown;
  actions?: unknown;
  timeout?: unknown;
  target_host?: string;
  agent?: string;
  ssh_config?: Record<string, unknown>;
  children?: PluginConfig[];
  ref?: string;
  layout?: unknown;
  notify?: unknown;
};

// ── Secrets ──────────────────────────────────────────────────────────────────

// A secret from a literal or from a command run on the X-Monitor host at construction, so requests() stays pure;
// null when neither is set or the command fails.
export function resolve_secret(password: string | null | undefined, password_command: string | null | undefined): string | null {
  if (password !== null && password !== undefined) return password;
  if (!password_command) return null;
  const outcome = spawnSync("sh", ["-c", password_command], { encoding: "utf8", timeout: 15_000 });
  if (outcome.error || outcome.status !== 0) return null;
  return outcome.stdout.replace(/\n+$/, "");
}

// ── Status accumulator ───────────────────────────────────────────────────────

// An escalating worst-of status plus the problems that caused it.
export class StatusAccumulator {
  status: Status = "online";
  readonly problems: string[] = [];

  escalate(status: Status | string, problem: string | null = null): void {
    if (problem !== null) this.problems.push(problem);
    const candidate = status_of(status);
    if (severity(candidate) > severity(this.status)) this.status = candidate;
  }

  get log_level(): LogLevel {
    return log_level_of(this.status);
  }
}

// ── Shell ────────────────────────────────────────────────────────────────────

export const SCRIPT_SEP = "@@XMONITOR_SPLIT@@";

// A shell line putting a monitor's secret in __pw, from a command or a literal.
export function password_line(password_command: string | null | undefined, password: string | null | undefined): string {
  if (password_command) return `__pw=$(${password_command})`;
  return `__pw=${shell_quote(password ?? "")}`;
}

// Double-quotes a string for use inside a single-quoted shell trap.
export function dq(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
}

export const KILL_GRACE_SECONDS = 5;

// Argv that bounds a command's runtime, placed inside any sudo so a root command's own deadline can kill its root child.
export function deadline_prefix(timeout: number | null | undefined): string[] {
  if (!timeout || timeout <= 0) return [];
  return ["timeout", "-k", String(KILL_GRACE_SECONDS), String(Math.trunc(timeout))];
}

// ── Limits ───────────────────────────────────────────────────────────────────

// A warning or failure limit: its default when absent, and null when set to null, which turns that level off.
export function limit_from(config: Record<string, unknown>, key: string, fallback: number | null = null): number | null {
  const value = key in config ? config[key] : fallback;
  return value === null || value === undefined ? null : Number(value);
}

export function level_for(value: number, warning: number | null, threshold: number | null): "online" | "warning" | "failed" {
  if (threshold !== null && value >= threshold) return "failed";
  if (warning !== null && value >= warning) return "warning";
  return "online";
}

// For a reading where lower is worse.
export function floor_level_for(value: number, warning: number | null, threshold: number | null): "online" | "warning" | "failed" {
  if (threshold !== null && value <= threshold) return "failed";
  if (warning !== null && value <= warning) return "warning";
  return "online";
}

// The limits for a log line, such as "warn 70% / fail 85%", leaving out a level that is off.
export function limits_text(warning: number | null, threshold: number | null, unit = ""): string {
  const parts = ([["warn", warning], ["fail", threshold]] as const)
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label} ${python_g(value!)}${unit}`);
  return parts.join(" / ") || "no limits";
}

// A number as Python's "{:g}" writes it: six significant digits, no trailing zeros.
export function python_g(value: number): string {
  if (!Number.isFinite(value)) return String(value).toLowerCase();
  if (value === 0) return "0";
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, power] = value.toExponential(5).split("e");
    const trimmed = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, "") : mantissa;
    const sign = power.startsWith("-") ? "-" : "+";
    return `${trimmed}e${sign}${power.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  const text = value.toFixed(Math.max(0, 5 - exponent));
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

// ── Text ─────────────────────────────────────────────────────────────────────

// A size as MB, GB or TB, reading the value in `unit`.
export const format_bytes = shared_format_bytes;

// A "2h30m"-style duration, or bare seconds, as seconds; `key` names the setting in the error.
export function parse_duration(value: unknown, key = "duration"): number {
  return x_parse_duration(value, key);
}

// The two largest whole units, such as "1 Day 2 Hours", as the Python app wrote them.
export function format_duration(seconds: number): string {
  const text = x_format_duration(Math.max(0, Math.trunc(seconds)), { separator: " ", largest_unit: "weeks" });
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// An age such as "2 Days ago", or "Never" for a negative age.
export function format_age(seconds: number): string {
  return seconds < 0 ? "Never" : `${format_duration(seconds)} ago`;
}
