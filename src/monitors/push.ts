// A push (heartbeat) monitor for targets X-Monitor cannot reach itself: the target reports in through the REST API and
// the plugin never polls. commands() is empty, and each cycle only re-evaluates the staleness of the last heartbeat
// recorded via record_push(). Config: max_age (defaults to twice the interval), token (authenticates the pushing
// client; optional when a push-scoped API token from auth.tokens covers this monitor), target_host for display. A fresh
// heartbeat that reported "up" is online; no heartbeat yet, one older than max_age, or a last-reported "down" is failed.

import { CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { PushablePlugin } from "../core/contracts.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_age, format_duration, type PluginConfig } from "./base/plugin_helpers.ts";
import { parse_float, parse_int } from "./base/text_parsing.ts";

const default_layout: LayoutRow[] = [["status_card", "lastbeat_card", "maxage_card"], ["uptime_strip"], ["events"]];

const valid_push_statuses = new Set(["up", "down"]);

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Push extends Plugin implements PushablePlugin {
  override readonly RUNS_ON_AGENT = false;
  override readonly AVAILABILITY = true;
  readonly max_age: number;
  token: string | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.max_age = parse_int(config.max_age ?? this.interval * 2);
    this.token = (config.token as string | null | undefined) ?? null;
    this.target = String(config.target_host ?? this.name);
  }

  // Nothing to poll; the cycle still runs, through parse([]), to judge the heartbeat's staleness.
  override commands(): Command[] {
    return [];
  }

  override parse(_results: CmdResult[]): CollectResult {
    const last = this.data.latest_metric("last_push_epoch");
    if (last === null) return new CollectResult({ logs: [["No heartbeat received yet", "WARNING"]], status: "failed" });

    const age = Date.now() / 1000 - last.value;
    if (age > this.max_age) {
      return new CollectResult({ logs: [[`No heartbeat for ${format_age(Math.trunc(age))}, exceeds max_age of ${format_duration(this.max_age)}`, "ERROR"]], status: "failed" });
    }
    const last_reported = this.data.latest_metric("reported_up");
    if (last_reported !== null && last_reported.value === 0) return new CollectResult({ status: "failed" });
    return new CollectResult({ status: "online" });
  }

  // Records one heartbeat; `source` names the API token that sent it, for the event log.
  record_push(status: string = "up", message: string | null = null, value: number | null = null, source: string | null = null): boolean {
    if (!valid_push_statuses.has(status)) return false;
    const is_up = status === "up";
    const metrics: Record<string, number> = { last_push_epoch: Date.now() / 1000, reported_up: is_up ? 1 : 0 };
    if (value !== null && value !== undefined) metrics.value = parse_float(value);
    const via = source ? ` via ${source}` : "";
    const detail = message ? `: ${message}` : "";
    this.engine!.apply(this, new CollectResult({
      metrics,
      logs: [[`Heartbeat received (status=${status})${via}${detail}`, is_up ? "INFO" : "ERROR"]],
      status: is_up ? "online" : "failed",
    }));
    return true;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get last_heartbeat_text(): string {
    const last = this.data.latest_metric("last_push_epoch");
    if (last === null) return "Never";
    return format_age(Math.trunc(Date.now() / 1000 - last.value));
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        status_card: { metric: "reported_up", title: "LAST REPORTED STATUS", on_text: "UP", off_text: "DOWN" },
        lastbeat_card: { title: "LAST HEARTBEAT", value_attr: "last_heartbeat_text", refresh: true },
        maxage_card: { title: "MAX AGE", value: format_duration(this.max_age) },
        uptime_strip: { kind: "strip", metric: "reported_up", title: "REPORTED STATUS HISTORY" },
      },
      events: true,
    };
  }
}
