// The server's half of the engine: the notification engine and the push exporters, which the core cannot build since
// they live on the server. They start once the engine has loaded its state, and a config reload that changes their
// section, or the monitor tree, starts them afresh.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_logger_for } from "../core/logging.ts";
import * as changes from "../core/state/changes.ts";
import { CHANGES } from "../core/state/changes.ts";
import type { ServerEngine } from "./engine_api.ts";
import { ExporterEngine } from "./exporters/index.ts";
import { iter_monitors } from "./monitor_tree.ts";
import { NotificationEngine } from "./notifications/index.ts";

const log = create_logger_for("x_monitor.core.coordination.engine");

// How often the services check whether the engine has finished loading.
const READY_POLL_MILLISECONDS = 200;

// ── Services ─────────────────────────────────────────────────────────────────

export class ServerServices {
  notifications: NotificationEngine | null = null;
  exporters: ExporterEngine | null = null;
  private readonly engine: ServerEngine;
  private started = false;
  private seen_version = -1;
  private seen_notifications = "";
  private seen_exporters = "";
  private unsubscribe: (() => void) | null = null;
  private ready_timer: NodeJS.Timeout | null = null;

  constructor(engine: ServerEngine) {
    this.engine = engine;
  }

  // Starts both once the engine is ready, and follows reloads after.
  start(): void {
    const wait = () => {
      if (!this.engine.ready) {
        this.ready_timer = setTimeout(wait, READY_POLL_MILLISECONDS);
        return;
      }
      this.ready_timer = null;
      this.start_now();
    };
    wait();
  }

  // Starts both at once, as a test or an already-ready engine does.
  start_now(): void {
    if (this.started) return;
    this.started = true;
    this.start_exporters();
    this.start_notifications();
    this.unsubscribe = CHANGES.subscribe((kind) => {
      if (kind === changes.MONITORS) queueMicrotask(() => this.after_reload());
    });
  }

  stop(): void {
    if (this.ready_timer !== null) clearTimeout(this.ready_timer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.exporters?.stop();
    this.notifications?.stop();
  }

  // Starts afresh what a reload changed: notifications for a new tree or section, exporters for a new section.
  after_reload(): void {
    const tree_changed = this.engine.monitors_version !== this.seen_version;
    if (tree_changed || JSON.stringify(this.section("notifications")) !== this.seen_notifications) {
      this.notifications?.stop(false);
      this.start_notifications();
    }
    if (JSON.stringify(this.section("exporters")) !== this.seen_exporters) {
      this.exporters?.stop();
      this.start_exporters();
    }
  }

  private section(name: "notifications" | "exporters"): Record<string, unknown> {
    return this.engine.config_loader?.[name] ?? {};
  }

  private start_notifications(): void {
    this.seen_version = this.engine.monitors_version;
    this.seen_notifications = JSON.stringify(this.section("notifications"));
    this.notifications = new NotificationEngine(this.engine.db, this.section("notifications"), this.engine.connectors?.agents ?? null);
    (this.engine as { notifications?: unknown }).notifications = this.notifications;
    // A broken notifications config must not stop the engine.
    try {
      this.notifications.start([...this.engine.plugins]);
    } catch (error) {
      log.error(`Failed to start notifications — none will be sent: ${(error as Error).message}`);
    }
  }

  private start_exporters(): void {
    this.seen_exporters = JSON.stringify(this.section("exporters"));
    this.exporters = new ExporterEngine(this.engine.db, this.section("exporters"));
    this.exporters.start(() => iter_monitors(this.engine.plugins));
  }
}
