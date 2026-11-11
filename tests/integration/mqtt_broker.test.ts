// The MQTT exporter against a real mosquitto broker, skipped when neither mosquitto nor nix is available.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectAsync, type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { MQTTExporter, broker_url } from "../../src/server/exporters/mqtt.ts";

// ── Broker ───────────────────────────────────────────────────────────────────

function mosquitto_binary(): string | null {
  for (const folder of (process.env.PATH ?? "").split(":")) if (existsSync(join(folder, "mosquitto"))) return join(folder, "mosquitto");
  const built = spawnSync("nix", ["build", "nixpkgs#mosquitto", "--no-link", "--print-out-paths"], { encoding: "utf8", timeout: 300_000 });
  if (built.status !== 0) return null;
  for (const path of built.stdout.split(/\s+/)) if (path && existsSync(join(path, "bin", "mosquitto"))) return join(path, "bin", "mosquitto");
  return null;
}

async function free_port(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.connect(port, "127.0.0.1");
  });
}

const binary = mosquitto_binary();
let broker: ChildProcess | null = null;
let port = 0;

beforeAll(async () => {
  if (binary === null) return;
  port = await free_port();
  const conf = join(mkdtempSync(join(tmpdir(), "mosquitto-")), "mosquitto.conf");
  writeFileSync(conf, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
  broker = spawn(binary, ["-c", conf], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (!(await reachable(port))) {
    if (Date.now() > deadline) throw new Error("mosquitto did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, 320_000);

afterAll(() => {
  broker?.kill();
});

// A second client that keeps the latest payload seen on every topic.
class Watcher {
  readonly seen = new Map<string, string>();
  private client: MqttClient | null = null;

  async open(): Promise<this> {
    this.client = await connectAsync(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0 });
    this.client.on("message", (topic, payload) => this.seen.set(topic, payload.toString()));
    await this.client.subscribeAsync("#");
    return this;
  }

  async close(): Promise<void> {
    await this.client?.endAsync();
  }

  async wait_for(topic: string, value?: string, timeout = 5000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (this.seen.get(topic) === undefined || (value !== undefined && this.seen.get(topic) !== value)) {
      if (Date.now() > deadline) throw new Error(`${topic} never became ${value}: ${this.seen.get(topic)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.seen.get(topic)!;
  }
}

function seeded(): DatabaseManager {
  const db = new DatabaseManager();
  db.insert_metric("server.lan", "cpu-mon", "cpu_pct", 42.5);
  db.insert_status("cpu-mon", "online");
  return db;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(binary === null)("mqtt exporter on a real broker", () => {
  it("publishes discovery, state and changes, and says offline when it stops", async () => {
    const db = seeded();
    const exporter = new MQTTExporter(db, { host: "127.0.0.1", port, base_topic: "x-monitor", client_id: "x-monitor-it" });
    exporter.coalesce = 0.05;
    const watch = await new Watcher().open();
    exporter.start();
    try {
      expect(await watch.wait_for("x-monitor/status")).toBe("online");
      expect(await watch.wait_for("x-monitor/cpu-mon/cpu_pct")).toBe("42.5");
      const config = JSON.parse(await watch.wait_for("homeassistant/sensor/x-monitor_cpu-mon/cpu_pct/config"));
      expect(config.unit_of_measurement).toBe("%");
      expect(config.device.name).toBe("server.lan");
      db.insert_status("cpu-mon", "failed");
      await watch.wait_for("x-monitor/cpu-mon/status", "failed");
    } finally {
      exporter.stop();
      await exporter.task;
    }
    await watch.wait_for("x-monitor/status", "offline");
    await watch.close();
  });

  it("retains state for a late subscriber", async () => {
    const exporter = new MQTTExporter(seeded(), { host: "127.0.0.1", port, base_topic: "late", client_id: "x-monitor-late" });
    exporter.coalesce = 0;
    exporter.start();
    try {
      const first = await new Watcher().open();
      await first.wait_for("late/cpu-mon/cpu_pct", "42.5");
      await first.close();
      const late = await new Watcher().open();
      expect(await late.wait_for("late/cpu-mon/cpu_pct")).toBe("42.5");
      expect(await late.wait_for("homeassistant/sensor/late_cpu-mon/status/config")).toBeTruthy();
      await late.close();
    } finally {
      exporter.stop();
      await exporter.task;
    }
  });

  it("is marked offline by its last will when the connection dies", async () => {
    const exporter = new MQTTExporter(seeded(), { host: "127.0.0.1", port, base_topic: "lwt", client_id: "x-monitor-lwt" });
    const watch = await new Watcher().open();
    const client = await connectAsync(broker_url(exporter.client_options()), exporter.client_options() as never, false);
    await client.publishAsync("lwt/status", "online", { qos: 1, retain: true });
    await watch.wait_for("lwt/status", "online");
    // Closing the socket without a DISCONNECT is what a crash looks like to the broker.
    client.stream.destroy();
    await watch.wait_for("lwt/status", "offline", 10_000);
    client.end(true);
    await watch.close();
  }, 15_000);

  it("keeps running while the broker is unreachable", async () => {
    const exporter = new MQTTExporter(seeded(), { host: "127.0.0.1", port: await free_port() });
    exporter.start();
    let settled = false;
    void exporter.task!.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    exporter.stop();
  });
});
