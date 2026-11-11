// The engine an agent runs: the server's own engine, over its host's monitors only, recording into a local database
// with an outbox. The plan file is an ordinary X-Monitor config holding only this agent's monitors, each naming this
// agent, so their commands run locally; the engine watches it and reloads in place when the server sends a new plan.

import { open_agent_database, type AgentDatabase } from "../database/agent_database.ts";
import { StateStore } from "../state/store.ts";
import { XMonitorEngine, type EngineOptions } from "./engine.ts";

export class LocalEngine extends XMonitorEngine {
  constructor(agent_id: string, plan_path: string, db_path: string, options: Omit<EngineOptions, "local_agent" | "db_path_override"> = {}) {
    super(plan_path, { ...options, local_agent: agent_id, db_path_override: db_path });
  }

  protected override open_database(path: string): AgentDatabase {
    return open_agent_database(path, { write_batch_seconds: this.config_loader.write_batch_seconds, store: new StateStore(this.config_loader.buffer_sizes) });
  }

  get agent_db(): AgentDatabase {
    return this.db as AgentDatabase;
  }
}
