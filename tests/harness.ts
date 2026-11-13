// Drives a monitor in a test the way XMonitorEngine does, with a fake transport: make_plugin constructs it and wires
// its data view, jobs gateway and a fake engine; run_cycle, run_requests and run_io_cycle run one cycle through
// fabricated results and write what it returns, so a test reads the store as the page would.

import { JobsGateway } from "../src/core/coordination/jobs.ts";
import { PluginDataView } from "../src/core/coordination/data_view.ts";
import { cmd_result, type CollectResult, type Command, type DispatchResult, type HttpRequest, type HttpResult, type Request, type Result } from "../src/core/connectors/types.ts";
import type { EngineLike } from "../src/core/contracts.ts";
import { DatabaseManager } from "../src/core/database/database.ts";
import type { Plugin } from "../src/monitors/base/plugin_base.ts";
import type { PluginConfig } from "../src/monitors/base/plugin_helpers.ts";

// ── Fake engine ──────────────────────────────────────────────────────────────

// Stands in for the Coordination Engine: the narrow surface monitors call back into.
export class FakeEngine implements EngineLike {
  readonly db: DatabaseManager;
  readonly plugins: Plugin[];
  readonly ready = true;
  readonly monitors_version = 0;
  // Commands the monitor's jobs gateway sent, such as a cancel.
  readonly raw_commands: string[] = [];
  // Set by a test to answer engine.http_fetch from an io_call() function.
  http_fetch_handler: ((request: HttpRequest) => HttpResult) | null = null;
  // Set by a test to answer dispatch_action.
  dispatch_handler: ((plugin: Plugin, action_id: string, args: Record<string, unknown>) => DispatchResult) | null = null;

  constructor(db: DatabaseManager, plugin: Plugin) {
    this.db = db;
    this.plugins = [plugin];
  }

  apply(plugin: Plugin, result: CollectResult): void {
    this.db.apply_result(plugin.target, plugin.id, plugin.name, result);
  }

  set_setting(key: string, value: string): void {
    this.db.set_setting(key, value);
  }

  async http_fetch(request: HttpRequest): Promise<HttpResult> {
    if (this.http_fetch_handler === null) throw new Error("engine.http_fetch called but the test set no http_fetch_handler");
    return this.http_fetch_handler(request);
  }

  async dispatch_action(plugin: unknown, action_id: string, args: Record<string, unknown> = {}): Promise<DispatchResult> {
    if (this.dispatch_handler === null) throw new Error("engine.dispatch_action called but the test set no dispatch_handler");
    return this.dispatch_handler(plugin as Plugin, action_id, args);
  }

  async run_cycle_now(): Promise<boolean> {
    return true;
  }

  last_collected(): number {
    return 0;
  }
}

// ── Making a monitor ─────────────────────────────────────────────────────────

export interface TestPlugin<Monitor extends Plugin> {
  plugin: Monitor;
  db: DatabaseManager;
  engine: FakeEngine;
}

export const default_config: PluginConfig = { name: "test-plugin", id: "test-plugin", interval: 60, ssh_config: { host: "test.host" } };

// Constructs a monitor with only its name and config, then wires it as the engine does; pass `db` to share a store.
export function make_plugin<Monitor extends Plugin>(cls: new (name: string, config: PluginConfig) => Monitor, extra_config: PluginConfig = {}, db: DatabaseManager = new DatabaseManager()): Monitor {
  return make_test_plugin(cls, extra_config, db).plugin;
}

export function make_test_plugin<Monitor extends Plugin>(cls: new (name: string, config: PluginConfig) => Monitor, extra_config: PluginConfig = {}, db: DatabaseManager = new DatabaseManager()): TestPlugin<Monitor> {
  const config: PluginConfig = { ...default_config, ...extra_config };
  const plugin = new cls(String(config.name), config);
  const ssh_config = (config.ssh_config ?? {}) as Record<string, unknown>;
  plugin.target = plugin.display_target ?? String(ssh_config.host ?? config.target_host ?? "test.host");
  plugin.bind(new PluginDataView(db, plugin.id));
  const engine = new FakeEngine(db, plugin);
  plugin.engine = engine;
  plugin.jobs = new JobsGateway(db, plugin, async (text) => {
    engine.raw_commands.push(text);
    return [0, "", ""];
  });
  return { plugin, db, engine };
}

// Reads a monitor's store through its own data view, for tests that check what a cycle wrote.
export function store_of(plugin: Plugin): DatabaseManager {
  return (plugin.engine as FakeEngine).db;
}

// ── Running a cycle ──────────────────────────────────────────────────────────

// Runs commands() and parse() through fabricated results, every command answering (0, "", "") unless `fake_run` says.
export function run_cycle(plugin: Plugin, fake_run: ((command: Command) => Result) | null = null): CollectResult {
  const commands = plugin.commands();
  const results = commands.map((each) => (fake_run === null ? cmd_result(0, "", "") : fake_run(each)));
  const result = plugin.parse(results as never);
  apply(plugin, result);
  return result;
}

// Runs requests() and parse_results(); with no `fake_run`, parse_results([]) for the nothing-to-ask case.
export function run_requests(plugin: Plugin, fake_run: ((request: Request) => Result) | null = null): CollectResult {
  const requests = plugin.requests();
  const results = fake_run === null ? [] : requests.map(fake_run);
  const result = plugin.parse_results(results);
  apply(plugin, result);
  return result;
}

const unset = Symbol("unset");

// Runs io_call()'s function (awaiting it when async), or takes `fake_result` in its place, then parse_results().
export async function run_io_cycle(plugin: Plugin, fake_result: unknown = unset): Promise<CollectResult> {
  const io_result = fake_result === unset ? await plugin.io_call()!() : fake_result;
  const result = plugin.parse_results([io_result as Result]);
  apply(plugin, result);
  return result;
}

function apply(plugin: Plugin, result: CollectResult): void {
  store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, result);
}
