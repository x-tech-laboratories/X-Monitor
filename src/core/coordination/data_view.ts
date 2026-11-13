// The read-only projection of stored state a monitor, and the page drawing it, may hold. Every method is a read served
// from the in-memory store; writes go through the engine, never through this view.

import type { DatabaseManager, LogLineModelDict, MetricModelDict, PluginEventDict } from "../database/database.ts";
import type { JobDict, MetricRecord } from "../state/records.ts";

export class PluginDataView {
  private readonly db: DatabaseManager;
  private readonly id: string;

  constructor(db: DatabaseManager, plugin_id: string) {
    this.db = db;
    this.id = plugin_id;
  }

  // ── This monitor's reads ─────────────────────────────────────────────────

  latest_metric(metric_name: string): MetricRecord | null {
    return this.db.latest_metric(this.id, metric_name);
  }

  latest_collector_metrics(): MetricRecord[] {
    return this.db.latest_collector_metrics(this.id);
  }

  latest_snapshot<Value = unknown>(fallback: Value | null = null): Value | null {
    return this.db.latest_snapshot<Value>(this.id, fallback);
  }

  get_setting(key: string, fallback: string | null = null): string | null {
    return this.db.get_setting(key, fallback);
  }

  // ── Reads the page and bespoke monitors need ─────────────────────────────

  latest_statuses(): Record<string, string> {
    return this.db.latest_statuses();
  }

  latest_status(plugin_id: string): string {
    return this.db.latest_status(plugin_id);
  }

  latest_status_time(plugin_id: string | null = null): Date | null {
    return this.db.latest_status_time(plugin_id || this.id);
  }

  collector_metrics(plugin_id: string, limit = 15): MetricModelDict[] {
    return this.db.collector_metrics(plugin_id, limit);
  }

  metric_history(plugin_id: string, metric_name: string, limit = 30): MetricRecord[] {
    return this.db.metric_history(plugin_id, metric_name, limit);
  }

  log_lines(target: string, filter_prefix = "", limit = 15): LogLineModelDict[] {
    return this.db.log_lines(target, filter_prefix, limit);
  }

  plugin_events(plugin_id = "", prefix = "", target = "", limit = 100): PluginEventDict[] {
    return this.db.plugin_events(plugin_id, prefix, target, limit);
  }

  job(job_id: number): JobDict | null {
    return this.db.get_job(job_id);
  }
}
