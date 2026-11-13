// The Exporter Engine: presents the Database Engine's data to external systems. Prometheus is a pull exporter, a pure
// render served at /metrics; InfluxDB and MQTT are push exporters this engine starts and stops with the config.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { MetricsSource } from "../../core/contracts.ts";
import { create_logger_for } from "../../core/logging.ts";
import { InfluxDBExporter } from "./influxdb.ts";
import { MQTTExporter, type ListedMonitor } from "./mqtt.ts";
import { render } from "./prometheus.ts";

const log = create_logger_for("x_monitor.core.exporters");

// ── Engine ───────────────────────────────────────────────────────────────────

interface PushExporter {
  start(): void;
  stop(): void;
}

// The exporter classes, so a test can stand in for one.
export const exporter_types = {
  influxdb: (db: MetricsSource, config: Record<string, unknown>): PushExporter => new InfluxDBExporter(db, config),
  mqtt: (db: MetricsSource, config: Record<string, unknown>, monitors?: () => Iterable<ListedMonitor>): PushExporter => new MQTTExporter(db, config, { monitors }),
};

// Owns the configured push exporters, built from the `exporters` config block.
export class ExporterEngine {
  readonly exporters: PushExporter[] = [];
  private readonly db: MetricsSource;
  private readonly config: Record<string, unknown>;

  constructor(db: MetricsSource, exporters_config: Record<string, unknown> | null | undefined = null) {
    this.db = db;
    this.config = exporters_config ?? {};
  }

  // Starts every configured push exporter; `monitors` lists the live monitors for exporters that describe them.
  start(monitors?: () => Iterable<ListedMonitor>): void {
    const influx = this.config.influxdb as Record<string, unknown> | undefined;
    if (influx && influx.url) {
      // A broken exporter config must not stop the engine from starting.
      try {
        const exporter = exporter_types.influxdb(this.db, influx);
        exporter.start();
        this.exporters.push(exporter);
        log.info("InfluxDB exporter task started.");
      } catch (error) {
        log.error(`Failed to start InfluxDB exporter — metrics will not be pushed: ${(error as Error).message}`);
      }
    }
    const mqtt = this.config.mqtt as Record<string, unknown> | undefined;
    if (mqtt && mqtt.host) {
      // A broken MQTT config must not stop the engine from starting.
      try {
        const exporter = exporter_types.mqtt(this.db, mqtt, monitors);
        exporter.start();
        this.exporters.push(exporter);
      } catch (error) {
        log.error(`Failed to start MQTT exporter — nothing will be published: ${(error as Error).message}`);
      }
    }
  }

  // Stops every push exporter start() began, so a config reload can start the new set.
  stop(): void {
    for (const exporter of this.exporters) exporter.stop();
    this.exporters.length = 0;
  }

  // The Prometheus page, rendered from the current metrics and statuses.
  static render_prometheus(db: MetricsSource): string {
    return render(db);
  }
}
