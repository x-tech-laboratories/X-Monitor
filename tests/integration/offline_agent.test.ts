// An agent that runs its host's monitors itself, end to end in one process: the real server engine behind the real
// agent socket, and the real agent dialling it, collecting while the server is gone and syncing what it did once the
// server is back.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generate_agent_key } from "@x-tech-laboratories/x-libs/agent/keys";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { XMonitorAgent } from "../../src/agent/agent.ts";
import { load_private_key } from "../../src/agent/keys.ts";
import { XMonitorEngine } from "../../src/core/coordination/engine.ts";
import { register_agent_endpoint } from "../../src/server/agent_endpoint.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(condition: () => boolean, what: string, seconds = 40): Promise<void> {
  for (let tries = 0; tries < seconds * 5; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The agent socket the dashboard serves, alone, on `port`.
async function endpoint(engine: XMonitorEngine, port: number): Promise<FastifyInstance> {
  const app = fastify();
  await register_agent_endpoint(app, engine.connectors.agents);
  await app.listen({ host: "127.0.0.1", port });
  return app;
}

describe("an agent that runs its own monitors", () => {
  it("takes its monitors, runs them, and syncs back what it did offline", async () => {
    const folder = mkdtempSync(join(tmpdir(), "offline-agent-"));
    const key = generate_agent_key("node-a");
    const key_file = join(folder, "agent.key");
    writeFileSync(key_file, key.private_text, { mode: 0o600 });
    const config_file = join(folder, "config.yaml");
    writeFileSync(config_file, JSON.stringify({
      database: { path: join(folder, "server.db") },
      agents: [{ id: "node-a", public_key: key.public_line, run_monitors: true }],
      plugins: [{ name: "Answer", id: "answer", type: "command", command: "echo 42", pattern: "(\\d+)", agent: "node-a", interval: 2, actions: [{ name: "Hello", command: "echo hello" }] }],
    }));

    const engine = new XMonitorEngine(config_file, { handle_signals: false });
    await engine.setup_modules();
    await engine.run();
    cleanups.push(() => engine.shutdown());
    const plugin = engine.plugins[0];

    let app = await endpoint(engine, 0);
    const port = (app.server.address() as { port: number }).port;
    const agent = new XMonitorAgent({
      url: `ws://127.0.0.1:${port}/api/agent/ws`, agent_id: "node-a", key_file, key: load_private_key(key_file),
      hostname: "node-a", notify_only: false, state_dir: join(folder, "agent-state"), local_socket: null,
    });
    await agent.start();
    cleanups.push(() => agent.stop());

    await until(() => engine.agent_plans.runs(plugin), "the agent to take the monitor");
    await until(() => engine.db.latest_metric("answer", "value") !== null, "a synced result");
    expect(engine.db.latest_metric("answer", "value")!.value).toBe(42);
    const [success, metadata] = await engine.dispatch_action(plugin, "custom:hello");
    expect(success, JSON.stringify(metadata)).toBe(true);

    // The server is unreachable now; the agent keeps collecting on its own.
    await app.close();
    const gap_start = engine.db.latest_metric("answer", "value")!.timestamp;
    await new Promise((resolve) => setTimeout(resolve, 6000));

    app = await endpoint(engine, port);
    cleanups.push(() => app.close());
    await until(() => engine.db.latest_metric("answer", "value")!.timestamp > gap_start, "the offline records to sync");
    const history = engine.db.store.metric_history("answer", "value", 0);
    expect(history.filter((record) => record.timestamp > gap_start).length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
