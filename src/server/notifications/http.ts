// Channels that deliver a notification with an HTTP request: a generic webhook, and ntfy.

// ── Imports ──────────────────────────────────────────────────────────────────

import { deliver, type Fetch } from "@x-tech-laboratories/x-libs/server/notify/http";
import { ntfy_priority, ntfy_settings, ntfy_tags, send_ntfy, type NtfySettings } from "@x-tech-laboratories/x-libs/server/notify/ntfy";
import { fill_placeholders, send_webhook, webhook_settings, type WebhookSettings } from "@x-tech-laboratories/x-libs/server/notify/webhook";

import { Channel, per_status, type ChannelConfig, type Message } from "./channels.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const TIMEOUT_SECONDS = 10;

// ── Payloads ─────────────────────────────────────────────────────────────────

// The timestamp as local time with its offset, such as "2026-09-21T14:13:20+02:00", as Python's isoformat wrote it.
export function iso_with_offset(epoch_seconds: number): string {
  const moment = new Date(Math.trunc(epoch_seconds) * 1000);
  const two = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
  const offset = -moment.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())}T${two(moment.getHours())}:${two(moment.getMinutes())}:${two(moment.getSeconds())}${sign}${two(offset / 60)}:${two(offset % 60)}`;
}

// The values a webhook payload template can use, by placeholder name.
export function fields(message: Message): Record<string, string> {
  return {
    title: message.title,
    body: message.body,
    status: message.status,
    kind: message.kind,
    monitor_id: message.monitor_id,
    monitor_name: message.monitor_name,
    host: message.host,
    url: message.url ?? "",
    timestamp: message.timestamp ? iso_with_offset(message.timestamp) : "",
  };
}

// Fills `{name}` placeholders in every string of a template; unknown names are left as they are.
export function render(template: unknown, values: Record<string, string>): unknown {
  return fill_placeholders(template, values);
}

// The JSON a webhook sends when it has no template of its own.
export function default_payload(message: Message): Record<string, unknown> {
  return {
    title: message.title,
    body: message.body,
    status: message.status,
    kind: message.kind,
    monitor: { id: message.monitor_id, name: message.monitor_name, host: message.host },
    url: message.url,
    timestamp: fields(message).timestamp,
  };
}

// ── Channels ─────────────────────────────────────────────────────────────────

// A channel that sends one HTTP request per notification.
export abstract class HttpChannel extends Channel {
  // The fetch requests go through; a test hands in its own.
  fetch: Fetch | undefined = undefined;

  // Sends the request, throwing when it fails or the server does not accept it.
  async request(method: string, url: string, options: { json?: unknown; headers?: Record<string, string>; body?: string } = {}): Promise<void> {
    const headers = { ...(options.json !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers };
    const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;
    await deliver({ method, url, headers, body, fetch: this.fetch, timeout_in_milliseconds: TIMEOUT_SECONDS * 1000 });
  }
}

// Sends each notification to a URL, as JSON or as the payload template given.
export class WebhookChannel extends HttpChannel {
  static override readonly TYPE = "webhook";
  readonly settings: WebhookSettings;

  constructor(channel_id: string, config: ChannelConfig) {
    super(channel_id, config);
    this.settings = webhook_settings(config);
  }

  get url(): string {
    return this.settings.url;
  }

  async send(message: Message): Promise<void> {
    await send_webhook(this.settings, { values: fields(message), default_body: default_payload(message), fetch: this.fetch, timeout_in_milliseconds: TIMEOUT_SECONDS * 1000 });
  }
}

// Publishes each notification to an ntfy topic; tapping it opens the monitor's page.
export class NtfyChannel extends HttpChannel {
  static override readonly TYPE = "ntfy";
  static readonly DEFAULT_PRIORITY: Record<string, unknown> = { failed: "high", warning: "default", unavailable: "default", recovered: "low", flapping: "default" };
  static readonly DEFAULT_TAGS: Record<string, unknown> = { failed: "rotating_light", warning: "warning", unavailable: "grey_question", recovered: "white_check_mark", flapping: "repeat" };

  readonly settings: NtfySettings;
  readonly priority: Record<string, number>;
  readonly tags: Record<string, string[]>;

  constructor(channel_id: string, config: ChannelConfig) {
    super(channel_id, config);
    this.settings = ntfy_settings(config);
    this.priority = Object.fromEntries(Object.entries(per_status(config.priority, NtfyChannel.DEFAULT_PRIORITY, "priority")).map(([key, value]) => [key, ntfy_priority(value)]));
    this.tags = Object.fromEntries(Object.entries(per_status(config.tags, NtfyChannel.DEFAULT_TAGS, "tags")).map(([key, value]) => [key, ntfy_tags(value)]));
  }

  async send(message: Message): Promise<void> {
    await send_ntfy(this.settings, {
      title: message.title, message: message.body || message.title, priority: this.priority[message.key] ?? 3,
      tags: this.tags[message.key] ?? [], click: message.url,
    }, { fetch: this.fetch, timeout_in_milliseconds: TIMEOUT_SECONDS * 1000 });
  }
}
