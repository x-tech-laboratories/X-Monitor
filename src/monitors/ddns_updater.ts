// Dynamic-DNS drift: keeps a domain's public record pointed at this network's real public IP. Uses the io_call escape
// hatch for sequential local IO on the X-Monitor host: fetch the public IP from echo services, resolve the record, and
// on drift GET the provider's update URL, throttled by min_interval. Config: domain / domain_file / domain_command,
// record_type, resolver, timeout, min_interval, update_url / update_url_file / update_url_command. In sync, or freshly
// updated, is online; drift with the update throttled is warning; a failed or unconfigured update is failed; no
// determinable public IP is unavailable, since nothing could be compared.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { CollectResult, dns_query, http_request, io_action_plan, type ActionOutcome, type ActionPlanResult, type DnsQuery, type DnsResult, type Result } from "../core/connectors/types.ts";
import type { ActionButtonSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { answer_values, record_type, resolve_now } from "./base/dns_lookup.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_age, type PluginConfig } from "./base/plugin_helpers.ts";

const ip_echo_services = ["https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.me/ip"];

const default_layout: LayoutRow[] = [
  ["status_card", "public_ip_card", "dns_ip_card"],
  ["sync_strip"],
  ["lastupdate_card"],
  ["events"],
];

function monotonic(): number {
  return performance.now() / 1000;
}

// What one cycle's io_call found.
export interface DdnsCycle {
  no_domain?: boolean;
  domain_error?: string | null;
  public_ip?: string | null;
  dns_ip?: string | null;
  // True when an update was accepted, false when it failed or could not be sent, null when none was sent.
  updated?: boolean | null;
  update_log?: string | null;
}

export class DdnsUpdater extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  private configured_domain: string | null;
  private readonly domain_file: string | null;
  private readonly domain_command: string | null;
  domain_error: string | null = null;
  readonly record_type: string;
  readonly resolver_addr: string;
  readonly min_interval: number;
  private readonly update_url: string | null;
  private readonly update_url_file: string | null;
  private readonly update_url_command: string | null;
  // Null means no attempt yet, since the monotonic clock starts near zero at boot.
  last_update_attempt: number | null = null;
  // The DNS lookup, swappable in a test.
  resolve_dns: (query: DnsQuery) => Promise<DnsResult> = (query) => resolve_now(query);

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.configured_domain = (config.domain as string | null | undefined) ?? null;
    this.domain_file = (config.domain_file as string | null | undefined) ?? null;
    this.domain_command = (config.domain_command as string | null | undefined) ?? null;
    this.record_type = record_type(config.record_type);
    this.resolver_addr = String(config.resolver ?? "8.8.8.8");
    this.timeout = Number(config.timeout ?? 10);
    this.min_interval = Number(config.min_interval ?? 300);
    this.update_url = (config.update_url as string | null | undefined) ?? null;
    this.update_url_file = (config.update_url_file as string | null | undefined) ?? null;
    this.update_url_command = (config.update_url_command as string | null | undefined) ?? null;
    this.target = this.domain || this.name;
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  // The domain being kept current, resolved once and remembered.
  get domain(): string | null {
    if (this.configured_domain === null) {
      [this.configured_domain, this.domain_error] = this.resolve_setting("domain", null, this.domain_file, this.domain_command);
    }
    return this.configured_domain;
  }

  // The update URL and the error that kept it from being read.
  resolve_update_url(): [url: string | null, error: string | null] {
    return this.resolve_setting("update_url", this.update_url, this.update_url_file, this.update_url_command);
  }

  // A setting given inline, in a file, or as a command's stdout, in that order of precedence, with its error.
  resolve_setting(option: string, value: string | null, file_path: string | null, command_text: string | null): [value: string | null, error: string | null] {
    if (value) return [value, null];
    if (file_path) {
      try {
        return [readFileSync(file_path, "utf8").trim(), null];
      } catch (error) {
        return [null, `Could not read ${option}_file: ${(error as Error).message}`];
      }
    }
    if (command_text) {
      const outcome = spawnSync("sh", ["-c", command_text], { encoding: "utf8", timeout: 10_000 });
      if (outcome.error) return [null, `${option}_command failed: ${outcome.error.message}`];
      if (outcome.status !== 0) return [null, `${option}_command failed: ${(outcome.stderr ?? "").trim()}`];
      return [(outcome.stdout ?? "").trim(), null];
    }
    return [null, null];
  }

  // ── IO ───────────────────────────────────────────────────────────────────

  async fetch_public_ip(): Promise<string | null> {
    for (const url of ip_echo_services) {
      const response = await this.engine!.http_fetch(http_request(url, { timeout: this.timeout }));
      if (response.error !== null || response.status_code === null) continue;
      const ip = response.text.trim();
      if (response.status_code === 200 && ip) return ip;
    }
    return null;
  }

  // The record's first value as dns_record would report it, or null when the lookup fails.
  async resolve_public_record(): Promise<string | null> {
    const result = await this.resolve_dns(dns_query(this.domain ?? "", { record_type: this.record_type, resolver: this.resolver_addr, timeout: this.timeout }));
    if (result.outcome !== "ok") return null;
    const values = answer_values(this.record_type, result.answer);
    return values.length > 0 ? values[0] : null;
  }

  // Sends the update and returns whether the provider accepted it, with the line to log.
  async push_update(update_url: string): Promise<[ok: boolean, message: string]> {
    const response = await this.engine!.http_fetch(http_request(update_url, { timeout: this.timeout }));
    if (response.error !== null || response.status_code === null) return [false, `Update request failed: ${response.error}`];
    const body = response.text.trim();
    const lowered = body.toLowerCase();
    const ok = response.status_code === 200 && (lowered.startsWith("good") || lowered.startsWith("nochg"));
    if (ok) return [true, `Update accepted: ${body}`];
    return [false, `Update rejected (HTTP ${response.status_code}): ${body.slice(0, 200)}`];
  }

  async collect(): Promise<DdnsCycle> {
    const result: DdnsCycle = { public_ip: await this.fetch_public_ip(), dns_ip: null, updated: null, update_log: null };
    if (!this.domain) return result;

    result.dns_ip = await this.resolve_public_record();

    if (result.public_ip && result.public_ip !== result.dns_ip) {
      const now = monotonic();
      if (this.last_update_attempt !== null && now - this.last_update_attempt < this.min_interval) {
        result.updated = null;
        return result;
      }
      this.last_update_attempt = now;

      const [update_url, url_error] = this.resolve_update_url();
      if (!update_url) {
        result.updated = false;
        result.update_log = url_error || "Drift detected but no update_url/update_url_file/update_url_command configured";
        return result;
      }

      const [ok, message] = await this.push_update(update_url);
      result.updated = ok;
      result.update_log = message;
    }
    return result;
  }

  // DDNS is sequential local IO (fetch the public IP, resolve DNS, compare, then push with throttling), so it uses the
  // io_call escape hatch rather than a request list.
  override io_call(): () => Promise<DdnsCycle> {
    if (!this.domain) return async () => ({ no_domain: true, domain_error: this.domain_error });
    return () => this.collect();
  }

  override parse_results(results: Result[]): CollectResult {
    const result = results[0] as unknown as DdnsCycle;
    if (result.no_domain) return CollectResult.failed(result.domain_error || "No domain/domain_file/domain_command configured");

    const public_ip = result.public_ip ?? null;
    const dns_ip = result.dns_ip ?? null;
    const updated = result.updated ?? null;

    if (public_ip === null) return CollectResult.unavailable("Could not determine public IP (all IP services failed)");

    const settings: Record<string, string> = { [`ddns:${this.id}:public_ip`]: public_ip };
    if (dns_ip) settings[`ddns:${this.id}:dns_ip`] = dns_ip;

    const in_sync = public_ip === dns_ip;
    const metrics: Record<string, number> = { in_sync: in_sync ? 1.0 : 0.0 };
    const shown_dns = dns_ip ?? "None";

    if (in_sync) return new CollectResult({ metrics, settings, logs: [[`${this.domain} -> ${dns_ip} (in sync)`, "INFO"]], status: "online" });

    if (updated === true) {
      metrics.last_update_epoch = Date.now() / 1000;
      return new CollectResult({ metrics, settings, logs: [[`${this.domain} was ${shown_dns}, updated to ${public_ip}`, "INFO"]], status: "online" });
    }
    if (updated === false) {
      return new CollectResult({
        metrics,
        settings,
        logs: [[`${this.domain} is ${shown_dns}, should be ${public_ip}, update failed` + (result.update_log ? `: ${result.update_log}` : ""), "ERROR"]],
        status: "failed",
      });
    }
    const since = Math.trunc(monotonic() - (this.last_update_attempt ?? 0));
    return new CollectResult({
      metrics,
      settings,
      logs: [[`${this.domain} is ${shown_dns}, should be ${public_ip}, update throttled (${format_age(since)} since last attempt)`, "WARNING"]],
      status: "warning",
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    return [{ name: "Force Update", action_id: "force_update", variant: "primary", icon: "sync" }];
  }

  override plan_action(action_id: string): ActionPlanResult {
    if (action_id !== "force_update") return null;
    return io_action_plan(async () => {
      const [update_url, url_error] = this.resolve_update_url();
      if (!update_url) return { ok: false, log: url_error || "Force Update: no update_url configured" };
      this.last_update_attempt = monotonic();
      const [ok, message] = await this.push_update(update_url);
      return { ok, log: message };
    });
  }

  override interpret_action(_action_id: string, result: unknown): ActionOutcome {
    const outcome = result as { ok: boolean; log: string };
    if (!outcome.ok) return CollectResult.failed(outcome.log);
    return new CollectResult({ metrics: { last_update_epoch: Date.now() / 1000 }, logs: [[outcome.log, "INFO"]], success: true });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get public_ip_text(): string {
    return this.data.get_setting(`ddns:${this.id}:public_ip`) || "--";
  }

  get dns_ip_text(): string {
    return this.data.get_setting(`ddns:${this.id}:dns_ip`) || "--";
  }

  get dns_ip_color(): string | null {
    const dns_ip = this.data.get_setting(`ddns:${this.id}:dns_ip`);
    if (!dns_ip) return null;
    const public_ip = this.data.get_setting(`ddns:${this.id}:public_ip`);
    return dns_ip === public_ip ? "online" : "failed";
  }

  get last_update_text(): string {
    const last_update = this.data.latest_metric("last_update_epoch");
    if (last_update === null) return "Never";
    return format_age(Math.trunc(Date.now() / 1000 - last_update.value));
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        status_card: { metric: "in_sync", title: "DDNS STATUS", on_text: "IN SYNC", off_text: "OUT OF SYNC" },
        public_ip_card: { title: "PUBLIC IP", value_attr: "public_ip_text", refresh: true },
        dns_ip_card: { title: "DNS RECORD", value_attr: "dns_ip_text", color_attr: "dns_ip_color" },
        lastupdate_card: { title: "LAST UPDATE PUSHED", value_attr: "last_update_text", refresh: true },
        sync_strip: { kind: "strip", metric: "in_sync", title: "SYNC HISTORY" },
      },
      events: true,
    };
  }
}
