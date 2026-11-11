// The Notification Engine: watches every monitor's status writes on the change bus and sends a notification when a
// monitor's rule says the change matters: a new problem, a reminder while it lasts, or its recovery. Mutes, maintenance
// windows and the group window that batches notifications arriving together all apply here. See docs/notifications.md.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_logger_for } from "../../core/logging.ts";
import type { DatabaseManager } from "../../core/database/database.ts";
import * as changes from "../../core/state/changes.ts";
import { CHANGES, type ChangeKind } from "../../core/state/changes.ts";
import { format_duration, parse_duration } from "../../monitors/base/plugin_helpers.ts";
import { iter_monitors, parent_ids, type TreeMonitor } from "../monitor_tree.ts";
import { Channel, DesktopChannel, Message, digest, type AgentDirectory, type ChannelConfig } from "./channels.ts";
import { NtfyChannel, WebhookChannel } from "./http.ts";
import { AppriseChannel, SmtpChannel } from "./mail.ts";
import { parse_windows, type Window } from "./maintenance.ts";
import { OpsgenieChannel, PagerDutyChannel } from "./oncall.ts";
import { FLAPPING, HEALTHY_STATUSES, PROBLEM, RECOVERED, SETTLED, Tracker, resolve_rules, type Alert } from "./rules.ts";

const log = create_logger_for("x_monitor.core.notifications");

// ── Settings ─────────────────────────────────────────────────────────────────

// Seconds to wait before each retry of a failed delivery.
export const RETRY_DELAYS: readonly number[] = [5, 30];

// The setting that mutes one monitor, and everything beneath it when it is a group.
export function mute_setting(plugin_id: string): string {
  return `notifications.muted:${plugin_id}`;
}

type ChannelClass = new (channel_id: string, config: ChannelConfig, agents: AgentDirectory | null) => Channel;

export const CHANNEL_TYPES: Record<string, ChannelClass> = Object.fromEntries(
  [DesktopChannel, WebhookChannel, NtfyChannel, SmtpChannel, AppriseChannel, PagerDutyChannel, OpsgenieChannel]
    .map((type) => [type.TYPE, type as unknown as ChannelClass]),
);

// The parts of a monitor the engine reads.
export type NotifyingMonitor = TreeMonitor;

// What delivers a notification: a configured channel, or a test's stand-in.
export interface Sender {
  readonly id: string;
  dismisses_on_recovery?: boolean;
  send(message: Message): Promise<void>;
  send_batch?(messages: Message[], summary: Message): Promise<void>;
  readonly type?: string;
}

// ── Building ─────────────────────────────────────────────────────────────────

// The configured channels by id; a bad entry is logged and skipped.
export function build_channels(entries: unknown, agents: AgentDirectory | null): Map<string, Channel> {
  const channels = new Map<string, Channel>();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as ChannelConfig;
    const channel_id = String(entry.id || entry.type || "");
    if (!channel_id || channels.has(channel_id)) {
      log.error(`notifications: channel needs a unique \`id\`, skipping ${JSON.stringify(raw)}`);
      continue;
    }
    const type = Object.hasOwn(CHANNEL_TYPES, String(entry.type)) ? CHANNEL_TYPES[String(entry.type)] : undefined;
    if (type === undefined) {
      log.error(`notifications: channel ${JSON.stringify(channel_id)} has unknown type ${JSON.stringify(entry.type ?? null)}`);
      continue;
    }
    // A broken channel must not stop the others from working.
    try {
      channels.set(channel_id, new type(channel_id, entry, agents));
    } catch (error) {
      log.error(`notifications: channel ${JSON.stringify(channel_id)} disabled: ${(error as Error).message}`);
    }
  }
  return channels;
}

// The dashboard link to one monitor's page, when the dashboard's address is configured.
export function monitor_url(base_url: string | null | undefined, monitor_id: string): string | null {
  if (!base_url) return null;
  return `${base_url.replace(/\/+$/, "")}/monitor/${encodeURIComponent(monitor_id)}`;
}

const sleep = (seconds: number) => new Promise<void>((wake) => setTimeout(wake, seconds * 1000));

// ── Engine ───────────────────────────────────────────────────────────────────

// Owns the notification channels and decides when to use them.
export class NotificationEngine {
  readonly base_url: string | null;
  channels: Map<string, Sender>;
  readonly group_window: number;
  windows: Window[];
  retry_delays: readonly number[] = RETRY_DELAYS;
  tracker = new Tracker(new Map());
  private readonly db: DatabaseManager;
  private readonly defaults: Record<string, unknown>;
  private readonly held = new Set<string>();
  private readonly pending = new Map<string, Message[]>();
  private readonly monitors = new Map<string, NotifyingMonitor>();
  private parents = new Map<string, Set<string>>();
  private announced = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(db: DatabaseManager, settings: Record<string, unknown> | null | undefined, agents: AgentDirectory | null) {
    this.db = db;
    const given = settings ?? {};
    this.base_url = given.base_url ? String(given.base_url) : null;
    this.channels = build_channels(given.channels ?? [], agents);
    this.defaults = (given.defaults as Record<string, unknown>) || {};
    this.group_window = parse_duration(given.group_window || 0, "group_window");
    this.windows = parse_windows(given.maintenance ?? []);
  }

  // Whether start() is watching the change bus.
  get watching(): boolean {
    return this.unsubscribe !== null;
  }

  // Resolves each monitor's rule and starts watching status writes.
  start(roots: NotifyingMonitor[]): void {
    if (this.channels.size === 0) return;
    const rules = resolve_rules(roots, this.defaults, [...this.channels.keys()]);
    this.tracker = new Tracker(rules);
    this.parents = parent_ids(roots);
    for (const monitor of iter_monitors(roots)) this.monitors.set(monitor.id, monitor);

    const now = Date.now() / 1000;
    for (const [plugin_id, record] of this.db.store.statuses) this.tracker.seed(plugin_id, record.state, record.timestamp.getTime() / 1000, now);
    this.announced = new Set([...rules.keys()].filter((plugin_id) => this.tracker.alerting(plugin_id)));

    this.unsubscribe = CHANGES.subscribe((kind, plugin_id) => this.on_change(kind, plugin_id));
    log.info(`Notifications: ${this.channels.size} channel(s), ${rules.size} monitor(s) notify`);
  }

  // Stops watching status writes; a config reload keeps deliveries already under way.
  stop(cancel_deliveries = true): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!cancel_deliveries) return;
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private on_change(kind: ChangeKind, plugin_id: string | null): void {
    if (kind !== changes.STATUS || plugin_id === null || !this.tracker.rules.has(plugin_id)) return;
    const status = this.db.latest_status(plugin_id);
    const now = Date.now() / 1000;
    queueMicrotask(() => this.observe(plugin_id, status, now));
  }

  // A monitor's display name, falling back to its id.
  monitor_name(plugin_id: string): string {
    return this.monitors.get(plugin_id)?.name ?? plugin_id;
  }

  // The monitor or group whose mute silences this monitor, or null.
  muted_by(plugin_id: string): string | null {
    return this.lineage(plugin_id).find((current) => this.db.get_setting(mute_setting(current)) === "1") ?? null;
  }

  // A monitor's id followed by the ids of every group above it in any view, nearest first.
  private lineage(plugin_id: string): string[] {
    const ids = [plugin_id];
    const queue = [plugin_id];
    while (queue.length > 0) {
      for (const parent of [...(this.parents.get(queue.shift()!) ?? [])].sort()) {
        if (!ids.includes(parent)) {
          ids.push(parent);
          queue.push(parent);
        }
      }
    }
    return ids;
  }

  // The name of the maintenance window covering this monitor right now, or null.
  maintenance_for(plugin_id: string, now: Date = new Date()): string | null {
    const lineage = this.lineage(plugin_id);
    return this.windows.find((window) => window.covers(lineage) && window.active(now))?.name ?? null;
  }

  // The maintenance windows in effect right now.
  active_windows(now: Date = new Date()): Window[] {
    return this.windows.filter((window) => window.active(now));
  }

  // Mutes or unmutes one monitor, or a group and everything beneath it.
  set_muted(plugin_id: string, muted: boolean): void {
    this.db.set_setting(mute_setting(plugin_id), muted ? "1" : "0");
  }

  // The monitors and groups muted directly.
  muted_monitors(): NotifyingMonitor[] {
    return [...this.monitors].filter(([plugin_id]) => this.db.get_setting(mute_setting(plugin_id)) === "1").map(([, monitor]) => monitor);
  }

  private observe(plugin_id: string, status: string, now: number): void {
    if (this.stopped) return;
    let alert = this.tracker.observe(plugin_id, status, now);
    const in_maintenance = this.maintenance_for(plugin_id, new Date(now * 1000)) !== null;
    if (alert === null && this.held.has(plugin_id) && !in_maintenance) {
      // A problem held back by a maintenance window is announced once the window is over.
      this.held.delete(plugin_id);
      if (!this.announced.has(plugin_id) && this.muted_by(plugin_id) === null) alert = this.tracker.problem(plugin_id);
    }
    if (alert === null) return;
    if (in_maintenance && alert.kind !== RECOVERED) this.held.add(plugin_id);
    const muted = this.muted_by(plugin_id) !== null || in_maintenance;
    let channels = this.tracker.rules.get(plugin_id)!.channels.map((id) => this.channels.get(id)).filter((channel) => channel !== undefined);
    if (alert.kind === RECOVERED) {
      const announced = this.announced.has(plugin_id);
      this.announced.delete(plugin_id);
      // A recovery is only news if its problem was announced; muted, it only clears that notification.
      if (!announced) return;
      if (muted) channels = channels.filter((channel) => channel.dismisses_on_recovery === true);
    } else if (muted) {
      return;
    } else {
      this.announced.add(plugin_id);
    }
    const message = this.message(plugin_id, alert, now);
    for (const channel of channels) this.enqueue(channel, message);
  }

  // Sends now, or holds for the group window so notifications arriving together go as one.
  private enqueue(channel: Sender, message: Message): void {
    if (!this.group_window) {
      void this.deliver(channel, [message]);
      return;
    }
    const pending = this.pending.get(channel.id) ?? [];
    this.pending.set(channel.id, pending);
    pending.push(message);
    if (pending.length === 1) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.flush(channel);
      }, this.group_window * 1000);
      this.timers.add(timer);
    }
  }

  private flush(channel: Sender): void {
    const messages = this.pending.get(channel.id) ?? [];
    this.pending.delete(channel.id);
    if (messages.length > 0) void this.deliver(channel, messages);
  }

  // The notification for one alert on one monitor.
  message(plugin_id: string, alert: Alert, now: number): Message {
    const monitor = this.monitors.get(plugin_id);
    const name = monitor?.name ?? plugin_id;
    const status = alert.status;
    let title: string;
    let detail: string;
    if (alert.kind === RECOVERED && alert.settled) {
      title = HEALTHY_STATUSES.includes(status) ? `${name} stopped flapping and recovered` : `${name} stopped flapping and is ${status}`;
      detail = "";
    } else if (alert.kind === RECOVERED) {
      title = HEALTHY_STATUSES.includes(status) ? `${name} recovered` : `${name} is ${status}`;
      detail = `Was down for ${format_duration(Math.trunc(now - alert.since))}`;
    } else if (alert.kind === FLAPPING) {
      const window = format_duration(this.tracker.rules.get(plugin_id)!.flap_window);
      title = `${name} is flapping`;
      detail = `Its status keeps changing, so nothing more is sent until it holds steady for ${window}.`;
    } else if (alert.kind === SETTLED) {
      title = `${name} stopped flapping and is ${status}`;
      detail = this.reason(plugin_id, name);
    } else {
      title = alert.kind === PROBLEM ? `${name} is ${status}` : `${name} is still ${status}`;
      detail = this.reason(plugin_id, name);
    }
    const target = monitor?.target || "";
    const body = [detail, target ? `Host: ${target}` : ""].filter((line) => line).join("\n");
    return new Message({ title, body, status: alert.status, kind: alert.kind, monitor_id: plugin_id, url: monitor_url(this.base_url, plugin_id), monitor_name: name, host: target, timestamp: now });
  }

  // The monitor's latest event, which says why its status changed.
  private reason(plugin_id: string, name: string): string {
    const events = this.db.store.plugin_events(plugin_id, "", "", 1);
    if (events.length === 0) return "";
    const prefix = `[${name}] `;
    const message = events[0]!.message;
    return message.startsWith(prefix) ? message.slice(prefix.length) : message;
  }

  // Sends one notification about several monitors through every channel any of them notifies on, unless they are all muted or in maintenance.
  send_summary(title: string, body: string, monitor_ids: string[], status: string): void {
    const now = Date.now() / 1000;
    const channel_ids: string[] = [];
    for (const plugin_id of monitor_ids) {
      const rule = this.tracker.rules.get(plugin_id);
      if (rule === undefined || this.muted_by(plugin_id) !== null) continue;
      if (this.maintenance_for(plugin_id, new Date(now * 1000)) !== null) continue;
      for (const channel of rule.channels) if (!channel_ids.includes(channel)) channel_ids.push(channel);
    }
    const message = new Message({ title, body, status, kind: "summary", url: this.base_url, timestamp: now });
    for (const channel_id of channel_ids) {
      const channel = this.channels.get(channel_id);
      if (channel !== undefined) void this.deliver(channel, [message]);
    }
  }

  // Sends a test notification through one channel, throwing if it fails.
  async send_test(channel_id: string): Promise<void> {
    const channel = this.channels.get(channel_id);
    if (channel === undefined) throw new Error(`no channel ${JSON.stringify(channel_id)}`);
    await channel.send(new Message({
      title: "X-Monitor test notification", body: `Sent through the ${JSON.stringify(channel_id)} channel.`,
      status: "online", kind: "test", url: this.base_url, timestamp: Date.now() / 1000,
    }));
  }

  // Sends one notification, or several as one batch, retrying before reporting a failure.
  async deliver(channel: Sender, messages: Message[]): Promise<void> {
    const summary = messages.length === 1 ? messages[0]! : digest(messages, this.base_url);
    let error: unknown = null;
    const delays = [0, ...this.retry_delays];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]! > 0) await sleep(delays[attempt]!);
      if (this.stopped) return;
      // Any failure is retried, then reported; a broken channel must not stop the others.
      try {
        if (messages.length === 1) await channel.send(summary);
        else if (channel.send_batch) await channel.send_batch(messages, summary);
        else await channel.send(summary);
        log.info(`Notified ${JSON.stringify(channel.id)}: ${summary.title}`);
        return;
      } catch (problem) {
        error = problem;
        log.warn(`Notification to ${JSON.stringify(channel.id)} failed (try ${attempt + 1}): ${(problem as Error).message}`);
      }
    }
    this.db.insert_event(
      "WARNING",
      `[notifications] Could not notify ${JSON.stringify(channel.id)} that ${summary.title}: ${(error as Error)?.message ?? String(error)}`,
      "x_monitor_core", summary.monitor_id || null,
    );
  }
}

export { Channel, Message, digest };
