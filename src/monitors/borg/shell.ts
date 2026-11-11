// Shell plumbing shared by every borg call: framing several calls into one command, reading them back apart, and naming
// what went wrong.

import { cmd_result, type CmdResult } from "../../core/connectors/types.ts";
import { shell_quote } from "../../core/shell.ts";

// ── Names the generated shell uses ───────────────────────────────────────────

export const POLL_BASE_DIR_VAR = "__x_monitor_poll_base";
export const POLL_DEADLINE_VAR = "__x_monitor_poll_end";
export const POLL_LEFT_FN = "__x_monitor_poll_left";
export const POLL_RC_VAR = "__x_monitor_poll_rc";
const job_rc_var = "__x_monitor_job_rc";
const step_rc_var = "__x_monitor_step_rc";
const skip_var = "__x_monitor_skip";
const skip_mark = "__XMONITOR_SKIP__ ";
// A job prints this before each step it chains, and the line becomes the job's progress until borg reports its own.
export const STEP_MARK = "==> ";
const frame = "__XMONITOR_BORG__";
export const CUT_SHORT = "no output: the poll ended before this call ran";
// A repository host goes into a shell probe, so only characters a hostname or an IP address can hold get through.
const safe_host = /^[A-Za-z0-9.:_-]+$/;

// ── Text ─────────────────────────────────────────────────────────────────────

// Lines as Python's str.splitlines() gives them, without a trailing empty one.
export function splitlines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// A config value as a list of strings: none, one string, or a list.
export function as_list(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  return [...(value as Iterable<unknown>)].map((item) => String(item));
}

// Hides a passphrase or passphrase command set in a command line.
export function redact(command: string): string {
  return command.replace(/(BORG_PASS(?:PHRASE|COMMAND)=)('(?:[^']|'\\'')*'|"[^"]*"|\S+)/g, "$1*****");
}

// ── Frames ───────────────────────────────────────────────────────────────────

// The marker that separates one poll call's captured output from the next.
export function frame_line(index: number, stream: string, code: number | string): string {
  return `${frame} ${index} ${stream} ${code}`;
}

// Splits a sequential poll's framed transcript back into one CmdResult per borg call.
export function split_poll(result: CmdResult, count: number): CmdResult[] {
  const streams = new Map<number, Map<string, string>>();
  const codes = new Map<number, number>();
  let key: [number, string] | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (key === null) return;
    if (!streams.has(key[0])) streams.set(key[0], new Map());
    streams.get(key[0])!.set(key[1], buffer.join("\n").trim());
  };

  for (const line of splitlines(result.stdout || "")) {
    if (!line.startsWith(frame + " ")) {
      buffer.push(line);
      continue;
    }
    flush();
    buffer = [];
    const fields = line.trim().split(/\s+/);
    // A live call's stdout frame comes before the call ends, so its code is "-" and the stderr frame after it carries the real one.
    if (fields.length < 4 || !/^[+-]?\d+$/.test(fields[1]) || (fields[3] !== "-" && !/^[+-]?\d+$/.test(fields[3]))) {
      key = null;
      continue;
    }
    const index = Number(fields[1]);
    key = [index, fields[2]];
    if (fields[3] !== "-") codes.set(index, Number(fields[3]));
  }
  flush();

  // No frame arrived at all, so the shell or sudo failed before the first borg call and the whole transcript is that failure.
  if (codes.size === 0) {
    return [result, ...Array.from({ length: Math.max(0, count - 1) }, () => cmd_result(result.exit_code, "", result.stderr))];
  }

  const results: CmdResult[] = [];
  for (let index = 0; index < count; index++) {
    if (!codes.has(index)) {
      results.push(cmd_result(result.exit_code || 1, "", CUT_SHORT));
      continue;
    }
    const captured = streams.get(index) ?? new Map<string, string>();
    results.push(cmd_result(codes.get(index)!, captured.get("out") ?? "", captured.get("err") ?? ""));
  }
  return results;
}

// ── Failures ─────────────────────────────────────────────────────────────────

// A hint at the likely cause of a borg failure, read from its error text.
export function failure_hint(stderr: string): string | null {
  const text = (stderr || "").toLowerCase();
  if (text.includes("permission denied (publickey)") || text.includes("publickey")) {
    return "Hint: borg could not authenticate to the repo server — set `ssh_key` to a private key on that host which the borg server authorizes (borg makes its own SSH connection, so X-Monitor's own login key does not apply).";
  }
  if (text.includes("command not found")) {
    return "Hint: the borg binary is not on PATH for that user — under sudo it must be on root's PATH too (set `borg_bin` to an absolute path).";
  }
  if (text.includes("a password is required") || text.includes("sudo: a terminal is required")) {
    return "Hint: sudo needs a password — grant the SSH user passwordless sudo for borg (NOPASSWD).";
  }
  if (text.includes("not allowed to set the following environment variables")) {
    return "Hint: sudoers forbids setting BORG_PASSPHRASE — the rule needs the SETENV tag to pass the passphrase through sudo.";
  }
  if (text.includes("passphrase") || text.includes("not a valid repository")) {
    return "Hint: the repo is encrypted and the passphrase was missing or wrong — check `passphrase_file` / `passphrase_command`.";
  }
  if (text.includes("permission denied")) {
    return "Hint: the SSH user cannot read the repo — add it to the repo's group or set `require_sudo: true`.";
  }
  if (text.includes("does not exist") || text.includes("no such file")) return "Hint: the `repo` path does not exist on that host.";
  if (text.includes("failed to create/acquire the lock")) {
    // borg locks its local chunks cache under <base dir>/.cache/borg as well as the repo, and the two mean different things.
    if (text.includes("/.cache/borg/")) {
      return "Hint: the lock is on borg's local chunks cache on this host, not on the repo — another borg process is using the same `cache_dir`. Give it a cache_dir of its own, or raise `lock_wait` past the time that process needs.";
    }
    return "Hint: the repo is locked by another borg process — a backup may be running.";
  }
  return null;
}

// Whether the listing could not be gathered at all, as opposed to borg reporting a repo problem.
export function list_unavailable(exit_code: number, detail: string): boolean {
  const text = detail.toLowerCase();
  // A lock borg gave up waiting for says only that something else held the repo or its cache, which leaves the archives unread rather than bad.
  return exit_code === -1 || text.includes("command not found") || text.includes("permission denied") || text.includes("failed to create/acquire the lock");
}

// ── Preflight ────────────────────────────────────────────────────────────────

// The host and port of an `ssh://` repository URL, read as Python's urlsplit does, or null for a local path or a name
// the shell could misread.
export function ssh_endpoint(repo: string | null | undefined): [host: string, port: number] | null {
  if (!(repo || "").startsWith("ssh://")) return null;
  const rest = repo!.slice("ssh://".length);
  const netloc = rest.split(/[/?#]/, 1)[0];
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  let host: string;
  let port_text: string;
  if (hostinfo.startsWith("[")) {
    const close = hostinfo.indexOf("]");
    if (close === -1) return null;
    host = hostinfo.slice(1, close);
    const after = hostinfo.slice(close + 1);
    port_text = after.startsWith(":") ? after.slice(1) : "";
  } else {
    const colon = hostinfo.indexOf(":");
    host = colon === -1 ? hostinfo : hostinfo.slice(0, colon);
    port_text = colon === -1 ? "" : hostinfo.slice(colon + 1);
  }
  let port = 22;
  if (port_text) {
    if (!/^\d+$/.test(port_text)) return null;
    const number = Number(port_text);
    if (number > 65535) return null;
    port = number || 22;
  }
  host = host.toLowerCase();
  if (!host || !safe_host.test(host)) return null;
  return [host, port];
}

// Shell that sets the skip variable to the first reason a job should not start, or null when there is nothing to test.
export function preflight_script(endpoint: [string, number] | null, units: string[]): string | null {
  const tests: string[] = [];
  if (endpoint) {
    const [host, port] = endpoint;
    // Reads the SSH banner rather than pinging, since a host can answer ICMP while its SSH transport hangs.
    const probe = shell_quote(`exec 3<>/dev/tcp/${host}/${port} && head -c 4 <&3`);
    const reason = shell_quote(`${host}:${port} is not answering SSH`);
    tests.push(`if ! timeout 5 bash -c ${probe} 2>/dev/null | grep -q '^SSH-'; then ${skip_var}=${reason}; fi`);
  }
  for (const unit of units) {
    const reason = shell_quote(`${unit} is running`);
    tests.push(`if [ -z "$${skip_var}" ] && systemctl is-active --quiet ${shell_quote(unit)}; then ${skip_var}=${reason}; fi`);
  }
  if (tests.length === 0) return null;
  return [`${skip_var}=`, ...tests].join("; ");
}

// Runs `launch` only when the preflight found no reason to skip, and otherwise prints that reason instead.
export function with_preflight(preflight: string | null, launch: string): string {
  if (!preflight) return launch;
  return `${preflight}; if [ -n "$${skip_var}" ]; then echo "${skip_mark}$${skip_var}"; else ${launch}; fi`;
}

// The reason a launch printed for skipping its job, or null when it launched.
export function skip_reason(stdout: string): string | null {
  for (const line of splitlines(stdout || "")) {
    if (line.startsWith(skip_mark)) return line.slice(skip_mark.length).trim();
  }
  return null;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

// Runs `first`, then each [label, command] step while everything so far ended in success or a borg warning, exiting
// with the worst status.
export function then_steps(first: string, steps: [label: string, command: string][]): string {
  if (steps.length === 0) return first;
  const parts = [`${first}; ${job_rc_var}=$?`];
  for (const [label, command_text] of steps) {
    parts.push(
      `if [ "$${job_rc_var}" -le 1 ]; then echo ${shell_quote(STEP_MARK + label)}; ${command_text}; ` +
      `${step_rc_var}=$?; if [ "$${step_rc_var}" -gt "$${job_rc_var}" ]; then ${job_rc_var}=$${step_rc_var}; fi; fi`,
    );
  }
  // A plain `exit` would leave the job's shell before it records the status, so a subshell carries it instead.
  parts.push(`(exit "$${job_rc_var}")`);
  return parts.join("; ");
}

// Runs the whole job under the given wrapper argv, saying so first when it has to wait for the lock.
export function wrap_job(command_text: string, wrappers: string[], lock: string | null): string {
  if (wrappers.length === 0) return command_text;
  const wrapped = wrappers.map(shell_quote).join(" ") + " sh -c " + shell_quote(command_text);
  if (!lock) return wrapped;
  const waiting = shell_quote(`${STEP_MARK}Waiting for another job to release ${lock}`);
  return `flock -n ${shell_quote(lock)} true 2>/dev/null || echo ${waiting}; ${wrapped}`;
}

// A path as borg stores it inside an archive, or null when it could climb out of the restore dir.
export function archive_member(path: string | null | undefined): string | null {
  const member = (path || "").trim().replace(/^\/+|\/+$/g, "");
  if (member.split("/").some((part) => part === ".." || part === ".")) return null;
  return member;
}
