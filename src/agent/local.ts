// The monitors an agent runs itself, from the plan file in its state directory, connected to the server or not.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stringify as yaml_stringify } from "yaml";

import { create_logger_for } from "../core/logging.ts";
import type { OutboxRecord } from "../shared/agent_protocol.ts";

const log = create_logger_for("x_monitor_agent.local");

export const PLAN_FILE = "plan.yaml";
export const PLAN_VERSION_FILE = "plan.version";
export const DATABASE_FILE = "agent.db";

// How many recent action request ids the agent remembers, so an action resent after a reconnect runs once.
const REMEMBERED_ACTIONS = 200;

// ── The engine ───────────────────────────────────────────────────────────────

// What the runner uses of src/core/coordination/local_engine.ts's LocalEngine, by its Python names.
export interface LocalEngineLike {
  setup_modules(): void | Promise<void>;
  run(): Promise<void>;
  all_monitors(): { id: string; name: string }[];
  reload_config(source: string): Promise<{ ok: boolean; error?: string | null }>;
  shutdown(): void | Promise<void>;
  dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<[boolean, Record<string, unknown> | null]>;
  run_cycle_now(plugin: unknown): Promise<unknown>;
  db: {
    pending(options: { after: number; limit: number }): [number, string, Record<string, unknown>][] | Promise<[number, string, Record<string, unknown>][]>;
    acknowledge(through: number): void;
    trim(): void;
    latest_status(plugin_id: string): string;
  };
}

export type EngineFactory = (agent_id: string, plan_path: string, database_path: string) => Promise<LocalEngineLike>;

// Loads the engine only when the agent is first handed monitors, so a notify-only agent never loads it.
const default_factory: EngineFactory = async (agent_id, plan, database) => {
  const module_path = "../core/coordination/local_engine.ts";
  const { LocalEngine } = (await import(module_path)) as { LocalEngine: new (agent_id: string, plan: string, database: string) => LocalEngineLike };
  return new LocalEngine(agent_id, plan, database);
};

// Where the agent keeps the plan the server last sent it.
export function plan_path(state_dir: string): string {
  return join(state_dir, PLAN_FILE);
}

// Replaces a file in one step, so the engine's watcher never reads half a plan.
function write_atomically(path: string, text: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

// What an action reported, as plain strings that travel in a message.
export function as_metadata(metadata: unknown): Record<string, string> {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
}

// ── The runner ───────────────────────────────────────────────────────────────

// Owns the agent's local engine: starts it from a stored plan, applies new plans, and serves the server's sync, action
// and poll requests.
export class LocalRunner {
  readonly agent_id: string;
  readonly state_dir: string;
  engine: LocalEngineLike | null = null;
  private readonly factory: EngineFactory;
  private readonly actions = new Map<string, [boolean, Record<string, string>]>();

  constructor(agent_id: string, state_dir: string, factory: EngineFactory = default_factory) {
    this.agent_id = agent_id;
    this.state_dir = state_dir;
    this.factory = factory;
  }

  // The version of the plan on disk, or "" before the server has sent one.
  get plan_version(): string {
    try {
      return readFileSync(join(this.state_dir, PLAN_VERSION_FILE), "utf8").trim();
    } catch {
      return "";
    }
  }

  // Starts the engine over the stored plan, if there is one.
  async start(): Promise<void> {
    const plan = plan_path(this.state_dir);
    if (this.engine !== null || !existsSync(plan)) return;
    const engine = await this.factory(this.agent_id, plan, join(this.state_dir, DATABASE_FILE));
    await engine.setup_modules();
    await engine.run();
    this.engine = engine;
    log.info(`running ${engine.all_monitors().length} monitor(s) from ${plan}`);
  }

  // Stores a plan the server sent and runs it, reloading the engine in place when one is already running.
  async apply_plan(version: string, config: Record<string, unknown>): Promise<void> {
    if (version && version === this.plan_version && this.engine !== null) return;
    mkdirSync(this.state_dir, { recursive: true });
    write_atomically(plan_path(this.state_dir), yaml_stringify(config));
    write_atomically(join(this.state_dir, PLAN_VERSION_FILE), version);
    if (this.engine === null) {
      await this.start();
      return;
    }
    const result = await this.engine.reload_config("plan");
    if (!result.ok) log.error(`could not apply plan ${version}: ${result.error}`);
  }

  // Stops the engine, flushing what it recorded to disk.
  async stop(): Promise<void> {
    if (this.engine === null) return;
    const engine = this.engine;
    this.engine = null;
    await engine.shutdown();
  }

  // The outbox records past `after`, or none while no engine runs.
  async pending(after: number, limit = 500): Promise<OutboxRecord[]> {
    if (this.engine === null) return [];
    return (await this.engine.db.pending({ after, limit })).map(([seq, kind, payload]): OutboxRecord => [seq, kind, payload]);
  }

  // Forgets the records the server has stored, and drops the oldest results if the outbox grew past its limit.
  acknowledge(through: number): void {
    if (this.engine === null) return;
    this.engine.db.acknowledge(through);
    this.engine.db.trim();
  }

  private monitor(monitor_id: string): { id: string; name: string } | null {
    return this.engine?.all_monitors().find((plugin) => plugin.id === monitor_id) ?? null;
  }

  // Runs an action on one of the agent's monitors; a repeated request id returns its first answer.
  async run_action(request_id: string, monitor_id: string, action_id: string, args: Record<string, unknown>): Promise<[boolean, Record<string, string>]> {
    const remembered = this.actions.get(request_id);
    if (remembered !== undefined) return remembered;
    const plugin = this.monitor(monitor_id);
    let answer: [boolean, Record<string, string>];
    if (plugin === null) answer = [false, { content: `This agent does not run monitor ${JSON.stringify(monitor_id)}` }];
    else {
      try {
        const [success, metadata] = await this.engine!.dispatch_action(plugin, action_id, args);
        answer = [Boolean(success), as_metadata(metadata)];
      } catch (error) {
        // The server asked for this action; its failure is the answer, not a reason to drop the connection.
        answer = [false, { content: `${action_id} failed on the agent: ${(error as Error).message}` }];
      }
    }
    this.actions.set(request_id, answer);
    while (this.actions.size > REMEMBERED_ACTIONS) this.actions.delete(this.actions.keys().next().value!);
    return answer;
  }

  // Runs one cycle of a monitor now.
  async poll_now(monitor_id: string): Promise<void> {
    const plugin = this.monitor(monitor_id);
    if (plugin !== null) await this.engine!.run_cycle_now(plugin);
  }
}
