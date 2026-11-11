// Desktop notifications for the session the agent runs in, through notify-send, so they reach whatever notification
// daemon the desktop runs. That needs the user's session bus, which only a process running as the logged-in user can
// reach: an agent running as a system service cannot show one.
//
// Every notification has a Dismiss button, and when the server sends a link, clicking the notification opens it with
// xdg-open. A notification given a timeout is closed by the agent when it runs out, whatever its urgency, since
// desktops keep critical ones on screen. Each notification can belong to a key, the monitor it is about: a newer one
// for the same key replaces it, and dismissing the key closes it.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { create_logger_for } from "../core/logging.ts";

const log = create_logger_for("x_monitor_agent.desktop");

export const URGENCIES = ["low", "normal", "critical"] as const;

// The icon name that stands for X-Monitor's own icon, which ships with the agent.
export const XMONITOR_ICON = "x-monitor";

export const ICON_FILE = fileURLToPath(new URL("../../resources/icon.svg", import.meta.url));

// How long to keep waiting for a click before giving up on a notification.
export const WAIT_SECONDS = 12 * 3600;

// How long notify-send may take to report the new notification's id.
export const ID_SECONDS = 10.0;

// ── Commands ─────────────────────────────────────────────────────────────────

// The notify-send argument list for one notification.
export function command(title: string, body: string, urgency: string, url: string | null, icon: string | null = null, replace_id: number | null = null, timeout = 0): string[] {
  const args = ["notify-send", "--app-name=X-Monitor", `--urgency=${urgency}`, "--print-id"];
  if (timeout) args.push(`--expire-time=${Math.trunc(timeout * 1000)}`);
  // "x-monitor" is the bundled icon; anything else is an icon theme name or a file here.
  if (icon) args.push(`--icon=${icon === XMONITOR_ICON ? ICON_FILE : icon}`);
  if (replace_id !== null) args.push(`--replace-id=${replace_id}`);
  if (url) args.push("--action=default=Open");
  // --wait keeps notify-send running until the notification closes, and prints the action's name if one was clicked.
  args.push("--action=dismiss=Dismiss", "--wait");
  return [...args, "--", title, body];
}

// The call that closes one notification through the desktop's notification service.
export function close_command(notification_id: number): string[] {
  return ["busctl", "--user", "call", "org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "CloseNotification", "u", String(notification_id)];
}

// ── Processes ────────────────────────────────────────────────────────────────

// A started program as the notifier drives it, so a test can stand in for notify-send, busctl and xdg-open.
export interface DesktopProcess {
  // The first line of stdout, or null once stdout ends without one.
  first_line(): Promise<string | null>;
  // Settles once the program has ended, with the rest of its stdout and its stderr.
  finished(): Promise<[stdout: string, stderr: string]>;
  exit_code(): number | null;
  kill(): void;
}

// Starts a program, rejecting when it cannot be started at all.
export type StartProcess = (args: string[]) => Promise<DesktopProcess>;

export const start_process: StartProcess = (args) => new Promise((resolve, reject) => {
  const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let line_waiters: ((line: string | null) => void)[] = [];
  let first: string | null | undefined;
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (first === undefined && stdout.includes("\n")) {
      const cut = stdout.indexOf("\n") + 1;
      first = stdout.slice(0, cut);
      stdout = stdout.slice(cut);
      for (const waiter of line_waiters) waiter(first);
      line_waiters = [];
    }
  });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const ended = new Promise<[string, string]>((settle) => child.on("close", () => {
    if (first === undefined) {
      first = null;
      for (const waiter of line_waiters) waiter(null);
    }
    settle([stdout, stderr]);
  }));
  child.on("error", reject);
  child.on("spawn", () => resolve({
    first_line: () => (first !== undefined ? Promise.resolve(first) : new Promise((settle) => line_waiters.push(settle))),
    finished: () => ended,
    exit_code: () => child.exitCode,
    kill: () => void child.kill("SIGKILL"),
  }));
});

function within<Value>(promise: Promise<Value>, seconds: number): Promise<Value | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), seconds * 1000);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const TIMED_OUT = Symbol("timed out");

// ── Notifier ─────────────────────────────────────────────────────────────────

interface Shown {
  id: number;
  // Stops waiting on the notification without closing it, as a newer one for its key replaces it.
  replace: () => void;
}

// Shows notifications and remembers which one each key has on screen.
export class Notifier {
  private readonly shown = new Map<string, Shown>();
  // Frames for one key are handled in arrival order, or a dismiss could overtake the notification it closes.
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly start: StartProcess;

  constructor(start: StartProcess = start_process) {
    this.start = start;
  }

  private locked<Value>(key: string | null, work: () => Promise<Value>): Promise<Value> {
    const name = key ?? "";
    const before = this.queues.get(name) ?? Promise.resolve();
    const next = before.then(work, work);
    this.queues.set(name, next.catch(() => undefined));
    return next;
  }

  // Shows the notification a notify message describes, and opens its link if it is clicked; resolves once it is closed
  // or replaced.
  async show(frame: Record<string, unknown>): Promise<void> {
    const title = String(frame.title || "X-Monitor");
    const body = String(frame.body || "");
    const urgency = (URGENCIES as readonly unknown[]).includes(frame.urgency) ? String(frame.urgency) : "normal";
    const url = frame.url ? String(frame.url) : null;
    const icon = frame.icon ? String(frame.icon) : null;
    const key = frame.key ? String(frame.key) : null;
    const timeout = Math.max(0, Number(frame.timeout || 0) || 0);

    let replaced = false;
    let mine: Shown | null = null;
    const started = await this.locked(key, async () => {
      let replace_id: number | null = null;
      const previous = key ? this.shown.get(key) : undefined;
      if (key && previous) {
        this.shown.delete(key);
        replace_id = previous.id;
        previous.replace();
      }
      let process: DesktopProcess;
      try {
        process = await this.start(command(title, body, urgency, url, icon, replace_id, timeout));
      } catch (error) {
        log.error(`could not show a desktop notification (is notify-send installed?): ${(error as Error).message}`);
        return null;
      }
      const first = await within(process.first_line(), ID_SECONDS);
      if (first === TIMED_OUT) {
        process.kill();
        await process.finished();
        return null;
      }
      const notification_id = first !== null && /^\s*\d+\s*$/.test(first) ? Number(first.trim()) : null;
      if (key && notification_id !== null) {
        mine = { id: notification_id, replace: () => { replaced = true; process.kill(); } };
        this.shown.set(key, mine);
      }
      return { process, notification_id };
    });
    if (started === null) return;
    const { process, notification_id } = started;
    try {
      const ended = await within(process.finished(), timeout || WAIT_SECONDS);
      if (replaced) return;
      if (ended === TIMED_OUT) {
        // Out of time: close it here, because a desktop keeps a critical notification regardless.
        if (timeout && notification_id !== null) await this.close(notification_id);
        if ((await within(process.finished(), 5)) === TIMED_OUT) {
          process.kill();
          await process.finished();
        }
        return;
      }
      const [rest, stderr] = ended;
      if (process.exit_code() !== 0) {
        log.error(`notify-send failed (${process.exit_code()}): ${stderr.trim()}`);
        return;
      }
      if (url && rest.trim() === "default") await this.open(url);
    } finally {
      if (key && mine !== null && this.shown.get(key) === mine) this.shown.delete(key);
    }
  }

  // Closes the notification a key has on screen, if any.
  async dismiss(frame: Record<string, unknown>): Promise<void> {
    const key = String(frame.key || "");
    const shown = await this.locked(key, async () => {
      const found = this.shown.get(key);
      this.shown.delete(key);
      return found;
    });
    if (shown !== undefined) await this.close(shown.id);
  }

  // Stops waiting on every notification, as the agent shuts down.
  cancel_all(): void {
    for (const shown of this.shown.values()) shown.replace();
    this.shown.clear();
  }

  // Closes one notification through the desktop's notification service.
  async close(notification_id: number): Promise<void> {
    let process: DesktopProcess;
    try {
      process = await this.start(close_command(notification_id));
    } catch (error) {
      log.error(`could not close a desktop notification (is busctl installed?): ${(error as Error).message}`);
      return;
    }
    const [, stderr] = await process.finished();
    if (process.exit_code() !== 0) log.error(`closing notification ${notification_id} failed: ${stderr.trim()}`);
  }

  // Opens a link in the user's browser.
  private async open(url: string): Promise<void> {
    let process: DesktopProcess;
    try {
      process = await this.start(["xdg-open", url]);
    } catch (error) {
      log.error(`could not open ${url} (is xdg-open installed?): ${(error as Error).message}`);
      return;
    }
    const [, stderr] = await process.finished();
    if (process.exit_code() !== 0) log.error(`xdg-open ${url} failed: ${stderr.trim()}`);
  }
}
