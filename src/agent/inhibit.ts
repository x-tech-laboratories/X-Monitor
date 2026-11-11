// Keeping the host awake while a task runs. A monitored host that suspends when idle, such as a phone, would otherwise
// fall asleep part-way through a long command or a scan aimed at it, so the agent holds one logind idle inhibitor for
// as long as anything wants the host awake: every command it runs, and every hold the server asks for on behalf of a
// task running elsewhere. It blocks the automatic idle suspend only, so a suspend the user asks for still goes ahead.
//
// The lock is a systemd-inhibit child reading the agent's pipe. When the agent dies, however it dies, the pipe closes
// and the lock goes with it, so a restart can never leave the host held awake.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import { create_logger_for } from "../core/logging.ts";

const log = create_logger_for("x_monitor_agent.inhibit");

// How long the lock outlives its last holder, so a burst of short commands shares one lock.
export const LINGER_SECONDS = 5.0;

// The program's full path on PATH, or null, as shutil.which finds it.
export function which(name: string): string | null {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// A counted idle inhibitor: taken on the first hold, released a moment after the last.
export class IdleInhibitor {
  private readonly linger: number;
  private readonly find: (name: string) => string | null;
  private holders_count = 0;
  private process: ChildProcess | null = null;
  private release_timer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;
  // Taking or dropping the lock starts or stops a process, so concurrent holds wait here rather than each starting one.
  private switching: Promise<void> = Promise.resolve();

  constructor(linger: number = LINGER_SECONDS, find: (name: string) => string | null = which) {
    this.linger = linger;
    this.find = find;
  }

  get holders(): number {
    return this.holders_count;
  }

  get is_locked(): boolean {
    return this.process !== null && this.process.exitCode === null && this.process.signalCode === null;
  }

  private serially(work: () => Promise<void>): Promise<void> {
    this.switching = this.switching.then(work, work);
    return this.switching;
  }

  // Adds a holder, taking the lock if this is the first one.
  async acquire(): Promise<void> {
    this.holders_count += 1;
    if (this.release_timer !== null) {
      clearTimeout(this.release_timer);
      this.release_timer = null;
    }
    await this.serially(async () => {
      if (!this.is_locked && this.holders_count > 0) this.lock();
    });
  }

  // Drops a holder; the lock goes once none is left for the linger period.
  release(): void {
    if (this.holders_count === 0) return;
    this.holders_count -= 1;
    if (this.holders_count === 0 && this.release_timer === null) {
      this.release_timer = setTimeout(() => {
        this.release_timer = null;
        void this.serially(async () => {
          if (this.holders_count === 0) await this.unlock();
        });
      }, this.linger * 1000);
    }
  }

  // Holds the host awake while the work runs.
  async held<Value>(work: () => Promise<Value>): Promise<Value> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  // Releases the lock now, whatever still holds it.
  async close(): Promise<void> {
    if (this.release_timer !== null) {
      clearTimeout(this.release_timer);
      this.release_timer = null;
    }
    this.holders_count = 0;
    await this.serially(() => this.unlock());
  }

  private lock(): void {
    const binary = this.find("systemd-inhibit");
    if (binary === null) {
      this.warn_once("systemd-inhibit is not on PATH, so tasks cannot keep this host awake");
      return;
    }
    const child = spawn(binary, ["--what=idle", "--mode=block", "--who=x-monitor-agent", "--why=An X-Monitor task is running", "cat"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) => {
      if (this.process === child) this.process = null;
      this.warn_once(`could not start systemd-inhibit: ${error.message}`);
    });
    child.stdin!.on("error", () => undefined);
    this.process = child;
  }

  private async unlock(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Closing the pipe ends the child's `cat`, which is what releases the lock.
    child.stdin?.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }

  private warn_once(message: string): void {
    if (this.warned) return;
    log.warn(message);
    this.warned = true;
  }
}
