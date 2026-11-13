// Existence and correctness of one DNS record, resolved through a DnsQuery request issued from the X-Monitor host.
// Config: domain, record_type, resolver, port, timeout, expected (a list of acceptable answer values). NXDOMAIN, no
// answer, a query timeout or error, or any answer outside the expected list is failed; a resolving record, matching
// expected when that is set, is online. This monitor has no warning tier.

import { python_dumps, python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { CollectResult, dns_query, type DnsQuery, type DnsResult, type Request, type Result } from "../core/connectors/types.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { answer_values, failure_message, record_type } from "./base/dns_lookup.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";

const default_layout: LayoutRow[] = [
  ["status_card", "type_card", "ttl_card"],
  ["uptime_strip"],
  ["answer"],
  ["events"],
];

export class DnsRecord extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  override readonly AVAILABILITY = true;
  readonly domain: string | null;
  readonly record_type: string;
  readonly resolver_addr: string | null;
  readonly port: number;
  readonly dns_timeout: number;
  readonly expected: string[] | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.domain = (config.domain as string | null | undefined) ?? null;
    this.record_type = record_type(config.record_type);
    this.resolver_addr = (config.resolver as string | null | undefined) ?? null;
    this.port = Math.trunc(Number(config.port ?? 53));
    this.dns_timeout = Number(config.timeout ?? 5);
    const expected = config.expected as unknown[] | null | undefined;
    this.expected = expected && expected.length > 0 ? expected.map((value) => String(value).replace(/\.+$/, "")) : null;
    this.target = this.domain || this.name;
  }

  private query(): DnsQuery {
    return dns_query(this.domain ?? "", { record_type: this.record_type, resolver: this.resolver_addr, port: this.port, timeout: this.dns_timeout });
  }

  override requests(): Request[] {
    if (!this.domain) return [];
    return [this.query()];
  }

  // Turns the single DnsResult into resolved, ttl and match metrics, the answer values stored as a setting, and a
  // status that is failed for NXDOMAIN, no answer, timeout, query error, or any answer outside the expected list.
  override parse_results(results: Result[]): CollectResult {
    if (results.length === 0) return CollectResult.failed("No 'domain' configured");

    const result = results[0] as DnsResult;
    const failure = failure_message(result, this.query());
    if (failure !== null) return new CollectResult({ metrics: { resolved: 0.0 }, logs: [[failure, "ERROR"]], status: "failed" });

    const values = answer_values(this.record_type, result.answer);
    const ttl = result.answer?.ttl ?? null;

    const metrics: Record<string, number> = { resolved: 1.0 };
    if (ttl !== null) metrics.ttl = ttl;
    const settings = { [`dns_record:${this.id}`]: python_dumps(values) };

    if (this.expected !== null) {
      const unexpected = values.filter((value) => !this.expected!.includes(value));
      if (unexpected.length > 0) {
        metrics.matches_expected = 0.0;
        return new CollectResult({
          metrics,
          logs: [[`${this.domain} (${this.record_type}) resolved to ${python_repr(values)}, expected one of ${python_repr(this.expected)}`, "ERROR"]],
          status: "failed",
          settings,
        });
      }
      metrics.matches_expected = 1.0;
    }

    return new CollectResult({
      metrics,
      logs: [[`${this.domain} (${this.record_type}) -> ${python_repr(values)} (TTL ${ttl ?? "None"})`, "INFO"]],
      status: "online",
      settings,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  item_color(item: Record<string, unknown>): "online" | "failed" {
    const value = item.value;
    return this.expected === null || this.expected.includes(value as string) ? "online" : "failed";
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        status_card: { metric: "resolved", title: "RESOLUTION", on_text: "OK", off_text: "FAILED" },
        type_card: { title: "RECORD TYPE", value: this.record_type },
        ttl_card: { metric: "ttl", title: "TTL", format: "ttl_seconds" },
        uptime_strip: { kind: "strip", metric: "resolved", title: "RESOLUTION HISTORY" },
        answer: {
          repeat: {
            source: "setting",
            setting_key: "dns_record:{plugin_id}",
            item_label: "_none",
            item_value: "value",
            item_color_by: (item) => this.item_color(item),
            container: "chips",
            empty_text: "No answer yet",
          },
        },
      },
      events: true,
    };
  }
}
