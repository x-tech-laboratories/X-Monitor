import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { ExporterEngine, exporter_types } from "../../src/server/exporters/index.ts";
import { InfluxDBExporter, build_payload } from "../../src/server/exporters/influxdb.ts";
import {
  MQTTExporter, backoff, client_options, metric_config, metric_traits, normalize_status, slug, status_configs,
  type ListedMonitor, type MqttMessage, type MqttSession,
} from "../../src/server/exporters/mqtt.ts";
import { render } from "../../src/server/exporters/prometheus.ts";

// ── Prometheus and InfluxDB ──────────────────────────────────────────────────

function metrics_db(): DatabaseManager {
  const db = new DatabaseManager();
  db.insert_metric("host1", "cpu-mon", "cpu_pct", 42.5);
  db.insert_metric("host1", "cpu-mon", "cpu_pct", 55.0);
  db.insert_metric("host2", "mem-mon", "memory_pct", 30.0);
  db.insert_status("cpu-mon", "online");
  db.insert_status("mem-mon", "warning");
  return db;
}

describe("latest metrics", () => {
  it("keep only the newest of each series, and every series", () => {
    const metrics = metrics_db().latest_metrics();
    const cpu = metrics.filter((row) => row.metric_name === "cpu_pct");
    expect(cpu).toHaveLength(1);
    expect(cpu[0]!.value).toBeCloseTo(55.0);
    expect(new Set(metrics.map((row) => row.metric_name))).toEqual(new Set(["cpu_pct", "memory_pct"]));
  });
});

describe("prometheus exporter", () => {
  it("renders statuses and metrics", () => {
    const text = render(metrics_db());
    expect(text).toContain("x_monitor_up{monitor=\"cpu-mon\",state=\"online\"} 1");
    expect(text).toContain("x_monitor_up{monitor=\"mem-mon\",state=\"warning\"} 0.5");
    expect(text).toContain("x_monitor_metric{monitor=\"cpu-mon\"");
    expect(text).toContain("metric=\"cpu_pct\"} 55");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("puts info between warning and online, and escapes label values", () => {
    const db = metrics_db();
    db.insert_status("sync-mon", "info");
    db.insert_status("weird\"id", "failed");
    const text = render(db);
    expect(text).toContain("x_monitor_up{monitor=\"sync-mon\",state=\"info\"} 0.75");
    expect(text).toContain("weird\\\"id");
  });
});

describe("influxdb exporter", () => {
  it("builds a line-protocol payload", () => {
    const lines = build_payload(metrics_db()).split("\n");
    expect(lines.some((line) => line.startsWith("x_monitor_metric,") && line.includes("value=55.0"))).toBe(true);
    expect(lines.some((line) => line.startsWith("x_monitor_up,"))).toBe(true);
    for (const line of lines) expect(line.slice(line.lastIndexOf(" ") + 1)).toMatch(/^\d+$/);
  });

  it("writes to a 2.x bucket or a 1.x database", () => {
    const v2 = new InfluxDBExporter(metrics_db(), { url: "http://influx:8086", org: "o", bucket: "b", token: "t" });
    expect(v2.endpoint()).toBe("http://influx:8086/api/v2/write?org=o&bucket=b&precision=ns");
    expect(v2.headers().Authorization).toBe("Token t");
    expect(new InfluxDBExporter(metrics_db(), { url: "http://influx:8086", database: "mydb" }).endpoint()).toBe("http://influx:8086/write?db=mydb&precision=ns");
  });

  it("pushes the payload", async () => {
    const exporter = new InfluxDBExporter(metrics_db(), { url: "http://influx:8086/" });
    const sent: string[] = [];
    exporter.fetch = (async (url: string, init: RequestInit) => {
      sent.push(`${url} ${String(init.body).split("\n").length}`);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await exporter.push_once();
    expect(sent).toEqual(["http://influx:8086/write?db=x-monitor&precision=ns 4"]);
  });
});

// ── MQTT ─────────────────────────────────────────────────────────────────────

class Broker {
  down = false;
  connects = 0;
  published: [string, string, number, boolean][] = [];
  subscribed: string[] = [];
  private inbox: (MqttMessage | Error)[] = [];
  private wake: (() => void) | null = null;

  topics(): string[] {
    return this.published.map((entry) => entry[0]);
  }

  last(topic: string): [string, string, number, boolean] {
    return this.published.filter((entry) => entry[0] === topic).at(-1)!;
  }

  clear(): void {
    this.published.length = 0;
  }

  push(item: MqttMessage | Error): void {
    this.inbox.push(item);
    this.wake?.();
  }

  drop(): void {
    this.push(new Error("broker went away"));
  }

  birth(payload = "online", retain = false, topic = "homeassistant/status"): void {
    this.push({ topic, payload: Buffer.from(payload), retain });
  }

  async *read_inbox(): AsyncGenerator<MqttMessage> {
    while (true) {
      while (this.inbox.length === 0) await new Promise<void>((resolve) => (this.wake = resolve));
      const item = this.inbox.shift()!;
      if (item instanceof Error) throw item;
      yield item;
    }
  }

  session(): MqttSession {
    return {
      publish: async (topic, payload, options) => {
        if (this.down) throw new Error("not connected");
        this.published.push([topic, payload, options.qos, options.retain]);
      },
      subscribe: async (topic) => void this.subscribed.push(topic),
      messages: () => ({ [Symbol.asyncIterator]: () => this.read_inbox() }),
      end: async () => {},
    };
  }

  async connect(): Promise<MqttSession> {
    if (this.down) throw new Error("connection refused");
    this.connects += 1;
    return this.session();
  }
}

function listed(plugin_id: string, name?: string, target = "server.lan"): ListedMonitor {
  return { id: plugin_id, name: name ?? plugin_id.charAt(0).toUpperCase() + plugin_id.slice(1), target };
}

function exporter_for(db: DatabaseManager, broker: Broker, monitors: ListedMonitor[] = [], config: Record<string, unknown> = {}): MQTTExporter {
  const exporter = new MQTTExporter(db, { host: "broker.lan", ...config }, { monitors: () => monitors, session_factory: () => broker.connect() });
  exporter.coalesce = 0;
  return exporter;
}

async function settle(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("mqtt naming", () => {
  it("keeps a single safe topic level", () => {
    expect(slug("CPU Mon")).toBe("cpu_mon");
    expect(slug("disk:/home")).toBe("disk_home");
    expect(slug("a/b+c#d")).toBe("a_b_c_d");
    expect(slug("keep-dash_and_underscore")).toBe("keep-dash_and_underscore");
    expect(slug("///")).toBe("unnamed");
  });

  it("reads unknown statuses as unavailable", () => {
    expect(normalize_status("warning")).toBe("warning");
    expect(normalize_status("offline")).toBe("unavailable");
    expect(normalize_status(null)).toBe("unavailable");
  });

  it.each([
    ["cpu_pct", undefined, "%"], ["progress_percent", undefined, "%"], ["uptime_seconds", "duration", "s"], ["latency_ms", "duration", "ms"],
    ["freed_bytes", "data_size", "B"], ["rss_mb", "data_size", "MB"], ["avail_gb", "data_size", "GB"], ["temp_c", "temperature", "°C"],
    ["cpu_temp_c", "temperature", "°C"], ["signal_dbm", "signal_strength", "dBm"], ["irq_per_sec", undefined, "/s"], ["containers_total", undefined, undefined],
  ])("reads the traits of %s from its name", (name, device_class, unit) => {
    const traits = metric_traits(name);
    expect(traits.state_class).toBe("measurement");
    expect(traits.device_class).toBe(device_class);
    expect(traits.unit_of_measurement).toBe(unit);
  });
});

describe("mqtt discovery payloads", () => {
  const monitor = { id: "cpu-mon", name: "CPU", target: "server.lan" };

  it("describe a status sensor and a problem sensor", () => {
    const [[status_topic, status], [problem_topic, problem]] = status_configs("x-monitor", "homeassistant", monitor) as [[string, Record<string, unknown>], [string, Record<string, unknown>]];
    expect(status_topic).toBe("homeassistant/sensor/x-monitor_cpu-mon/status/config");
    expect(problem_topic).toBe("homeassistant/binary_sensor/x-monitor_cpu-mon/problem/config");
    expect(status.device_class).toBe("enum");
    expect(status.options).toEqual(["online", "warning", "failed", "unavailable"]);
    expect(status.state_topic).toBe("x-monitor/cpu-mon/status");
    expect(problem.state_topic).toBe("x-monitor/cpu-mon/status");
    expect([status.unique_id, problem.unique_id, problem.device_class]).toEqual(["x-monitor_cpu-mon_status", "x-monitor_cpu-mon_problem", "problem"]);
    expect(status.availability_topic).toBe("x-monitor/status");
  });

  it("describe a metric sensor", () => {
    const [topic, payload] = metric_config("x-monitor", "homeassistant", monitor, "temp_c");
    expect(topic).toBe("homeassistant/sensor/x-monitor_cpu-mon/temp_c/config");
    expect(payload).toMatchObject({ state_topic: "x-monitor/cpu-mon/temp_c", unique_id: "x-monitor_cpu-mon_temp_c", device_class: "temperature", unit_of_measurement: "°C", name: "CPU temp c" });
  });

  it("make one device per target, with ids that follow the base topic", () => {
    const device = (each: typeof monitor) => (status_configs("x-monitor", "homeassistant", each)[0]![1] as { device: Record<string, unknown> }).device;
    expect(device(monitor)).toEqual(device({ id: "mem", name: "Memory", target: "server.lan" }));
    expect(device(monitor).identifiers).toEqual(["x-monitor_server_lan"]);
    expect(device(monitor).name).toBe("server.lan");
    expect(device({ id: "disk", name: "Disk", target: "nas.lan" }).identifiers).toEqual(["x-monitor_nas_lan"]);
    expect(metric_config("x-monitor", "homeassistant", monitor, "cpu_pct")).toEqual(metric_config("x-monitor", "homeassistant", monitor, "cpu_pct"));
    const other = metric_config("lab", "homeassistant", monitor, "cpu_pct");
    expect(other[1].unique_id).toBe("lab_cpu-mon_cpu_pct");
    expect(other[0]).toBe("homeassistant/sensor/lab_cpu-mon/cpu_pct/config");
  });
});

describe("mqtt config", () => {
  it("has defaults", () => {
    const exporter = exporter_for(new DatabaseManager(), new Broker());
    expect([exporter.port, exporter.base, exporter.prefix]).toEqual([1883, "x-monitor", "homeassistant"]);
    expect(exporter.discovery && exporter.retain).toBe(true);
    expect(exporter.interval).toBe(0);
    expect(exporter.client_id.startsWith("x-monitor-")).toBe(true);
  });

  it("moves the default port for TLS, takes a duration for interval and reads the password file", () => {
    const exporter = exporter_for(new DatabaseManager(), new Broker(), [], { tls: true, interval: "5m", base_topic: "/lab/" });
    expect([exporter.port, exporter.interval, exporter.base]).toEqual([8883, 300, "lab"]);
    const path = join(mkdtempSync(join(tmpdir(), "mqtt-")), "pw");
    writeFileSync(path, "s3cret\n");
    expect(exporter_for(new DatabaseManager(), new Broker(), [], { password_file: path }).password).toBe("s3cret");
  });

  it("gives the client a last will and the TLS settings", () => {
    const ca = join(mkdtempSync(join(tmpdir(), "mqtt-")), "ca.pem");
    writeFileSync(ca, "CA");
    const exporter = new MQTTExporter(new DatabaseManager(), { host: "broker.lan", username: "u", password: "p", client_id: "x-monitor-test", tls: { ca_certs: ca, insecure: true } });
    const options = exporter.client_options();
    expect(options).toMatchObject({ host: "broker.lan", port: 8883, protocol: "mqtts", username: "u", password: "p", clientId: "x-monitor-test", reconnectPeriod: 0, rejectUnauthorized: false });
    expect(options.will).toMatchObject({ topic: "x-monitor/status", qos: 1, retain: true });
    expect(String((options.will as { payload: Buffer }).payload)).toBe("offline");
    expect(String(options.ca)).toBe("CA");
    expect(client_options({ host: "h", port: 1, tls: false, username: null, password: null, client_id: "c", availability_topic: "a" })).not.toHaveProperty("username");
  });
});

describe("mqtt publishing", () => {
  let db: DatabaseManager;
  let broker: Broker;

  beforeEach(() => {
    db = new DatabaseManager();
    db.insert_metric("server.lan", "cpu-mon", "cpu_pct", 42.5);
    db.insert_metric("server.lan", "cpu-mon", "temp_c", 61.0);
    db.insert_metric("nas.lan", "disk", "used_pct", 80.0);
    db.insert_status("cpu-mon", "online");
    db.insert_status("disk", "warning");
    broker = new Broker();
  });

  it("publishes everything with discovery", async () => {
    await exporter_for(db, broker, [listed("cpu-mon", "CPU"), listed("idle")]).publish(broker.session());
    const topics = broker.topics();
    expect(topics).toContain("homeassistant/sensor/x-monitor_cpu-mon/status/config");
    expect(topics).toContain("homeassistant/binary_sensor/x-monitor_disk/problem/config");
    expect(topics).toContain("homeassistant/sensor/x-monitor_cpu-mon/temp_c/config");
    expect(broker.last("x-monitor/cpu-mon/status").slice(1)).toEqual(["online", 0, true]);
    expect(broker.last("x-monitor/disk/status")[1]).toBe("warning");
    expect(broker.last("x-monitor/cpu-mon/cpu_pct")[1]).toBe("42.5");
    expect(broker.last("x-monitor/disk/used_pct")[1]).toBe("80.0");
    expect(broker.last("x-monitor/idle/status")[1]).toBe("unavailable");
  });

  it("takes names and targets from the monitor, or the metrics' target without one", async () => {
    await exporter_for(db, broker, [listed("cpu-mon", "CPU", "box")]).publish(broker.session());
    const status = JSON.parse(broker.last("homeassistant/sensor/x-monitor_cpu-mon/status/config")[1]);
    expect([status.name, status.device.name]).toEqual(["CPU status", "box"]);
    expect(JSON.parse(broker.last("homeassistant/sensor/x-monitor_disk/status/config")[1]).device.name).toBe("nas.lan");
  });

  it("sends discovery once per connection, and only the named monitors when asked", async () => {
    const exporter = exporter_for(db, broker);
    await exporter.publish(broker.session());
    broker.clear();
    await exporter.publish(broker.session());
    expect(broker.topics().filter((topic) => topic.startsWith("homeassistant/"))).toEqual([]);
    expect(broker.topics()).toContain("x-monitor/cpu-mon/status");
    broker.clear();
    await exporter.publish(broker.session(), new Set(["disk"]));
    expect(broker.topics().every((topic) => !topic.includes("cpu-mon"))).toBe(true);
    expect(broker.topics()).toContain("x-monitor/disk/used_pct");
  });

  it("can turn discovery and retain off", async () => {
    await exporter_for(db, broker, [], { discovery: false, retain: false }).publish(broker.session());
    expect(broker.topics().filter((topic) => topic.startsWith("homeassistant/"))).toEqual([]);
    expect(broker.last("x-monitor/cpu-mon/status")[3]).toBe(false);
  });
});

describe("mqtt connection", () => {
  let db: DatabaseManager;
  let broker: Broker;
  let exporter: MQTTExporter | null;
  const saved = { ...backoff };

  beforeEach(() => {
    db = new DatabaseManager();
    db.insert_metric("server.lan", "cpu-mon", "cpu_pct", 42.5);
    db.insert_metric("nas.lan", "disk", "used_pct", 80.0);
    db.insert_status("cpu-mon", "online");
    db.insert_status("disk", "warning");
    broker = new Broker();
    exporter = null;
    backoff.min = 0.01;
    backoff.max = 0.02;
  });

  afterEach(() => {
    exporter?.stop();
    Object.assign(backoff, saved);
  });

  const started = (config: Record<string, unknown> = {}) => {
    exporter = exporter_for(db, broker, [], config);
    exporter.start();
    return exporter;
  };

  it("announces itself on connect and publishes everything", async () => {
    started();
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    expect(broker.published[0]).toEqual(["x-monitor/status", "online", 1, true]);
    expect(broker.subscribed).toEqual(["homeassistant/status"]);
  });

  it("publishes only the changed monitor, once per burst", async () => {
    started().coalesce = 0.05;
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    broker.clear();
    for (const value of [1.0, 2.0, 3.0]) db.insert_metric("server.lan", "cpu-mon", "cpu_pct", value);
    db.insert_status("cpu-mon", "failed");
    await settle(() => broker.topics().includes("x-monitor/cpu-mon/status"));
    await pause(100);
    expect(broker.topics().filter((topic) => topic === "x-monitor/cpu-mon/status")).toHaveLength(1);
    expect(broker.topics().filter((topic) => topic === "x-monitor/cpu-mon/cpu_pct")).toHaveLength(1);
    expect(broker.last("x-monitor/cpu-mon/cpu_pct")[1]).toBe("3.0");
    expect(broker.last("x-monitor/cpu-mon/status")[1]).toBe("failed");
    expect(broker.topics().every((topic) => !topic.includes("disk"))).toBe(true);
  });

  it("announces a new metric before its value", async () => {
    started();
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    broker.clear();
    db.insert_metric("nas.lan", "disk", "inodes_pct", 12.0);
    await settle(() => broker.topics().includes("x-monitor/disk/inodes_pct"));
    const topics = broker.topics();
    expect(topics.indexOf("homeassistant/sensor/x-monitor_disk/inodes_pct/config")).toBeLessThan(topics.indexOf("x-monitor/disk/inodes_pct"));
    expect(topics).not.toContain("homeassistant/sensor/x-monitor_disk/used_pct/config");
  });

  it("ignores unrelated changes", async () => {
    started();
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    broker.clear();
    db.insert_event("INFO", "hello", "server.lan", "cpu-mon");
    await pause(50);
    expect(broker.published).toEqual([]);
  });

  it("republishes discovery when Home Assistant is born again", async () => {
    started();
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    broker.clear();
    broker.birth("online", true);
    broker.birth("offline");
    broker.birth("online", false, "other/status");
    await pause(50);
    expect(broker.published).toEqual([]);
    broker.birth();
    await settle(() => broker.topics().includes("homeassistant/sensor/x-monitor_disk/used_pct/config"));
  });

  it("republishes everything every interval", async () => {
    started({ discovery: false }).interval = 0.02;
    await settle(() => broker.topics().filter((topic) => topic === "x-monitor/disk/status").length >= 3);
  });

  it("says offline when it stops, and publishes nothing after", async () => {
    const running = started();
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    running.stop();
    await running.task;
    expect(broker.published.at(-1)).toEqual(["x-monitor/status", "offline", 1, true]);
    db.insert_status("disk", "failed");
    await pause(20);
    expect(broker.published.at(-1)).toEqual(["x-monitor/status", "offline", 1, true]);
  });

  it("retries while the broker is down without failing", async () => {
    broker.down = true;
    started();
    await pause(100);
    expect(broker.connects).toBe(0);
    db.insert_status("disk", "failed");
    broker.down = false;
    await settle(() => broker.topics().includes("x-monitor/disk/status"));
    expect(broker.last("x-monitor/disk/status")[1]).toBe("failed");
  });

  it("reconnects and republishes after a dropped connection", async () => {
    started();
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    broker.clear();
    broker.drop();
    await settle(() => broker.connects === 2 && broker.topics().includes("x-monitor/disk/used_pct"));
    expect(broker.topics()).toContain("homeassistant/sensor/x-monitor_disk/used_pct/config");
    expect(broker.published[0]).toEqual(["x-monitor/status", "online", 1, true]);
  });

  it("reconnects after a failed publish", async () => {
    started();
    await settle(() => broker.topics().includes("x-monitor/disk/used_pct"));
    broker.down = true;
    db.insert_status("disk", "failed");
    await pause(50);
    broker.down = false;
    await settle(() => broker.connects >= 2 && broker.topics().includes("x-monitor/disk/status") && broker.last("x-monitor/disk/status")[1] === "failed");
  });
});

describe("ExporterEngine", () => {
  it("starts and stops the MQTT exporter with the monitors listed", () => {
    const original = exporter_types.mqtt;
    const made: { config: Record<string, unknown>; monitors: unknown; running: boolean }[] = [];
    exporter_types.mqtt = (_db, config, monitors) => {
      const stub = { config, monitors, running: false, start: () => void (stub.running = true), stop: () => void (stub.running = false) };
      made.push(stub);
      return stub;
    };
    try {
      const engine = new ExporterEngine(new DatabaseManager(), { mqtt: { host: "broker.lan" } });
      const monitors = () => [];
      engine.start(monitors);
      expect(made[0]!.running).toBe(true);
      expect(made[0]!.monitors).toBe(monitors);
      engine.stop();
      expect(made[0]!.running).toBe(false);
    } finally {
      exporter_types.mqtt = original;
    }
  });

  it("starts nothing without a host", () => {
    const engine = new ExporterEngine(new DatabaseManager(), { mqtt: { port: 1883 } });
    engine.start();
    expect(engine.exporters).toEqual([]);
  });
});
