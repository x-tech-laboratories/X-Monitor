// Logged-in users and active sessions, from `loginctl` (falling back to `who -u --ips` where logind is not running),
// plus the most recent logins from `last`. Each session shows its user, tty/seat, remote host, type, login time and
// idle time. A session whose user is not in allowed_users, or whose remote host is not in allowed_sources (CIDRs,
// hostnames or globs), is violation_status (warning by default) while it lasts and logs one event when first seen.
// Display-manager and per-user manager sessions are not counted. Config: allowed_users, allowed_sources,
// violation_status, recent_logins.

import { BlockList, isIP } from "node:net";

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, TableSpec } from "../shared/ui_spec.ts";
import { format_duration, SCRIPT_SEP, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { fnmatch, parse_int, partition, split_lines, split_words } from "./base/text_parsing.ts";

const severities: readonly string[] = ["online", "warning", "failed"];

// logind session classes that are not a person logging in: the per-user service manager and the login screen.
const ignored_classes = new Set(["manager", "manager-early", "greeter", "lock-screen"]);

// Properties read from `loginctl show-session` for each session.
const properties = ["Id", "Name", "Remote", "RemoteHost", "RemoteUser", "Type", "Class", "TTY", "Seat", "Service", "State", "Timestamp", "IdleHint", "IdleSinceHint"];

// What `last` prints for the remote host of a local login when asked for numeric addresses.
const local_hosts = new Set(["", "0.0.0.0", "::", "-"]);

const iso_pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const who_idle_pattern = /^(\.|\?|old|\d+:\d+)$/;
// What who's idle column means when it is not an hours:minutes duration.
const who_idle_text: Record<string, string> = { "": "active", ".": "active", "?": "--", old: "over 1 day" };
const who_date_pattern = /^\d{4}-\d{2}-\d{2}$/;
const weekday_pattern = /^[A-Z][a-z]{2} /;

// One login session as the snapshot keeps it.
export interface Session {
  id: string;
  user: string;
  tty: string;
  seat: string;
  host: string;
  type: string;
  class: string;
  service: string;
  state: string;
  since: string;
  idle: boolean;
  idle_since: number | null;
  idle_text: string;
  remote: boolean;
  allowed?: boolean;
}

// One past login from `last`.
export interface RecentLogin {
  user: string;
  tty: string;
  host: string;
  login: string;
  until: string;
  duration: string;
}

// ── Probe ────────────────────────────────────────────────────────────────────

// One script listing sessions through loginctl or who, then the recent logins from last.
export function probe_script(recent: number): string {
  const property_flags = properties.map((name) => `-p ${name}`).join(" ");
  const lines = [
    "if command -v loginctl >/dev/null 2>&1 && list=$(loginctl list-sessions --no-legend --no-pager 2>/dev/null); then",
    '  echo "source=loginctl"',
    `  echo "${SCRIPT_SEP}"`,
    "  ids=$(printf '%s\\n' \"$list\" | awk 'NF {print $1}')",
    `  if [ -n "$ids" ]; then loginctl show-session --no-pager $ids ${property_flags} 2>/dev/null; fi`,
    "else",
    '  echo "source=who"',
    `  echo "${SCRIPT_SEP}"`,
    "  who -u --ips 2>/dev/null || who -u 2>/dev/null",
    "fi",
    `echo "${SCRIPT_SEP}"`,
  ];
  // Reboot records count towards -n, so it asks for twice as many and keeps the logins.
  if (recent > 0) lines.push(`last -i -w -n ${Math.trunc(recent) * 2} --time-format iso 2>/dev/null`);
  return lines.join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// Whether a remote-host field means a local login: none, an X display, or an unspecified address.
function is_local(host: string): boolean {
  return local_hosts.has(host) || host.startsWith(":");
}

function session_of(fields: Partial<Session>): Session {
  return { id: "", user: "", tty: "", seat: "", host: "", type: "", class: "", service: "", state: "", since: "", idle: false, idle_since: null, idle_text: "", remote: false, ...fields };
}

// `loginctl show-session` output as one property record per session.
function loginctl_blocks(text: string): Record<string, string>[] {
  const blocks: Record<string, string>[] = [];
  let current: Record<string, string> = {};
  for (const line of split_lines(text)) {
    const [key, separator, value] = partition(line, "=");
    if (!separator) {
      if (Object.keys(current).length > 0) {
        blocks.push(current);
        current = {};
      }
      continue;
    }
    if (key in current) {
      blocks.push(current);
      current = {};
    }
    current[key] = value.trim();
  }
  if (Object.keys(current).length > 0) blocks.push(current);
  return blocks;
}

// Sessions from `loginctl show-session`, leaving out manager and login-screen sessions.
export function parse_loginctl(text: string): Session[] {
  const sessions: Session[] = [];
  for (const block of loginctl_blocks(text)) {
    if (!block.Id || ignored_classes.has(block.Class ?? "")) continue;
    const host = block.RemoteHost ?? "";
    const idle_since = Math.floor(parse_int(block.IdleSinceHint || 0) / 1_000_000);
    sessions.push(session_of({
      id: block.Id,
      user: block.Name ?? "",
      tty: block.TTY ?? "",
      seat: block.Seat ?? "",
      host: is_local(host) ? "" : host,
      type: block.Type ?? "",
      class: block.Class ?? "",
      service: block.Service ?? "",
      state: block.State ?? "",
      since: (block.Timestamp ?? "").replace(weekday_pattern, ""),
      idle: block.IdleHint === "yes",
      idle_since: idle_since || null,
      remote: block.Remote === "yes" || !is_local(host),
    }));
  }
  return sessions;
}

// Sessions from `who -u [--ips]`: user, tty, date, time, idle, pid, then the remote host if any.
export function parse_who(text: string): Session[] {
  const sessions: Session[] = [];
  for (const line of split_lines(text)) {
    const tokens = split_words(line);
    if (tokens.length < 4 || !who_date_pattern.test(tokens[2])) continue;
    const [user, tty] = tokens;
    const since = `${tokens[2]} ${tokens[3]}`;
    const rest = tokens.slice(4);
    let idle = "";
    if (rest.length > 0 && who_idle_pattern.test(rest[0])) idle = rest.shift()!;
    if (rest.length > 0 && /^\d+$/.test(rest[0])) rest.shift();
    const host = rest.join(" ").replace(/^[()]+|[()]+$/g, "");
    const local = is_local(host);
    sessions.push(session_of({
      id: `${user}@${tty}@${since}`, user, tty, host: local ? "" : host, type: "tty", since,
      idle: !["", ".", "?"].includes(idle),
      idle_text: who_idle_text[idle] ?? idle,
      remote: !local,
    }));
  }
  return sessions;
}

// Recent logins from `last --time-format iso`, leaving out reboot records and the wtmp footer.
export function parse_last(text: string): RecentLogin[] {
  const logins: RecentLogin[] = [];
  for (const line of split_lines(text)) {
    const tokens = split_words(line);
    if (tokens.length === 0 || ["reboot", "shutdown", "wtmp", "btmp", "wtmpdb"].includes(tokens[0])) continue;
    const at = tokens.findIndex((token) => iso_pattern.test(token));
    if (at < 2) continue;
    const host = tokens.slice(2, at).join(" ");
    let rest = tokens.slice(at + 1);
    const duration = rest.find((token) => token.startsWith("("))?.replace(/^[()]+|[()]+$/g, "") ?? "";
    rest = rest.filter((token) => !token.startsWith("("));
    if (rest[0] === "-") rest = rest.slice(1);
    logins.push({ user: tokens[0], tty: tokens[1], host: is_local(host) ? "" : host, login: tokens[at], until: rest.join(" "), duration });
  }
  return logins;
}

// ── Allowlists ───────────────────────────────────────────────────────────────

// A CIDR as Python's ip_network(strict=False) reads it, or null when it is not one.
function parse_network(pattern: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const [address, , mask] = partition(pattern, "/");
  const version = isIP(address);
  if (version === 0) return null;
  const family = version === 4 ? "ipv4" : "ipv6";
  const limit = version === 4 ? 32 : 128;
  let prefix: number;
  if (/^\d+$/.test(mask)) prefix = Number(mask);
  else if (version === 4 && isIP(mask) === 4) {
    const bits = mask.split(".").map((octet) => Number(octet).toString(2).padStart(8, "0")).join("");
    if (!/^1*0*$/.test(bits)) return null;
    prefix = bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
  } else return null;
  if (prefix > limit) return null;
  return { address, prefix, family };
}

// Whether a remote host matches one of the allowed CIDRs, hostnames or globs.
export function source_allowed(host: string, patterns: readonly string[]): boolean {
  const bare = host.split("%")[0];
  const version = isIP(bare);
  for (const pattern of patterns) {
    if (version !== 0 && pattern.includes("/")) {
      const network = parse_network(pattern);
      if (network !== null && network.family === (version === 4 ? "ipv4" : "ipv6")) {
        const block = new BlockList();
        block.addSubnet(network.address, network.prefix, network.family);
        if (block.check(bare, network.family)) return true;
      }
      continue;
    }
    if (fnmatch(host.toLowerCase(), pattern.toLowerCase())) return true;
  }
  return false;
}

function where(session: Session): string {
  const place = session.tty || session.seat || "?";
  return `${session.user} on ${place}` + (session.host ? ` from ${session.host}` : "");
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Who is logged in, from where and since when, with an allowlist of users and remote sources and a list of recent
// logins.
export class Sessions extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly allowed_users: string[];
  readonly allowed_sources: string[];
  readonly violation_status: Status;
  readonly recent_logins: number;
  // Sessions already reported, so each new one logs once; null until the first cycle sets the baseline.
  private seen: Set<string> | null = null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.allowed_users = ((config.allowed_users as unknown[] | null | undefined) || []).map(String);
    this.allowed_sources = ((config.allowed_sources as unknown[] | null | undefined) || []).map(String);
    const status = String(config.violation_status ?? "warning").toLowerCase();
    this.violation_status = (severities.includes(status) ? status : "warning") as Status;
    this.recent_logins = parse_int(config.recent_logins ?? 10);
  }

  override commands(): Command[] {
    return [command(probe_script(this.recent_logins))];
  }

  // Why a session is outside the allowlists, or null when it is allowed.
  private violation(session: Session): string | null {
    const user = session.user;
    if (this.allowed_users.length > 0 && !this.allowed_users.some((pattern) => fnmatch(user, pattern))) return `user ${user} is not in allowed_users`;
    const host = session.host;
    if (host && this.allowed_sources.length > 0 && !source_allowed(host, this.allowed_sources)) return `source ${host} is not in allowed_sources`;
    return null;
  }

  override parse(results: CmdResult[]): CollectResult {
    const { stdout, stderr } = results[0];
    if (!stdout.includes(SCRIPT_SEP)) return CollectResult.unavailable(`Could not list sessions: ${(stderr || stdout).trim().slice(0, 200)}`);

    const parts = stdout.split(SCRIPT_SEP);
    while (parts.length < 3) parts.push("");
    const source = partition(parts[0].trim(), "=")[2] || "who";
    const sessions = source === "loginctl" ? parse_loginctl(parts[1]) : parse_who(parts[1]);
    const recent = this.recent_logins > 0 ? parse_last(parts[2]).slice(0, this.recent_logins) : [];

    const accumulator = new StatusAccumulator();
    const logs: LogEntry[] = [];
    const first = this.seen === null;
    const seen = this.seen ?? new Set<string>();
    const current = new Set<string>();
    for (const session of sessions) {
      const key = `${session.id}@${session.since}`;
      current.add(key);
      const reason = this.violation(session);
      session.allowed = reason === null;
      if (reason) accumulator.escalate(this.violation_status, `${where(session)}: ${reason}`);
      if (seen.has(key)) continue;
      if (reason) logs.push([`Unexpected session: ${where(session)} (${reason})`, log_level_of(this.violation_status)]);
      else if (!first) logs.push([`New session: ${where(session)}`, "INFO"]);
    }
    this.seen = current;

    const remote = sessions.filter((session) => session.remote).length;
    const unexpected = sessions.filter((session) => !session.allowed).length;
    const users = new Set(sessions.map((session) => session.user)).size;
    let summary = `${sessions.length} session(s), ${remote} remote, ${users} user(s)`;
    if (unexpected) summary += `, ${unexpected} unexpected`;
    logs.unshift([summary, accumulator.log_level]);
    return new CollectResult({
      metrics: { sessions_total: sessions.length, sessions_remote: remote, sessions_unexpected: unexpected, users_total: users },
      logs,
      status: accumulator.status,
      snapshot: { source, sessions, recent },
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private snapshot(): { source?: string; sessions?: Partial<Session>[]; recent?: Partial<RecentLogin>[] } {
    const snapshot = this.data ? this.data.latest_snapshot<Record<string, unknown>>({}) : {};
    return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? snapshot : {};
  }

  static idle_text(session: Partial<Session>, now: number): string {
    if (session.idle_text) return session.idle_text;
    if (!session.idle) return "active";
    const since = session.idle_since;
    return since ? format_duration(Math.trunc(now - since)) : "idle";
  }

  get session_rows(): Record<string, unknown>[] {
    const now = Date.now() / 1000;
    return (this.snapshot().sessions ?? []).map((session) => {
      let kind = session.type ?? "";
      if (session.service) kind = kind ? `${kind} (${session.service})` : session.service;
      const place = [session.seat, session.tty].filter(Boolean).join("/");
      return {
        id: session.id ?? "",
        user: session.user ?? "",
        where: place || "--",
        host: session.host || "local",
        type: kind || "--",
        since: session.since || "--",
        idle: Sessions.idle_text(session, now),
        allowed: session.allowed ?? true,
      };
    });
  }

  get recent_rows(): Record<string, string>[] {
    return (this.snapshot().recent ?? []).map((login, index) => ({
      key: `${index}-${login.login ?? ""}`,
      user: login.user ?? "",
      tty: login.tty ?? "",
      host: login.host || "local",
      login: login.login ?? "",
      until: login.until ?? "",
      duration: login.duration || "--",
    }));
  }

  readonly allowed_color = (row: Record<string, unknown>): Status | null => ((row.allowed ?? true) ? null : this.violation_status);

  readonly unexpected_color = (value: number | null): Status | null => {
    if (value === null) return null;
    return value > 0 ? this.violation_status : "online";
  };

  override cards(): Record<string, CardSpec> {
    return {
      sessions_card: { metric: "sessions_total", title: "SESSIONS", format: "int" },
      remote_card: { metric: "sessions_remote", title: "REMOTE", format: "int" },
      users_card: { metric: "users_total", title: "USERS", format: "int" },
      unexpected_card: { metric: "sessions_unexpected", title: "UNEXPECTED", format: "int", color: this.unexpected_color },
    };
  }

  override tables(): Record<string, TableSpec> {
    const tables: Record<string, TableSpec> = {
      sessions: {
        row_key: "id",
        rows_attr: "session_rows",
        columns: [
          { name: "user", label: "User", field: "user", sortable: true, align: "left", cell_color_by: this.allowed_color },
          { name: "where", label: "TTY / Seat", field: "where", align: "left" },
          { name: "host", label: "From", field: "host", sortable: true, align: "left", cell_color_by: this.allowed_color },
          { name: "type", label: "Type", field: "type", align: "left" },
          { name: "since", label: "Since", field: "since", sortable: true, align: "left" },
          { name: "idle", label: "Idle", field: "idle", align: "left" },
        ],
      },
    };
    if (this.recent_logins > 0) {
      tables.recent_logins = {
        row_key: "key",
        rows_attr: "recent_rows",
        columns: [
          { name: "user", label: "User", field: "user", align: "left" },
          { name: "tty", label: "TTY", field: "tty", align: "left" },
          { name: "host", label: "From", field: "host", align: "left" },
          { name: "login", label: "Login", field: "login", align: "left" },
          { name: "until", label: "Until", field: "until", align: "left" },
          { name: "duration", label: "Duration", field: "duration", align: "right" },
        ],
      };
    }
    return tables;
  }

  override charts(): Record<string, ChartSpec> {
    return { sessions_chart: { metric: "sessions_total", title: "SESSIONS" } };
  }
}
