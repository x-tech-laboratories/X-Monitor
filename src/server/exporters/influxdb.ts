// InfluxDB exporter: pushes the latest metrics and statuses as line protocol every interval, to a 2.x bucket or a 1.x
// database.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { MetricsSource } from "../../core/contracts.ts";
import { create_logger_for } from "../../core/logging.ts";
import { python_float } from "./values.ts";
import { status_value } from "./prometheus.ts";

const log = create_logger_for("x_monitor.core.exporters.influxdb");

// ── Line protocol ────────────────────────────────────────────────────────────

function escape_tag(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll(" ", "\\ ").replaceAll("=", "\\=");
}

function line(measurement: string, tags: Record<string, string>, value: number, timestamp_ns: bigint): string {
  const tag_text = Object.entries(tags).filter(([, tag]) => tag !== "").map(([key, tag]) => `,${escape_tag(key)}=${escape_tag(tag)}`).join("");
  return `${measurement}${tag_text} value=${python_float(value)} ${timestamp_ns}`;
}

// One line-protocol payload from the latest metrics and statuses.
export function build_payload(db: MetricsSource, now_ms: number = Date.now()): string {
  const timestamp_ns = BigInt(Math.trunc(now_ms)) * 1_000_000n;
  const lines: string[] = [];
  for (const row of db.latest_metrics()) {
    lines.push(line("x_monitor_metric", { monitor: row.plugin_id, target: row.target, metric: row.metric_name }, row.value, timestamp_ns));
  }
  for (const [plugin_id, state] of Object.entries(db.latest_statuses())) {
    lines.push(line("x_monitor_up", { monitor: plugin_id, state }, status_value(state), timestamp_ns));
  }
  return lines.join("\n");
}

// ── Exporter ─────────────────────────────────────────────────────────────────

export class InfluxDBExporter {
  readonly url: string;
  readonly interval: number;
  readonly org: string | null;
  readonly bucket: string | null;
  readonly token: string | null;
  readonly database: string | null;
  // The fetch pushes go through; a test hands in its own.
  fetch: typeof fetch = fetch;
  private readonly db: MetricsSource;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(db: MetricsSource, config: Record<string, unknown>) {
    this.db = db;
    this.url = String(config.url).replace(/\/+$/, "");
    this.interval = Math.trunc(Number(config.interval ?? 30));
    this.org = config.org ? String(config.org) : null;
    this.bucket = config.bucket ? String(config.bucket) : null;
    this.token = config.token ? String(config.token) : null;
    this.database = config.database ? String(config.database) : null;
  }

  endpoint(): string {
    if (this.bucket && this.org) return `${this.url}/api/v2/write?org=${this.org}&bucket=${this.bucket}&precision=ns`;
    return `${this.url}/write?db=${this.database || "x-monitor"}&precision=ns`;
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
    if (this.token) headers.Authorization = `Token ${this.token}`;
    return headers;
  }

  async push_once(): Promise<void> {
    const payload = build_payload(this.db);
    if (!payload) return;
    const response = await this.fetch(this.endpoint(), { method: "POST", body: payload, headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (response.status >= 300) log.warn(`InfluxDB push failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }

  start(): void {
    log.info(`InfluxDB exporter started -> ${this.url} every ${this.interval}s`);
    const tick = async () => {
      // A failed push must not end the exporter loop; the next interval retries.
      try {
        await this.push_once();
      } catch (error) {
        log.warn(`InfluxDB push error: ${(error as Error).message}`);
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.interval * 1000);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}
