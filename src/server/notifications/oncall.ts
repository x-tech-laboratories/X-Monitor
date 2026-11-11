// On-call channels: PagerDuty and Opsgenie, which open one alert per monitor and close it on recovery.

// ── Imports ──────────────────────────────────────────────────────────────────

import { per_status, secret, type ChannelConfig, type Message } from "./channels.ts";
import { HttpChannel } from "./http.ts";

// ── Keys ─────────────────────────────────────────────────────────────────────

// The alert key a test notification uses, since it belongs to no monitor.
export const TEST_KEY = "x-monitor-test";

// The alert key that ties a monitor's problem to its recovery.
function alert_key(message: Message): string {
  return message.monitor_id || TEST_KEY;
}

// ── Channels ─────────────────────────────────────────────────────────────────

// An on-call service that keeps one open alert per monitor.
export abstract class OnCallChannel extends HttpChannel {
  override dismisses_on_recovery = true;

  abstract open_alert(message: Message): Promise<void>;
  abstract close_alert(message: Message): Promise<void>;

  async send(message: Message): Promise<void> {
    if (message.clears) {
      await this.close_alert(message);
      return;
    }
    await this.open_alert(message);
    // A test proves both halves and leaves nothing open.
    if (message.kind === "test") await this.close_alert(message);
  }

  // Each monitor keeps its own alert, so a batch is sent one by one.
  override async send_batch(messages: Message[]): Promise<void> {
    for (const message of messages) await this.send(message);
  }
}

function bad_values(values: Record<string, unknown>, allowed: readonly string[]): string[] {
  return [...new Set(Object.values(values).map(String))].filter((value) => !allowed.includes(value)).sort();
}

// Triggers and resolves PagerDuty incidents through the Events API v2.
export class PagerDutyChannel extends OnCallChannel {
  static override readonly TYPE = "pagerduty";
  static readonly DEFAULT_URL = "https://events.pagerduty.com/v2/enqueue";
  static readonly SEVERITIES = ["critical", "error", "warning", "info"];
  static readonly DEFAULT_SEVERITY: Record<string, string> = { failed: "critical", warning: "warning", unavailable: "error", recovered: "info", flapping: "warning" };

  readonly routing_key: string;
  readonly url: string;
  readonly severity: Record<string, string>;

  constructor(channel_id: string, config: ChannelConfig) {
    super(channel_id, config);
    const routing_key = secret(config, "routing_key");
    if (!routing_key) throw new Error("a pagerduty channel needs `routing_key` or `routing_key_file`");
    this.routing_key = routing_key;
    this.url = String(config.url || PagerDutyChannel.DEFAULT_URL);
    this.severity = per_status(config.severity, PagerDutyChannel.DEFAULT_SEVERITY, "severity");
    const bad = bad_values(this.severity, PagerDutyChannel.SEVERITIES);
    if (bad.length > 0) throw new Error(`\`severity\` must be critical, error, warning or info, not ${JSON.stringify(bad)}`);
  }

  private async event(action: string, message: Message, extra: Record<string, unknown>): Promise<void> {
    await this.request("POST", this.url, { json: { routing_key: this.routing_key, event_action: action, dedup_key: alert_key(message), ...extra } });
  }

  async open_alert(message: Message): Promise<void> {
    const payload: Record<string, unknown> = {
      summary: message.title.slice(0, 1024),
      source: message.host || "x-monitor",
      severity: String(this.severity[message.key] ?? "info"),
      custom_details: { details: message.body, status: message.status },
    };
    if (message.monitor_name) payload.component = message.monitor_name;
    const extra: Record<string, unknown> = { payload };
    if (message.url) extra.links = [{ href: message.url, text: "Open in X-Monitor" }];
    await this.event("trigger", message, extra);
  }

  async close_alert(message: Message): Promise<void> {
    await this.event("resolve", message, {});
  }
}

// Creates and closes Opsgenie alerts through the Alert API.
export class OpsgenieChannel extends OnCallChannel {
  static override readonly TYPE = "opsgenie";
  static readonly REGIONS: Record<string, string> = { us: "https://api.opsgenie.com", eu: "https://api.eu.opsgenie.com" };
  static readonly PRIORITIES = ["P1", "P2", "P3", "P4", "P5"];
  static readonly DEFAULT_PRIORITY: Record<string, string> = { failed: "P1", warning: "P3", unavailable: "P3", recovered: "P5", flapping: "P3" };

  readonly url: string;
  readonly priority: Record<string, string>;
  readonly headers: Record<string, string>;

  constructor(channel_id: string, config: ChannelConfig) {
    super(channel_id, config);
    const api_key = secret(config, "api_key");
    if (!api_key) throw new Error("an opsgenie channel needs `api_key` or `api_key_file`");
    const region = String(config.region ?? "us").toLowerCase();
    if (!Object.hasOwn(OpsgenieChannel.REGIONS, region) && !config.url) throw new Error(`\`region\` must be us or eu, not ${JSON.stringify(region)}`);
    this.url = String(config.url || OpsgenieChannel.REGIONS[region]).replace(/\/+$/, "");
    this.priority = per_status(config.priority, OpsgenieChannel.DEFAULT_PRIORITY, "priority");
    const bad = bad_values(this.priority, OpsgenieChannel.PRIORITIES);
    if (bad.length > 0) throw new Error(`\`priority\` must be P1 to P5, not ${JSON.stringify(bad)}`);
    this.headers = { Authorization: `GenieKey ${api_key}` };
  }

  async open_alert(message: Message): Promise<void> {
    const details: Record<string, string> = { status: message.status };
    if (message.url) details.url = message.url;
    const alert: Record<string, unknown> = {
      message: message.title.slice(0, 130),
      alias: alert_key(message),
      description: message.body.slice(0, 15000),
      priority: String(this.priority[message.key] ?? "P3"),
      source: "X-Monitor",
      details,
    };
    if (message.host) alert.entity = message.host;
    await this.request("POST", `${this.url}/v2/alerts`, { headers: this.headers, json: alert });
  }

  async close_alert(message: Message): Promise<void> {
    await this.request("POST", `${this.url}/v2/alerts/${encodeURIComponent(alert_key(message))}/close?identifierType=alias`, {
      headers: this.headers, json: { source: "X-Monitor", note: message.title },
    });
  }
}
