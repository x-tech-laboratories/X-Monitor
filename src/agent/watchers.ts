// Event watchers, the agent's push side. A watcher runs on the monitored host, notices something and hands a payload to
// the agent to send at once, which a polled transport cannot do. Each watcher is one long-lived loop made from a
// StreamSpec; the agent stops and rebuilds them whenever the server sends a new subscription set, and a watcher that
// fails is logged and restarted after a pause rather than taking the connection down. Adding a watcher means adding
// one function and one WATCHERS entry: params travel through the protocol untouched.

import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

import { create_logger_for } from "../core/logging.ts";
import * as executor from "./executor.ts";

const log = create_logger_for("x_monitor_agent.watchers");

// Sends one event payload to the server, now.
export type Emit = (payload: Record<string, unknown>) => Promise<void>;

export type Watcher = (params: Record<string, unknown>, emit: Emit, signal: AbortSignal) => Promise<void>;

export const RESTART_BACKOFF_SECONDS = 5.0;
export const JOURNAL_SETTLE_SECONDS = 0.2;

const UNIT_FIELDS = ["_SYSTEMD_UNIT", "UNIT", "OBJECT_SYSTEMD_UNIT", "COREDUMP_UNIT"];

// Resolves after `seconds`, or rejects once the signal aborts.
function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, seconds * 1000);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

// ── Journal ──────────────────────────────────────────────────────────────────

// A bare unit name with .service added, as journalctl itself does.
export function mangle_unit(name: string): string {
  return name.includes(".") ? name : `${name}.service`;
}

// Whether one journal entry satisfies a stream's filter params.
export function entry_matches(params: Record<string, unknown>, entry: Record<string, unknown>, message: string): boolean {
  const unit = params.unit;
  if (unit && !UNIT_FIELDS.some((field) => entry[field] === mangle_unit(String(unit)))) return false;
  const identifier = params.identifier;
  if (identifier && entry.SYSLOG_IDENTIFIER !== String(identifier)) return false;
  if (params.priority !== null && params.priority !== undefined) {
    const priority = Number.parseInt(String(entry.PRIORITY), 10);
    const limit = Number.parseInt(String(params.priority), 10);
    if (Number.isNaN(priority) || Number.isNaN(limit) || priority > limit) return false;
  }
  const needle = params.grep;
  if (needle && !message.includes(String(needle))) return false;
  return true;
}

// One stream's registration with the mux: its params and where its entries go.
interface JournalSub {
  params: Record<string, unknown>;
  deliver: (payload: Record<string, unknown> | null) => void;
}

// How the mux runs journalctl, so a test can stand in for it.
export type JournalSpawn = (args: string[]) => ChildProcess;

const default_spawn: JournalSpawn = (args) => spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "ignore"], detached: true });

// One shared journalctl follower serving every stream in its group.
class JournalGroup {
  readonly key: string;
  readonly subs = new Set<JournalSub>();
  private readonly spawn_journal: JournalSpawn;
  private stop_current: (() => void) | null = null;

  constructor(key: string, spawn_journal: JournalSpawn) {
    this.key = key;
    this.spawn_journal = spawn_journal;
  }

  add(sub: JournalSub): void {
    this.subs.add(sub);
    this.restart();
  }

  remove(sub: JournalSub): void {
    this.subs.delete(sub);
    this.restart();
  }

  private restart(): void {
    this.stop_current?.();
    this.stop_current = null;
    if (this.subs.size > 0) this.stop_current = this.run();
  }

  command(): string[] {
    const command = ["journalctl", "--follow", "--lines=0", "--output=json"];
    if (this.key === "unit") for (const unit of [...new Set([...this.subs].map((sub) => String(sub.params.unit)))].sort()) command.push("--unit", unit);
    else if (this.key === "identifier") for (const identifier of [...new Set([...this.subs].map((sub) => String(sub.params.identifier)))].sort()) command.push("--identifier", identifier);
    else if (this.key === "kernel") command.push("--dmesg");
    else {
      const only = [...this.subs][0];
      if (only.params.priority !== null && only.params.priority !== undefined) command.push("--priority", String(only.params.priority));
    }
    return command;
  }

  // Starts the follower after a short settle, so a burst of registrations builds one process; returns what stops it.
  private run(): () => void {
    let stopped = false;
    let child: ChildProcess | null = null;
    const timer = setTimeout(() => {
      if (stopped) return;
      try {
        child = this.spawn_journal(this.command());
      } catch (error) {
        log.warn(`journal follower '${this.key}' failed: ${(error as Error).message}`);
        this.fail();
        return;
      }
      child.on("error", (error) => log.warn(`journal follower '${this.key}' failed: ${error.message}`));
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => this.route(line));
      lines.on("close", () => {
        if (!stopped) this.fail();
      });
    }, JOURNAL_SETTLE_SECONDS * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (child !== null && child.exitCode === null) child.kill("SIGTERM");
    };
  }

  route(line: string): void {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    const message = String(record.MESSAGE ?? "");
    for (const sub of this.subs) {
      if (entry_matches(sub.params, record, message)) {
        sub.deliver({ message, unit: record._SYSTEMD_UNIT || record.UNIT || null, priority: record.PRIORITY ?? null, pid: record._PID ?? null, identifier: record.SYSLOG_IDENTIFIER ?? null });
      }
    }
  }

  // Tells every stream its follower died, so each restarts.
  private fail(): void {
    for (const sub of this.subs) sub.deliver(null);
  }
}

// Routes journal streams onto shared journalctl followers: streams filtering by unit ride one process carrying the
// union of their --unit flags, kernel streams share one --dmesg process, and identifier-only streams share one
// --identifier union; each stream's own filters apply while routing, so it sees exactly what its own journalctl
// would have shown. A membership change restarts the shared process, which can drop lines written in the gap.
export class JournalMux {
  readonly groups = new Map<string, JournalGroup>();
  private solo = 0;
  private readonly spawn_journal: JournalSpawn;

  constructor(spawn_journal: JournalSpawn = default_spawn) {
    this.spawn_journal = spawn_journal;
  }

  key(params: Record<string, unknown>): string {
    if (params.unit) return "unit";
    if (params.kernel) return "kernel";
    if (params.identifier) return "identifier";
    return `solo:${this.solo++}`;
  }

  // Delivers this stream's entries to `emit` until the signal aborts, throwing if its follower dies.
  async follow(params: Record<string, unknown>, emit: Emit, signal: AbortSignal): Promise<void> {
    const queue: (Record<string, unknown> | null)[] = [];
    let wake: (() => void) | null = null;
    const sub: JournalSub = { params, deliver: (payload) => { queue.push(payload); wake?.(); } };
    const key = this.key(params);
    let group = this.groups.get(key);
    if (group === undefined) {
      group = new JournalGroup(key, this.spawn_journal);
      this.groups.set(key, group);
    }
    group.add(sub);
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((resolve) => (wake = resolve)), aborted]);
          wake = null;
          continue;
        }
        const payload = queue.shift()!;
        if (payload === null) throw new Error("journalctl --follow exited");
        await emit(payload);
      }
    } finally {
      group.remove(sub);
      if (group.subs.size === 0) this.groups.delete(key);
    }
  }
}

const JOURNAL_MUX = new JournalMux();

// Follows the systemd journal and pushes each matching entry as it is written; streams share journalctl processes
// through the mux, so N unit monitors cost one follower. params: unit, priority (0-7), grep, identifier, kernel.
export const journal: Watcher = (params, emit, signal) => JOURNAL_MUX.follow(params, emit, signal);

// ── Paths ────────────────────────────────────────────────────────────────────

// Watches a filesystem path and pushes when its mtime or size changes, sampling locally, where a stat every quarter
// second is cheap. params: path (required), interval (seconds, default 0.25).
export const path: Watcher = async (params, emit, signal) => {
  const target = params.path;
  if (!target) throw new Error("path watcher requires a `path` param");
  const period = Number(params.interval ?? 0.25);
  let previous: string | undefined;
  while (!signal.aborted) {
    let current: [number, number] | null = null;
    try {
      const info = await stat(String(target));
      current = [info.mtimeMs / 1000, info.size];
    } catch {
      current = null;
    }
    const shown = JSON.stringify(current);
    if (previous !== undefined && shown !== previous) {
      await emit({ path: target, exists: current !== null, mtime: current?.[0] ?? null, size: current?.[1] ?? null });
    }
    previous = shown;
    await sleep(period, signal);
  }
};

// ── Samples ──────────────────────────────────────────────────────────────────

// Runs a command locally on a fast interval and pushes its output, every time or only when it changes; `max_quiet`
// suppresses unchanged results but still pushes at least every max_quiet seconds, so a monitor whose sample is its
// whole collection never reads as stale. params: command (required), interval (default 1), on_change, max_quiet.
export const sample: Watcher = async (params, emit, signal) => {
  const command = params.command;
  if (!command) throw new Error("sample watcher requires a `command` param");
  const period = Number(params.interval ?? 1.0);
  const max_quiet = params.max_quiet === null || params.max_quiet === undefined ? null : Number(params.max_quiet);
  const suppress_unchanged = Boolean(params.on_change) || max_quiet !== null;
  let previous: string | null = null;
  let last_emit = -Infinity;
  while (!signal.aborted) {
    const [exit_code, stdout, stderr] = await executor.run(String(command), Math.max(period, 5.0));
    const current = JSON.stringify([exit_code, stdout, stderr]);
    const now = performance.now() / 1000;
    const overdue = max_quiet !== null && now - last_emit >= max_quiet;
    if (!suppress_unchanged || current !== previous || overdue) {
      await emit({ exit_code, stdout, stderr });
      last_emit = performance.now() / 1000;
    }
    previous = current;
    await sleep(period, signal);
  }
};

export const WATCHERS: Record<string, Watcher> = { journal, path, sample };

// ── Supervision ──────────────────────────────────────────────────────────────

// One stream's event as the agent sends it.
export interface StreamEvent {
  stream: string;
  ts: number;
  payload: Record<string, unknown>;
}

// Runs one watcher until the signal aborts, restarting it after a failure.
export async function supervise(kind: string, stream_id: string, params: Record<string, unknown>, emit: (event: StreamEvent) => Promise<void>, signal: AbortSignal, watchers: Record<string, Watcher> = WATCHERS, backoff_seconds = RESTART_BACKOFF_SECONDS): Promise<void> {
  const watcher = Object.hasOwn(watchers, kind) ? watchers[kind] : undefined;
  if (watcher === undefined) {
    log.error(`stream '${stream_id}': unknown watcher kind '${kind}'`);
    return;
  }
  const stamped: Emit = (payload) => emit({ stream: stream_id, ts: Date.now() / 1000, payload });
  while (!signal.aborted) {
    try {
      await watcher(params, stamped, signal);
    } catch (error) {
      if (signal.aborted) return;
      log.warn(`stream '${stream_id}' (${kind}) failed: ${(error as Error).message}; restarting`);
    }
    try {
      await sleep(backoff_seconds, signal);
    } catch {
      return;
    }
  }
}
