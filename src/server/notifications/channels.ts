// Where notifications go. Each channel type turns one Message into a delivery and throws when the delivery fails, so
// the engine can retry it and report the failure.

// ── Imports ──────────────────────────────────────────────────────────────────

import { per_key, setting_secret } from "@x-tech-laboratories/x-libs/server/notify/settings";

import { parse_duration } from "../../monitors/base/plugin_helpers.ts";
import { worst_status } from "../../shared/status.ts";

// ── Messages ─────────────────────────────────────────────────────────────────

export interface MessageFields {
  title: string;
  body: string;
  status: string;
  kind: string;
  monitor_id?: string;
  url?: string | null;
  monitor_name?: string;
  host?: string;
  // Epoch seconds.
  timestamp?: number;
}

// One notification, in the form every channel sends.
export class Message {
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly kind: string;
  readonly monitor_id: string;
  readonly url: string | null;
  readonly monitor_name: string;
  readonly host: string;
  readonly timestamp: number;

  constructor(fields: MessageFields) {
    this.title = fields.title;
    this.body = fields.body;
    this.status = fields.status;
    this.kind = fields.kind;
    this.monitor_id = fields.monitor_id ?? "";
    this.url = fields.url ?? null;
    this.monitor_name = fields.monitor_name ?? "";
    this.host = fields.host ?? "";
    this.timestamp = fields.timestamp ?? 0;
  }

  // Whether this ends a problem that was announced, so its notification can be cleared.
  get clears(): boolean {
    return this.kind === "recovered";
  }

  // What a per-status channel setting is looked up by: the status, "recovered" or "flapping".
  get key(): string {
    if (this.clears) return "recovered";
    return this.kind === "flapping" ? "flapping" : this.status;
  }
}

// One notification standing for several that arrived together.
export function digest(messages: Message[], url: string | null): Message {
  const problems = messages.filter((message) => !message.clears);
  const counts = new Map<string, number>();
  for (const message of problems) {
    const label = message.kind === "flapping" ? "flapping" : message.status;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, count]) => `${count} ${label}`);
  if (problems.length < messages.length) parts.push(`${messages.length - problems.length} recovered`);
  const worst = problems.length > 0 ? worst_status(problems.map((message) => message.status)) : "online";
  return new Message({
    title: `X-Monitor: ${parts.join(", ")}`,
    body: messages.map((message) => `• ${message.title}`).join("\n"),
    status: worst,
    kind: problems.length > 0 ? "problem" : "recovered",
    monitor_id: "",
    url,
    monitor_name: "X-Monitor",
    host: "",
    timestamp: Math.max(...messages.map((message) => message.timestamp)),
  });
}

// ── Channels ─────────────────────────────────────────────────────────────────

// The agents a desktop channel shows notifications through, as the agent hub keeps them.
export interface DesktopAgent {
  capabilities: Iterable<string>;
  notify(title: string, body: string, urgency: string, url: string | null, icon: string, key: string | null, timeout: number): Promise<unknown>;
  dismiss(key: string): Promise<unknown>;
}

export interface AgentDirectory {
  get(agent_id: string): DesktopAgent | null | undefined;
}

export type ChannelConfig = Record<string, unknown>;

// A configured destination for notifications.
export abstract class Channel {
  static readonly TYPE: string = "";
  readonly id: string;
  readonly config: ChannelConfig;
  // Whether a recovery only clears the problem's notification, which is sent even while muted.
  dismisses_on_recovery = false;

  constructor(channel_id: string, config: ChannelConfig) {
    this.id = channel_id;
    this.config = config;
  }

  get type(): string {
    return (this.constructor as typeof Channel).TYPE;
  }

  abstract send(message: Message): Promise<void>;

  // Sends several notifications that arrived together; most channels send their digest.
  async send_batch(_messages: Message[], summary: Message): Promise<void> {
    await this.send(summary);
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

// A setting given inline as `key`, or as `key_file`, a file holding it that is read once.
export function secret(config: ChannelConfig, key: string): string | null {
  return setting_secret(config, key);
}

// The keys a per-status setting may use.
export const STATUS_KEYS = ["failed", "warning", "unavailable", "recovered", "flapping"] as const;

// A setting given once for all statuses, or per status with defaults for the rest.
export function per_status<Value>(value: unknown, defaults: Record<string, Value>, name: string): Record<string, Value> {
  return per_key(value, defaults, name, STATUS_KEYS);
}

function has_capability(capabilities: Iterable<string>, name: string): boolean {
  for (const capability of capabilities) if (capability === name) return true;
  return false;
}

// ── Desktop ──────────────────────────────────────────────────────────────────

const URGENCIES = ["low", "normal", "critical"];

// A desktop notification shown by an agent running in the user's graphical session.
export class DesktopChannel extends Channel {
  static override readonly TYPE = "desktop";
  static readonly DEFAULT_URGENCY: Record<string, string> = { failed: "critical", warning: "normal", unavailable: "normal", recovered: "low", flapping: "normal" };
  static readonly DEFAULT_ICON: Record<string, string> = Object.fromEntries(STATUS_KEYS.map((key) => [key, "x-monitor"]));

  readonly agent_id: string;
  readonly urgency: Record<string, string>;
  readonly icon: Record<string, string>;
  readonly timeout: number;
  private readonly agents: AgentDirectory;
  private readonly groups = new Map<string, { members: Map<string, Message>; url: string | null }>();
  private readonly member = new Map<string, string>();

  constructor(channel_id: string, config: ChannelConfig, agents: AgentDirectory | null = null) {
    super(channel_id, config);
    this.agent_id = String(config.agent || "");
    if (!this.agent_id) throw new Error("a desktop channel needs `agent:`, the id of the agent to show it");
    if (agents === null || agents.get(this.agent_id) == null) throw new Error(`agent ${JSON.stringify(this.agent_id)} is not declared in \`agents:\``);
    this.agents = agents;
    this.urgency = per_status(config.urgency, DesktopChannel.DEFAULT_URGENCY, "urgency");
    const bad = [...new Set(Object.values(this.urgency).map(String))].filter((value) => !URGENCIES.includes(value)).sort();
    if (bad.length > 0) throw new Error(`\`urgency\` must be low, normal or critical, not ${JSON.stringify(bad)}`);
    this.icon = per_status(config.icon, DesktopChannel.DEFAULT_ICON, "icon");
    this.dismisses_on_recovery = Boolean(config.dismiss_on_recovery ?? true);
    this.timeout = parse_duration(config.timeout === undefined ? "30s" : config.timeout || 0, "timeout");
  }

  private agent(): DesktopAgent {
    return this.agents.get(this.agent_id)!;
  }

  async send(message: Message): Promise<void> {
    const agent = this.agent();
    const in_group = await this.leave_group(message.monitor_id);
    if (message.clears && this.dismisses_on_recovery && message.monitor_id) {
      if (in_group) return;
      // An agent too old to dismiss shows the recovery instead.
      if (has_capability(agent.capabilities, "dismiss")) {
        await agent.dismiss(message.monitor_id);
        return;
      }
    }
    await this.show(message, message.monitor_id || null);
  }

  // Shows problems that arrived together as one notification that shrinks as each recovers.
  override async send_batch(messages: Message[], summary: Message): Promise<void> {
    const problems = messages.filter((message) => !message.clears);
    for (const message of messages) {
      if (message.clears || problems.length === 1) await this.send(message);
    }
    if (problems.length < 2) return;
    for (const message of problems) await this.leave_group(message.monitor_id);
    const key = `group:${problems[0]!.monitor_id}:${Math.trunc(summary.timestamp)}`;
    this.groups.set(key, { members: new Map(problems.map((message) => [message.monitor_id, message])), url: summary.url });
    for (const message of problems) this.member.set(message.monitor_id, key);
    await this.show_group(key);
  }

  private async show(message: Message, key: string | null): Promise<void> {
    await this.agent().notify(
      message.title, message.body, this.urgency[message.key] ?? "normal", message.url,
      String(this.icon[message.key] ?? DesktopChannel.DEFAULT_ICON.failed), key, this.timeout,
    );
  }

  private async show_group(key: string): Promise<void> {
    const group = this.groups.get(key)!;
    await this.show(digest([...group.members.values()], group.url), key);
  }

  // Takes a monitor out of the group notification it is in, updating or closing it.
  private async leave_group(monitor_id: string): Promise<boolean> {
    const key = this.member.get(monitor_id);
    if (key === undefined) return false;
    this.member.delete(monitor_id);
    const group = this.groups.get(key)!;
    group.members.delete(monitor_id);
    if (group.members.size > 0) {
      await this.show_group(key);
    } else {
      this.groups.delete(key);
      await this.agent().dismiss(key);
    }
    return true;
  }
}
