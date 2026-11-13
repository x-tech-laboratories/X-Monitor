import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { AgentConnection } from "../../../src/core/connectors/agent_connector.ts";
import { LocalConnection } from "../../../src/core/connectors/local_connector.ts";
import { command, CollectResult, type CmdResult, type Command } from "../../../src/core/connectors/types.ts";
import { DatabaseManager } from "../../../src/core/database/database.ts";
import { AgentDatabase } from "../../../src/core/database/agent_database.ts";
import { open_sqlite_persistence } from "../../../src/core/database/sqlite_persistence.ts";
import { LocalEngine } from "../../../src/core/coordination/local_engine.ts";
import { XMonitorEngine } from "../../../src/core/coordination/engine.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import { Probe, temp_folder, test_builtins } from "./engine_harness.ts";

beforeEach(() => set_log_sink(() => {}));

// A probe whose one command is the config's `command`, reading the number it prints as `value`.
class Answer extends Probe {
  override commands(): Command[] {
    return [command(String(this.config.command))];
  }

  override parse(results: CmdResult[]): CollectResult {
    return new CollectResult({ status: "online", metrics: { value: Number(results[0].stdout) } });
  }
}

function local_engine(folder = temp_folder()): LocalEngine {
  const plan = join(folder, "plan.yaml");
  writeFileSync(plan, stringify({ plugins: [{ name: "Answer", id: "answer", type: "answer", command: "echo 42", agent: "odin", interval: 3600 }] }));
  return new LocalEngine("odin", plan, join(folder, "agent.db"), { builtins: { ...test_builtins, answer: async () => Answer } });
}

describe("local engine", () => {
  it("runs its own agent's monitors through local processes into an outbox", async () => {
    const engine = local_engine();
    await engine.setup_modules();
    expect(engine.exec_context_for(engine.plugins[0])!.conn).toBeInstanceOf(LocalConnection);
    expect(engine.db).toBeInstanceOf(AgentDatabase);
  });

  it("still reaches another agent over its socket", () => {
    expect(local_engine().connectors.agent_connection("thor")).toBeInstanceOf(AgentConnection);
  });

  it("collects a cycle locally and records it in the outbox", async () => {
    const engine = local_engine();
    await engine.setup_modules();
    await engine.load_state();
    engine.ready = true;
    const plugin = engine.plugins[0] as Answer;
    await engine.run_cycle_now(plugin);
    await engine.db.flush();
    const results = engine.agent_db.pending().filter(([, kind]) => kind === "result").map(([, , payload]) => payload);
    expect(results.some((payload) => payload.plugin_id === "answer" && (payload.metrics as Record<string, number>).value === 42)).toBe(true);
    expect(engine.db.latest_status("answer")).toBe("online");
    await engine.shutdown();
  });
});

describe("startup", () => {
  function saved(folder: string): string {
    const path = join(folder, "x-monitor.db");
    const manager = new DatabaseManager({ persistence: open_sqlite_persistence(path, { write_batch_seconds: 0 }) });
    manager.insert_status("cpu", "failed");
    void manager.close();
    return path;
  }

  function engine_over(folder: string, db_path: string): XMonitorEngine {
    const config = join(folder, "config.yaml");
    writeFileSync(config, stringify({ plugins: [] }));
    return new XMonitorEngine(config, { db_path_override: db_path, builtins: test_builtins });
  }

  it("loads nothing on construction", () => {
    const folder = temp_folder();
    const engine = engine_over(folder, saved(folder));
    expect(engine.ready).toBe(false);
    expect(engine.db.latest_statuses()).toEqual({});
  });

  it("loads the saved state in run, then is ready", async () => {
    const folder = temp_folder();
    const engine = engine_over(folder, saved(folder));
    await engine.run();
    expect(engine.ready).toBe(true);
    expect(engine.db.latest_statuses()).toEqual({ cpu: "failed" });
    await engine.shutdown();
  });

  it("collects an agent that connected early once ready", async () => {
    const folder = temp_folder();
    const engine = engine_over(folder, saved(folder));
    engine.on_agent_connected("node-a");
    expect([...engine.early_agents]).toEqual(["node-a"]);
    const seen: [string, boolean][] = [];
    const original = engine.on_agent_connected.bind(engine);
    engine.on_agent_connected = (agent_id) => {
      seen.push([agent_id, engine.ready]);
      original(agent_id);
    };
    await engine.run();
    expect(seen).toEqual([["node-a", true]]);
    expect(engine.early_agents.size).toBe(0);
    await engine.shutdown();
  });

  it("drops an agent event that arrives before the store loads", () => {
    const folder = temp_folder();
    engine_over(folder, saved(folder)).on_agent_event("node-a", "x", 1, {});
  });
});
