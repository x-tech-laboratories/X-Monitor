// MQTT exporter: publishes every monitor's status and metrics, with Home Assistant discovery. It publishes on every
// status and metric change, coalescing a burst into one pass, republishes everything on each (re)connect and when Home
// Assistant announces it has started, and reconnects with backoff when the broker is down or drops it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { reading_traits, slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import type { MetricsSource } from "../../core/contracts.ts";
import type { MetricRowDict } from "../../core/database/database.ts";
import { create_logger_for } from "../../core/logging.ts";
import * as changes from "../../core/state/changes.ts";
import { CHANGES, type ChangeKind } from "../../core/state/changes.ts";
import { parse_duration } from "../../monitors/base/plugin_helpers.ts";
import { secret } from "../notifications/channels.ts";
import { python_float } from "./values.ts";

const log = create_logger_for("x_monitor.core.exporters.mqtt");

// ── Settings ─────────────────────────────────────────────────────────────────

export const STATUS_OPTIONS = ["online", "warning", "failed", "unavailable"] as const;

// Seconds a change waits so a burst of writes goes out as one publish pass.
export const COALESCE_SECONDS = 1.0;
export const backoff = { min: 1.0, max: 60.0 };

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Monitor {
  id: string;
  name: string;
  target: string;
}

export interface MqttMessage {
  topic: string;
  payload: Buffer | string;
  retain: boolean;
}

// One connection to the broker, as the exporter uses it.
export interface MqttSession {
  publish(topic: string, payload: string, options: { qos: 0 | 1; retain: boolean }): Promise<void>;
  subscribe(topic: string): Promise<void>;
  // Every message on a subscribed topic; it throws once the connection drops.
  messages(): AsyncIterable<MqttMessage>;
  end(): Promise<void>;
}

export type SessionFactory = () => Promise<MqttSession>;

// ── Naming ───────────────────────────────────────────────────────────────────

export { slug };

// The Home Assistant device class, unit and state class a metric's name implies.
export function metric_traits(metric: string): Record<string, string> {
  return reading_traits(metric);
}

// A stored status mapped onto the four the status sensor declares.
export function normalize_status(state: string | null | undefined): string {
  return state && (STATUS_OPTIONS as readonly string[]).includes(state) ? state : "unavailable";
}

// A metric value as an MQTT payload.
export function format_value(value: number): string {
  return python_float(value);
}

function device(base: string, target: string): Record<string, unknown> {
  return { identifiers: [`${slug(base)}_${slug(target)}`], name: target, manufacturer: "X-Monitor", model: "Monitored host" };
}

function common(base: string, monitor: Monitor): Record<string, unknown> {
  return { availability_topic: `${base}/status`, device: device(base, monitor.target), origin: { name: "X-Monitor" } };
}

// The topic carrying a monitor's status.
export function status_topic(base: string, monitor_id: string): string {
  return `${base}/${slug(monitor_id)}/status`;
}

// The topic carrying one metric of a monitor.
export function metric_topic(base: string, monitor_id: string, metric: string): string {
  return `${base}/${slug(monitor_id)}/${slug(metric)}`;
}

// The discovery topics and payloads of a monitor's status sensor and problem binary sensor.
export function status_configs(base: string, prefix: string, monitor: Monitor): [string, Record<string, unknown>][] {
  const node = slug(monitor.id);
  const unique = `${slug(base)}_${slug(monitor.id)}`;
  const state = status_topic(base, monitor.id);
  const status = {
    ...common(base, monitor), name: `${monitor.name} status`, unique_id: `${unique}_status`, state_topic: state,
    device_class: "enum", options: [...STATUS_OPTIONS], icon: "mdi:list-status",
  };
  const problem = {
    ...common(base, monitor), name: `${monitor.name} problem`, unique_id: `${unique}_problem`, state_topic: state,
    device_class: "problem", value_template: "{{ 'OFF' if value == 'online' else 'ON' }}",
  };
  return [
    [`${prefix}/sensor/${slug(base)}_${node}/status/config`, status],
    [`${prefix}/binary_sensor/${slug(base)}_${node}/problem/config`, problem],
  ];
}

// The discovery topic and payload of one metric's sensor.
export function metric_config(base: string, prefix: string, monitor: Monitor, metric: string): [string, Record<string, unknown>] {
  const node = slug(monitor.id);
  const object = slug(metric);
  const payload = {
    ...common(base, monitor), name: `${monitor.name} ${metric.replaceAll("_", " ")}`, unique_id: `${slug(base)}_${node}_${object}`,
    state_topic: metric_topic(base, monitor.id, metric), ...metric_traits(metric),
  };
  return [`${prefix}/sensor/${slug(base)}_${node}/${object}/config`, payload];
}

// ── The mqtt package ─────────────────────────────────────────────────────────

interface ClientSettings {
  host: string;
  port: number;
  tls: unknown;
  username: string | null;
  password: string | null;
  client_id: string;
  availability_topic: string;
}

// The options mqtt.js is given: no reconnecting of its own, and a retained last will saying offline.
export function client_options(settings: ClientSettings): Record<string, unknown> {
  const options: Record<string, unknown> = {
    host: settings.host, port: settings.port, protocol: settings.tls ? "mqtts" : "mqtt", clientId: settings.client_id,
    connectTimeout: 10_000, reconnectPeriod: 0,
    will: { topic: settings.availability_topic, payload: Buffer.from("offline"), qos: 1, retain: true },
  };
  if (settings.username) options.username = settings.username;
  if (settings.password) options.password = settings.password;
  if (settings.tls && typeof settings.tls === "object") {
    const tls = settings.tls as Record<string, unknown>;
    if (tls.ca_certs) options.ca = readFileSync(String(tls.ca_certs));
    if (tls.certfile) options.cert = readFileSync(String(tls.certfile));
    if (tls.keyfile) options.key = readFileSync(String(tls.keyfile));
    if (tls.insecure) options.rejectUnauthorized = false;
  }
  return options;
}

// The broker's address as mqtt.js reads it, such as "mqtts://[::1]:8883".
export function broker_url(options: Record<string, unknown>): string {
  const host = String(options.host);
  return `${String(options.protocol)}://${host.includes(":") ? `[${host}]` : host}:${String(options.port)}`;
}

async function mqtt_session(options: Record<string, unknown>): Promise<MqttSession> {
  const mqtt = await import("mqtt");
  const client = await mqtt.connectAsync(broker_url(options), options as never, false);
  const queue: (MqttMessage | Error)[] = [];
  let wake: (() => void) | null = null;
  const push = (item: MqttMessage | Error) => {
    queue.push(item);
    wake?.();
  };
  client.on("message", (topic, payload, packet) => push({ topic, payload, retain: Boolean(packet.retain) }));
  client.on("close", () => push(new Error("connection closed")));
  client.on("error", (error) => push(error));
  return {
    publish: async (topic, payload, publish_options) => {
      await client.publishAsync(topic, payload, publish_options);
    },
    subscribe: async (topic) => {
      await client.subscribeAsync(topic);
    },
    messages: () => ({
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
          const item = queue.shift()!;
          if (item instanceof Error) throw item;
          yield item;
        }
      },
    }),
    end: async () => {
      await client.endAsync();
    },
  };
}

// ── Exporter ─────────────────────────────────────────────────────────────────

class Stopped extends Error {}

const sleep = (seconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Stopped());
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", on_abort);
    resolve();
  }, seconds * 1000);
  const on_abort = () => {
    clearTimeout(timer);
    reject(new Stopped());
  };
  signal.addEventListener("abort", on_abort, { once: true });
});

// The monitors' identity, as the engine lists them.
export interface ListedMonitor {
  id: string;
  name?: string;
  target?: string;
}

// Publishes on every status and metric change, and republishes everything on (re)connect.
export class MQTTExporter {
  readonly host: string;
  readonly tls: unknown;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  readonly client_id: string;
  readonly base: string;
  readonly prefix: string;
  readonly discovery: boolean;
  readonly retain: boolean;
  interval: number;
  coalesce = COALESCE_SECONDS;
  // The run loop while started; it settles once the exporter stops.
  task: Promise<void> | null = null;
  private readonly db: MetricsSource;
  private readonly monitors: () => Iterable<ListedMonitor>;
  private readonly session_factory: SessionFactory;
  private dirty = new Set<string>();
  private full = true;
  private readonly announced = new Set<string>();
  private awake = false;
  private wake_up: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private connected = false;
  private readonly stop_controller = new AbortController();

  constructor(db: MetricsSource, config: Record<string, unknown>, options: { monitors?: () => Iterable<ListedMonitor>; session_factory?: SessionFactory } = {}) {
    this.db = db;
    this.host = String(config.host);
    this.tls = config.tls || false;
    this.port = Math.trunc(Number(config.port || (this.tls ? 8883 : 1883)));
    this.username = config.username ? String(config.username) : null;
    this.password = secret(config, "password");
    this.client_id = config.client_id ? String(config.client_id) : `x-monitor-${slug(hostname())}`;
    this.base = String(config.base_topic || "x-monitor").replace(/^\/+|\/+$/g, "");
    this.prefix = String(config.discovery_prefix || "homeassistant").replace(/^\/+|\/+$/g, "");
    this.discovery = Boolean(config.discovery ?? true);
    this.retain = Boolean(config.retain ?? true);
    this.interval = parse_duration(config.interval || 0, "interval");
    this.monitors = options.monitors ?? (() => []);
    this.session_factory = options.session_factory ?? (() => mqtt_session(this.client_options()));
  }

  get availability_topic(): string {
    return `${this.base}/status`;
  }

  client_options(): Record<string, unknown> {
    return client_options({
      host: this.host, port: this.port, tls: this.tls, username: this.username, password: this.password,
      client_id: this.client_id, availability_topic: this.availability_topic,
    });
  }

  // Watches the change bus and starts the connection loop.
  start(): void {
    this.unsubscribe = CHANGES.subscribe((kind, plugin_id) => this.on_change(kind, plugin_id));
    this.task = this.run();
  }

  // Stops watching changes and ends the connection, which says offline on its way out.
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stop_controller.abort();
    this.wake_up?.();
  }

  private on_change(kind: ChangeKind, plugin_id: string | null): void {
    if ((kind !== changes.STATUS && kind !== changes.METRIC) || !plugin_id) return;
    this.mark(plugin_id);
  }

  // Queues one monitor for publishing, or everything when no monitor is given.
  private mark(plugin_id: string | null = null): void {
    if (plugin_id === null) this.full = true;
    else this.dirty.add(plugin_id);
    this.awake = true;
    this.wake_up?.();
  }

  // Connects, publishes, and reconnects with backoff for as long as the exporter runs.
  async run(): Promise<void> {
    log.info(`MQTT exporter started -> ${this.host}:${this.port} as ${this.client_id}`);
    let delay = backoff.min;
    let quiet = false;
    while (!this.stop_controller.signal.aborted) {
      // A broker that is down or drops us must never end the exporter; the next attempt retries.
      let error: unknown = "connection closed";
      try {
        await this.session();
      } catch (problem) {
        if (problem instanceof Stopped) return;
        error = problem;
      }
      if (this.stop_controller.signal.aborted) return;
      if (this.connected) {
        this.connected = false;
        delay = backoff.min;
        quiet = false;
      }
      const message = `MQTT exporter: ${this.host}:${this.port} unreachable (${error instanceof Error ? error.message : String(error)}); retrying in ${delay.toFixed(0)}s`;
      if (quiet) log.debug(message);
      else log.warn(message);
      quiet = true;
      try {
        await sleep(delay, this.stop_controller.signal);
      } catch {
        return;
      }
      delay = Math.min(delay * 2, backoff.max);
    }
  }

  // One connection: announce, publish everything, then follow changes until it drops.
  private async session(): Promise<void> {
    const session = await this.session_factory();
    const ended = new AbortController();
    const stop_session = () => ended.abort();
    this.stop_controller.signal.addEventListener("abort", stop_session, { once: true });
    this.connected = true;
    log.info(`MQTT exporter connected to ${this.host}:${this.port}`);
    try {
      await session.publish(this.availability_topic, "online", { qos: 1, retain: true });
      if (this.discovery) await session.subscribe(`${this.prefix}/status`);
      this.announced.clear();
      this.mark();
      const loops = [this.drain(session, ended.signal)];
      if (this.discovery) loops.push(this.listen(session, ended.signal));
      if (this.interval > 0) loops.push(this.tick(ended.signal));
      try {
        await Promise.race(loops);
      } finally {
        ended.abort();
        this.wake_up?.();
        await Promise.allSettled(loops);
      }
    } finally {
      this.stop_controller.signal.removeEventListener("abort", stop_session);
      if (this.stop_controller.signal.aborted) {
        // A clean disconnect suppresses the last will, so say offline before leaving.
        await Promise.race([session.publish(this.availability_topic, "offline", { qos: 1, retain: true }), new Promise((resolve) => setTimeout(resolve, 2000))]).catch(() => {});
      }
      await session.end().catch(() => {});
    }
  }

  // Publishes whatever changed, one coalesced pass per burst.
  private async drain(session: MqttSession, signal: AbortSignal): Promise<void> {
    while (true) {
      while (!this.awake) {
        await new Promise<void>((resolve) => (this.wake_up = resolve));
        this.wake_up = null;
        if (signal.aborted) throw new Stopped();
      }
      if (this.coalesce) await sleep(this.coalesce, signal);
      if (signal.aborted) throw new Stopped();
      this.awake = false;
      const full = this.full;
      const dirty = this.dirty;
      this.full = false;
      this.dirty = new Set();
      try {
        await this.publish(session, full ? null : dirty);
      } catch (error) {
        // What failed to go out is sent again on the next connection.
        this.full = true;
        throw error;
      }
    }
  }

  // Republishes everything when Home Assistant announces it has (re)started.
  private async listen(session: MqttSession, signal: AbortSignal): Promise<void> {
    const birth = `${this.prefix}/status`;
    const iterator = session.messages()[Symbol.asyncIterator]();
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Stopped());
      signal.addEventListener("abort", () => reject(new Stopped()), { once: true });
    });
    aborted.catch(() => {});
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      const message = next.value;
      // A retained birth is an old one, and everything was just published on connect.
      if (message.retain || message.topic !== birth) continue;
      const payload = typeof message.payload === "string" ? message.payload : message.payload.toString("utf8");
      if (payload.trim() === "online") {
        log.info("MQTT exporter: Home Assistant came online, republishing discovery");
        this.announced.clear();
        this.mark();
      }
    }
    throw new Error("connection closed");
  }

  private async tick(signal: AbortSignal): Promise<void> {
    while (true) {
      await sleep(this.interval, signal);
      this.mark();
    }
  }

  private monitor_index(): Map<string, Monitor> {
    const index = new Map<string, Monitor>();
    try {
      for (const plugin of this.monitors()) {
        const plugin_id = String(plugin.id);
        index.set(plugin_id, { id: plugin_id, name: String(plugin.name || plugin_id), target: String(plugin.target || "localhost") });
      }
    } catch (error) {
      log.debug(`MQTT exporter could not list monitors: ${(error as Error).message}`);
    }
    return index;
  }

  // Publishes the status and metrics of the monitors in `only`, or of every monitor.
  async publish(session: MqttSession, only: ReadonlySet<string> | null = null): Promise<void> {
    const monitors = this.monitor_index();
    const statuses = this.db.latest_statuses();
    const metrics = new Map<string, MetricRowDict[]>();
    for (const row of this.db.latest_metrics()) {
      if (only === null || only.has(row.plugin_id)) {
        if (!metrics.has(row.plugin_id)) metrics.set(row.plugin_id, []);
        metrics.get(row.plugin_id)!.push(row);
      }
    }
    const ids = only === null ? new Set([...monitors.keys(), ...Object.keys(statuses), ...metrics.keys()]) : new Set(only);
    for (const plugin_id of [...ids].sort()) {
      const rows = metrics.get(plugin_id) ?? [];
      const monitor = monitors.get(plugin_id) ?? { id: plugin_id, name: plugin_id, target: rows.length > 0 ? rows[0]!.target : "localhost" };
      await this.publish_monitor(session, monitor, statuses[plugin_id], rows);
    }
  }

  private async publish_monitor(session: MqttSession, monitor: Monitor, state: string | undefined, rows: MetricRowDict[]): Promise<void> {
    if (this.discovery && !this.announced.has(`${monitor.id}\n`)) {
      for (const [topic, payload] of status_configs(this.base, this.prefix, monitor)) await session.publish(topic, JSON.stringify(payload), { qos: 1, retain: this.retain });
      this.announced.add(`${monitor.id}\n`);
    }
    await session.publish(status_topic(this.base, monitor.id), normalize_status(state), { qos: 0, retain: this.retain });
    for (const row of [...rows].sort((first, second) => (first.metric_name < second.metric_name ? -1 : first.metric_name > second.metric_name ? 1 : 0))) {
      const metric = row.metric_name;
      if (this.discovery && !this.announced.has(`${monitor.id}\n${metric}`)) {
        const [topic, payload] = metric_config(this.base, this.prefix, monitor, metric);
        await session.publish(topic, JSON.stringify(payload), { qos: 1, retain: this.retain });
        this.announced.add(`${monitor.id}\n${metric}`);
      }
      await session.publish(metric_topic(this.base, monitor.id, metric), format_value(row.value), { qos: 0, retain: this.retain });
    }
  }
}
