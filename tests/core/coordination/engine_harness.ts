// Builds real XMonitorEngines over a temporary config and database for the coordination tests, with test monitor
// types standing in for the ones other areas port: a probe whose status a test sets, and a group that folds its
// children. SSH never dials: every connection gets a fake client that answers commands from a test's handler.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";

import type { SshClientConnection, SshDialer, SshProcess } from "../../../src/core/connectors/ssh_connector.ts";
import { CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command } from "../../../src/core/connectors/types.ts";
import { XMonitorEngine, type EngineOptions } from "../../../src/core/coordination/engine.ts";
import { Cpu } from "../../../src/monitors/cpu.ts";
import { Plugin, type PluginClass } from "../../../src/monitors/base/plugin_base.ts";
import type { PluginConfig } from "../../../src/monitors/base/plugin_helpers.ts";
import { worst_status } from "../../../src/shared/status.ts";
import type { StreamSpec } from "../../../src/shared/agent_protocol.ts";

// ── Test monitors ────────────────────────────────────────────────────────────

// A monitor whose status, reaction and actions a test controls.
export class Probe extends Plugin {
  status: string | null = "online";
  reaction: [string, Record<string, unknown>] | null = null;
  readonly seen: string[] = [];
  readonly outcomes: unknown[] = [];
  collections = 0;
  command_list: Command[] = [];

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    if (typeof config.status === "string") this.status = config.status;
  }

  override commands(): Command[] {
    return this.command_list;
  }

  override parse(_results: CmdResult[] = []): CollectResult {
    this.collections++;
    return new CollectResult({ status: this.status });
  }

  override subscriptions(): StreamSpec[] {
    if (!this.config.stream) return super.subscriptions();
    return [{ id: `${this.id}:watch`, kind: "journal", params: { unit: this.config.stream } }];
  }

  override on_status(status: string): [string, Record<string, unknown>] | null {
    this.seen.push(status);
    return this.reaction;
  }

  override plan_action(action_id: string): ActionPlanResult {
    if (action_id === "poke" || action_id === "heal") return new CollectResult({ logs: [[`ran ${action_id}`, "INFO"]], success: true });
    return null;
  }

  override interpret_action(_action_id: string, result: unknown, _args: Record<string, unknown> = {}): ActionOutcome {
    this.outcomes.push(result);
    return (result as CmdResult).exit_code === 0;
  }
}

// A plain group: its status is its children's worst, so it restates them.
export class Group extends Plugin {
  override get restates_children(): boolean {
    return true;
  }

  override parse(): CollectResult {
    return new CollectResult({ status: worst_status(Object.values(this.child_statuses())) });
  }
}

export const test_builtins: Record<string, () => Promise<PluginClass>> = {
  cpu: async () => Cpu,
  probe: async () => Probe,
  group: async () => Group,
};

// ── Fake SSH ─────────────────────────────────────────────────────────────────

export type CommandHandler = (host: string, command: string) => [number, string, string];

// A dialer whose connections answer every command from the handler, recording what ran where.
export function fake_dialer(handler: CommandHandler = () => [0, "", ""]): SshDialer & { ran: [string, string][] } {
  const ran: [string, string][] = [];
  const dialer = (async (options) => {
    let closed = false;
    const conn: SshClientConnection = {
      is_closed: () => closed,
      close: () => {
        closed = true;
      },
      create_process: async (command): Promise<SshProcess> => {
        ran.push([options.host, command]);
        const [exit_status, stdout, stderr] = handler(options.host, command);
        return {
          exit_status, is_closing: () => true, wait: async () => ({ exit_status, stdout, stderr }), terminate: () => {}, kill: () => {}, wait_closed: async () => true,
        };
      },
    };
    return conn;
  }) as SshDialer & { ran: [string, string][] };
  dialer.ran = ran;
  return dialer;
}

// ── Engines ──────────────────────────────────────────────────────────────────

export interface Harness {
  folder: string;
  path: string;
  engine: XMonitorEngine;
  write(config: Record<string, unknown>): void;
}

export function temp_folder(): string {
  return mkdtempSync(join(tmpdir(), "x-monitor-engine-"));
}

// Writes `config` (with a database in the folder unless it names one) and builds an engine over it.
export function make_engine(config: Record<string, unknown> = {}, options: EngineOptions & { folder?: string; handler?: CommandHandler } = {}): Harness {
  const folder = options.folder ?? temp_folder();
  const path = join(folder, "config.yaml");
  const write = (next: Record<string, unknown>) => writeFileSync(path, stringify({ database: { path: join(folder, "t.db"), write_batch_seconds: 0 }, ...next }));
  write(config);
  const engine = new XMonitorEngine(path, { builtins: test_builtins, ...options });
  engine.connectors.ssh_dialer = fake_dialer(options.handler);
  // No cycle starts on its own while a test looks: every loop's first wait is long.
  engine.startup_jitter_seconds = 1000;
  engine.random = () => 1;
  return { folder, path, engine, write };
}

// Builds an engine, its monitors and its loops, as the process does.
export async function start_engine(config: Record<string, unknown> = {}, options: EngineOptions & { folder?: string; handler?: CommandHandler } = {}): Promise<Harness> {
  const harness = make_engine(config, options);
  await harness.engine.setup_modules();
  await harness.engine.run();
  return harness;
}

// Wires a monitor class into an engine as setup_modules would, without a config entry.
export function wire<Monitor extends Plugin>(engine: XMonitorEngine, cls: new (name: string, config: PluginConfig) => Monitor, config: PluginConfig = {}): Monitor {
  const full: PluginConfig = { name: "test-plugin", id: "test-plugin", interval: 60, ssh_config: { host: "test.host" }, ...config };
  const plugin = new cls(String(full.name), full);
  plugin.engine = engine;
  engine["wire_plugin"](plugin, full);
  engine.plugins.push(plugin);
  return plugin;
}

// A folder plugin in `folder`, providing monitor types from a JavaScript module body that gets `services` in scope.
export function write_folder_plugin(folder: string, name: string, types: Record<string, string>, extra = ""): void {
  const root = join(folder, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, "x-plugin": { server: "server.js" } }));
  const provides = Object.entries(types).map(([type, body]) => `    context.provide("monitor_type", ${JSON.stringify(type)}, ${body});`).join("\n");
  writeFileSync(join(root, "server.js"), `${extra}\nexport default {\n  id: ${JSON.stringify(`test.${name}`)}, name: ${JSON.stringify(name)}, version: "1.0.0",\n  start(context) {\n    const { Plugin, CollectResult } = context.services;\n${provides}\n  },\n};\n`);
}
