import { afterEach, describe, expect, it } from "vitest";

import { CHANGES } from "../../src/core/state/changes.ts";
import { ServerServices } from "../../src/server/services.ts";
import { fake_engine, fake_monitor } from "./fake_server.ts";

let services: ServerServices | null = null;

afterEach(() => services?.stop());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the server's services", () => {
  it("start once the engine is ready, and hand the engine its notification engine", async () => {
    const engine = fake_engine([fake_monitor("nas")]);
    engine.ready = false;
    services = new ServerServices(engine);
    services.start();
    expect(services.notifications).toBeNull();
    engine.ready = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(services.notifications).not.toBeNull();
    expect(engine.notifications).toBe(services.notifications);
  });

  it("start notifications afresh after a reload that changes the tree or their section, and exporters only for theirs", async () => {
    const engine = fake_engine([fake_monitor("nas")]);
    services = new ServerServices(engine);
    services.start_now();
    const [notifications, exporters] = [services.notifications, services.exporters];
    CHANGES.publish("monitors");
    await settle();
    expect([services.notifications, services.exporters]).toEqual([notifications, exporters]);

    engine.monitors_version += 1;
    CHANGES.publish("monitors");
    await settle();
    expect(services.notifications).not.toBe(notifications);
    expect(services.exporters).toBe(exporters);

    (engine.config_loader as { exporters: Record<string, unknown> }).exporters = { mqtt: { port: 1883 } };
    CHANGES.publish("monitors");
    await settle();
    expect(services.exporters).not.toBe(exporters);
  });
});
