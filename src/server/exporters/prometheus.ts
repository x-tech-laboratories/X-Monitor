// Prometheus exporter: the latest metrics and statuses in the text exposition format, served at /metrics.

// ── Imports ──────────────────────────────────────────────────────────────────

import { render_metrics } from "@x-tech-laboratories/x-libs/server/prometheus";

import type { MetricsSource } from "../../core/contracts.ts";

// ── Values ───────────────────────────────────────────────────────────────────

// Each status as a number: up is 1, info 0.75, warning 0.5, failed 0, and not measuring -1.
export const STATUS_VALUE: Record<string, number> = { online: 1.0, info: 0.75, warning: 0.5, failed: 0.0, unavailable: -1.0, offline: -1.0 };

export function status_value(state: string): number {
  return Object.hasOwn(STATUS_VALUE, state) ? STATUS_VALUE[state]! : -1.0;
}

// ── Rendering ────────────────────────────────────────────────────────────────

// The latest metrics and statuses in Prometheus text exposition format.
export function render(db: MetricsSource): string {
  const statuses = Object.entries(db.latest_statuses()).sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
  return render_metrics([
    {
      name: "x_monitor_up", type: "gauge", help: "Monitor status (1=online, 0.5=warning, 0=failed, -1=unavailable)",
      samples: statuses.map(([plugin_id, state]) => ({ labels: { monitor: plugin_id, state }, value: status_value(state) })),
    },
    {
      name: "x_monitor_metric", type: "gauge", help: "Latest value of a collected metric",
      samples: db.latest_metrics().map((row) => ({ labels: { monitor: row.plugin_id, target: row.target, metric: row.metric_name }, value: row.value })),
    },
  ]);
}
