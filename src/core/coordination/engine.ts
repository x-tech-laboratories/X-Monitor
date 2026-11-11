// The Coordination Engine: the application's central coordinator. It owns the other engines (the config, the
// database, the connectors, and the notifications and exporters the server injects) and the monitor tree, and drives
// each monitor's polling loop. Monitors stay pure: they declare requests and plans and this engine performs all IO.
//
// Collection has two paths. The polling loop runs each monitor's requests on its own `interval`. Alongside it,
// monitors on an agent can subscribe to event streams the agent watches and pushes the instant they change; those
// arrive through on_agent_event and are stored the same way. A third loop runs each monitor's scheduled actions at the
// times its `schedule` names, and every stored cycle is checked against the monitor's `triggers`.
//
// Each background task is a promise with an AbortController; aborting a monitor's loop stops it at its next await, and
// a cycle still in flight for a retired monitor writes nothing.

import { dirname } from "node:path";

import { watch_config } from "@x-tech-laboratories/x-libs/server/config_watch";

import { AgentConnection } from "../connectors/agent_connector.ts";
import type { AgentRegistry } from "../connectors/agent_connector.ts";
import { ConnectorEngine, ExecContext } from "../connectors/engine.ts";
import { measure_channel_wait } from "../connectors/ssh_connector.ts";
import {
  action_plan, cmd_result, CollectResult, unreachable, type ActionOutcome, type ActionPlan, type DispatchResult, type HttpRequest, type HttpResult, type Result,
} from "../connectors/types.ts";
import type { EngineLike } from "../contracts.ts";
import { DatabaseManager } from "../database/database.ts";
import { open_sqlite_persistence } from "../database/sqlite_persistence.ts";
import { create_logger_for } from "../logging.ts";
import { python_dumps, python_repr, deep_equal } from "../python.ts";
import { ConfigFileManager } from "../settings/config_file.ts";
import type { ExporterSettings, NotificationSettings, PluginConfig } from "../settings/config_schema.ts";
import { LogLevels } from "../settings/log_levels.ts";
import * as changes from "../state/changes.ts";
import { CHANGES } from "../state/changes.ts";
import { StateStore } from "../state/store.ts";
import type { Plugin, PluginClass } from "../../monitors/base/plugin_base.ts";
import { ActionJobs } from "./action_jobs.ts";
import { AgentPlans } from "./agent_plans.ts";
import { CycleStats, type CycleTiming } from "./cycle_stats.ts";
import { PluginDataView } from "./data_view.ts";
import { JobsGateway, sleep_unless_watched } from "./jobs.ts";
import { iter_monitors, Link, resolve_links } from "./monitor_graph.ts";
import { parse_plugin_paths, PluginLoader } from "./plugin_loader.ts";
import { ReloadResult, restart_required, same_monitor, section_changed } from "./reload.ts";
import type { ScheduledAction } from "./schedule.ts";
import type { TriggeredAction, TriggerState } from "./triggers.ts";

const log = create_logger_for("x_monitor.core.coordination.engine");

// ── Settings ─────────────────────────────────────────────────────────────────

export const STARTUP_JITTER_SECONDS = 3.0;

// How often the config file is checked for changes.
export const CONFIG_POLL_SECONDS = 3.0;

// Config keys naming a host a monitor works on from elsewhere, whose agent is asked to stay awake for the cycle.
const target_host_keys = ["target_host", "scan_host"];

const PRUNE_CHECK_SECONDS = 60;

// Cron times are whole minutes, so checking twice a minute never misses one.
const SCHEDULE_CHECK_SECONDS = 30;

const monotonic = () => performance.now() / 1000;

// ── Injected engines ─────────────────────────────────────────────────────────

// The notification engine the server injects; src/core never imports the server.
export interface NotificationsLike {
  start(roots: Plugin[]): void;
  stop(options?: { cancel_deliveries?: boolean }): void;
  // One notification that names several monitors, such as an agent's summary after an offline stretch.
  send_summary(title: string, body: string, monitor_ids: string[], status: string): void;
}

export type NotificationsFactory = (db: DatabaseManager, settings: NotificationSettings, agents: AgentRegistry) => NotificationsLike;

// The exporter engine the server injects.
export interface ExportersLike {
  start(monitors: () => Iterable<Plugin>): void;
  stop(): void;
}

export type ExportersFactory = (db: DatabaseManager, settings: ExporterSettings) => ExportersLike;

const no_notifications: NotificationsFactory = () => ({ start: () => {}, stop: () => {}, send_summary: () => {} });
const no_exporters: ExportersFactory = () => ({ start: () => {}, stop: () => {} });

// ── Helpers ──────────────────────────────────────────────────────────────────

// Reduces `user@host:port` to the lowercase host name an agent entry is keyed by.
export function bare_host(value: unknown): string {
  const host = String(value ?? "").trim().toLowerCase().split("@").at(-1)!;
  return host.split(":").length === 2 ? host.split(":")[0] : host;
}

// Seconds from `now` until UTC time is next `offset` past a multiple of `interval`.
export function seconds_to_clock_slot(interval: number, offset: number, now: number): number {
  return (((offset - now) % interval) + interval) % interval;
}

// A cycle that never reached its host is unavailable, whatever the plugin made of the empty results.
export function settle_result(plugin: Plugin, results: unknown[], result: CollectResult): CollectResult {
  if (plugin.AVAILABILITY || results.length === 0 || !results.every(unreachable)) return result;
  if (result.status === "unavailable") return result;
  return new CollectResult({ ...result, status: "unavailable" });
}

// Seconds until the plugin wants its next cycle when sooner than its interval, or null; a crash in it reads as null.
function sooner_cycle(plugin: Plugin): number | null {
  try {
    return plugin.next_cycle_in();
  } catch (error) {
    log.error(`${plugin.name}: next_cycle_in failed: ${(error as Error).message}`);
    return null;
  }
}

// Resolves after `seconds`, or as soon as the signal aborts.
export function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, seconds) * 1000);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// One monitor or link in a tree being built, with its children kept apart until the tree is put in place.
interface TreeNode {
  plugin: Plugin | Link;
  children: TreeNode[];
}

// Every monitor node in a built tree, skipping links, which only point at a monitor defined elsewhere.
function* walk(nodes: TreeNode[]): Generator<TreeNode & { plugin: Plugin }> {
  for (const node of nodes) {
    if (node.plugin instanceof Link) continue;
    yield node as TreeNode & { plugin: Plugin };
    yield* walk(node.children);
  }
}

// The tree's structure as nested ids and link labels, to tell whether a reload moved anything.
function shape(plugins: Plugin[]): string {
  const of = (list: Plugin[]): unknown[] => list.map((plugin) => [plugin.id, [...plugin.links].sort(), of(plugin.children)]);
  return JSON.stringify(of(plugins));
}

// A new config that parsed and validated, ready to put in place.
interface ReloadPlan {
  config: ConfigFileManager;
  loader: PluginLoader;
  nodes: TreeNode[];
}

// A background task: a promise that settles when its work ends or it is aborted.
export interface Task {
  readonly done: Promise<void>;
  readonly signal: AbortSignal;
  abort(): void;
}

export interface EngineOptions {
  db_path_override?: string | null;
  handle_signals?: boolean;
  // On an agent's engine, the agent's own id, whose commands run here as local processes.
  local_agent?: string | null;
  notifications?: NotificationsFactory;
  exporters?: ExportersFactory;
  // The built-in monitor types, when a test brings its own.
  builtins?: Record<string, () => Promise<PluginClass>>;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class XMonitorEngine implements EngineLike {
  readonly local_agent: string | null;
  config_loader: ConfigFileManager;
  config: Record<string, unknown>;
  plugin_loader: PluginLoader;
  readonly log_level_control: LogLevels;
  plugins: Plugin[] = [];
  log_retention_days: number;
  metric_retention_days: number;
  metric_downsample_days: number;
  cycle_timings: boolean;
  // Minus infinity, so the first prune runs at once rather than an hour after a reboot.
  last_prune = -Infinity;
  readonly collecting = new Map<string, boolean>();
  // Each polled monitor's loop task, so a reload can stop one monitor without touching the rest.
  readonly monitor_tasks = new Map<string, Task>();
  // Instances a reload replaced or removed; a cycle still in flight for one writes nothing.
  readonly retired = new WeakSet<Plugin>();
  private reload_chain: Promise<unknown> = Promise.resolve();
  // Goes up whenever a reload changes the monitor tree, so a page can tell it is showing an old one.
  monitors_version = 0;
  config_digest: string | null;
  readonly db_path_overridden: boolean;
  readonly last_collected_at = new Map<string, number>();
  readonly cycle_stats = new CycleStats();
  // Every background task until it finishes.
  readonly tasks = new Set<Task>();
  // Each monitor's command handle, by monitor id; the connection itself lives in the Connector Engine.
  readonly exec_contexts = new Map<string, ExecContext>();
  // Monitors reachable by a pushed event, by the stream id the agent sends back.
  readonly event_targets = new Map<string, Plugin>();
  // Of those, the streams that stand in for a poll rather than supplement one.
  readonly collection_streams = new Set<string>();
  // State keys of the scheduled actions now running, so a slow one is never started twice.
  readonly scheduled_running = new Set<string>();
  // Each trigger's state by its key, read once from the settings store and written back when it changes.
  readonly trigger_states = new Map<string, TriggerState>();
  readonly db_path: string;
  // False until load_state() has restored the store; nothing may write to it before then.
  ready = false;
  readonly early_agents = new Set<string>();
  // Monitors holding their first cycle after a restart because their saved result is still current.
  awaiting_due = new Set<string>();
  readonly db: DatabaseManager;
  readonly connectors: ConnectorEngine;
  readonly agent_plans: AgentPlans;
  readonly action_jobs: ActionJobs;
  exporters: ExportersLike;
  notifications: NotificationsLike;
  private readonly handle_signals: boolean;
  private signals_installed: [NodeJS.Signals, () => void][] = [];
  private readonly make_notifications: NotificationsFactory;
  private readonly make_exporters: ExportersFactory;
  private readonly builtins: Record<string, () => Promise<PluginClass>> | undefined;
  // The clocks and sleeps the loops use, which a test replaces to drive time.
  time: () => number = () => Date.now() / 1000;
  monotonic: () => number = monotonic;
  random: () => number = Math.random;
  startup_jitter_seconds = STARTUP_JITTER_SECONDS;
  config_poll_seconds = CONFIG_POLL_SECONDS;
  sleep: (seconds: number, signal?: AbortSignal) => Promise<void> = sleep;
  sleep_unless_watched: (seconds: number, wake: string, signal?: AbortSignal) => Promise<boolean> = sleep_unless_watched;

  constructor(config_path: string, options: EngineOptions = {}) {
    this.local_agent = options.local_agent ?? null;
    this.builtins = options.builtins;
    this.config_loader = new ConfigFileManager(config_path);
    this.config = this.config_loader.data;
    this.plugin_loader = this.new_loader(this.config_loader);
    this.log_level_control = new LogLevels();
    this.log_level_control.configure(this.config_loader.log_level, this.config_loader.log_levels);
    // Only the real process takes over signals; an engine built in a test leaves them alone.
    this.handle_signals = options.handle_signals ?? false;
    this.log_retention_days = this.config_loader.log_retention_days;
    this.metric_retention_days = this.config_loader.metric_retention_days;
    this.metric_downsample_days = this.config_loader.metric_downsample_days;
    this.cycle_timings = this.config_loader.cycle_timings;
    this.config_digest = this.config_loader.digest;
    this.db_path_overridden = Boolean(options.db_path_override);
    this.db_path = options.db_path_override || String(this.config_loader.database_settings?.path ?? "x-monitor.db");
    try {
      this.db = this.open_database(this.db_path);
    } catch (error) {
      log.critical(`Failed to initialize database: ${(error as Error).message}. Exiting.`);
      throw error;
    }
    this.make_notifications = options.notifications ?? no_notifications;
    this.make_exporters = options.exporters ?? no_exporters;
    this.exporters = this.make_exporters(this.db, this.config_loader.exporters);
    this.connectors = new ConnectorEngine(this.local_agent);
    this.connectors.agents.configure(this.config_loader.agents as Record<string, unknown>[]);
    this.connectors.agents.set_event_sink((agent_id, stream_id, timestamp, payload) => this.on_agent_event(agent_id, stream_id, timestamp, payload));
    this.connectors.agents.set_connect_sink((agent_id) => this.on_agent_connected(agent_id));
    this.agent_plans = new AgentPlans(this);
    this.connectors.agents.set_sync_sink((agent_id, message) => this.agent_plans.on_frame(agent_id, message));
    this.action_jobs = new ActionJobs(this);
    this.notifications = this.make_notifications(this.db, this.config_loader.notifications, this.connectors.agents);
  }

  private new_loader(config: ConfigFileManager): PluginLoader {
    const paths = parse_plugin_paths(config.plugin_paths, dirname(config.path));
    return this.builtins ? new PluginLoader(paths, this.builtins) : new PluginLoader(paths);
  }

  // The database this engine records into; an agent's engine opens one that also keeps an outbox.
  protected open_database(path: string): DatabaseManager {
    const persistence = open_sqlite_persistence(path, { write_batch_seconds: this.config_loader.write_batch_seconds });
    return new DatabaseManager({ persistence, store: new StateStore(this.config_loader.buffer_sizes) });
  }

  // Whether this monitor's agent runs it itself, so the server neither collects, schedules nor acts on it here.
  private agent_runs(plugin: Plugin): boolean {
    return this.agent_plans !== undefined && this.agent_plans.runs(plugin);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  // Builds the engine-owned IO for a monitor and hands it the read-only data view.
  private wire_plugin(plugin: Plugin, plugin_config: PluginConfig): void {
    const net = this.connectors.exec_context(plugin_config, plugin.timeout);
    // The transport resolves the target host; the monitor's labels follow it unless it is about some other host.
    plugin.target = plugin.display_target || net.target;
    this.exec_contexts.set(plugin.id, net);
    plugin.bind(new PluginDataView(this.db, plugin.id));
    const cancel_exec = async (command: string, agent: string | null = null): Promise<unknown> => {
      const plan = action_plan(command, { agent });
      return this.connectors.execute(this.action_context(net, plan), plan);
    };
    plugin.jobs = new JobsGateway(this.db, plugin, cancel_exec);
    if (net.is_agent) this.wire_subscriptions(plugin, net);
  }

  // Whether this monitor's agent collects for it, so the engine runs no polling loop; only ever on an agent target.
  is_event_driven(plugin: Plugin): boolean {
    const net = this.exec_context_for(plugin);
    if (net === null || !net.is_agent) return false;
    // A monitor its agent runs keeps a loop here, which watches for the agent going quiet.
    if (this.agent_runs(plugin)) return false;
    try {
      return Boolean(plugin.event_driven());
    } catch (error) {
      log.error(`${plugin.name}: event_driven() failed: ${(error as Error).message}`);
      return false;
    }
  }

  // Registers a monitor's event streams with its agent, keyed by the id an inbound event comes back under.
  private wire_subscriptions(plugin: Plugin, net: ExecContext): void {
    let specs;
    try {
      specs = plugin.subscriptions();
    } catch (error) {
      log.error(`${plugin.name}: subscriptions() failed: ${(error as Error).message}`);
      return;
    }
    if (specs.length === 0) return;
    const conn = net.conn as AgentConnection;
    for (const spec of specs) {
      conn.register_stream(spec);
      this.event_targets.set(spec.id, plugin);
      if (spec.kind === "sample") this.collection_streams.add(spec.id);
    }
    log.info(`${plugin.name}: subscribed to ${specs.length} agent event stream(s) on ${python_repr(conn.agent_id)}`);
  }

  // Applies one pushed event, off the polling schedule, so detection latency does not follow a monitor's interval.
  on_agent_event(agent_id: string, stream_id: string, timestamp: number, payload: Record<string, unknown>): void {
    // The agent pushes again on its next interval, so dropping this loses nothing hydration would not then overwrite.
    if (!this.ready) return;
    const plugin = this.event_targets.get(stream_id);
    if (plugin === undefined) {
      log.debug(`agent ${python_repr(agent_id)}: event for unknown stream ${python_repr(stream_id)}`);
      return;
    }
    // A sample stream is the monitor's whole collection path, so its event marks the cycle, even when it parses badly.
    if (this.collection_streams.has(stream_id)) this.last_collected_at.set(plugin.id, this.monotonic());
    let result: CollectResult | null;
    try {
      result = plugin.parse_event(stream_id, payload, timestamp);
    } catch (error) {
      log.error(`${plugin.name}: parse_event failed for ${python_repr(stream_id)}: ${(error as Error).message}`);
      return;
    }
    if (result !== null) {
      this.write(plugin, result);
      this.check_triggers(plugin, result, this.time());
    }
  }

  // Collects every monitor on an agent as soon as that agent dials in, so a first cycle that ran before the agent
  // connected does not stand for a whole interval; an agent connecting while the store loads is collected after.
  on_agent_connected(agent_id: string): void {
    if (!this.ready) {
      this.early_agents.add(agent_id);
      return;
    }
    const monitors = this.all_monitors().filter((plugin) => {
      const conn = this.exec_context_for(plugin)?.conn;
      // A monitor still waiting out its saved result runs when due, so a restart never repeats a daily scan.
      return conn instanceof AgentConnection && conn.agent_id === agent_id && !this.awaiting_due.has(plugin.id) && !this.agent_runs(plugin);
    });
    if (monitors.length === 0) return;
    log.info(`agent ${python_repr(agent_id)} connected: collecting its ${monitors.length} monitor(s) now`);
    for (const plugin of monitors) this.spawn(() => this.collect_on_connect(plugin));
  }

  private async collect_on_connect(plugin: Plugin): Promise<void> {
    // A failed warm-up cycle is only logged; the monitor's normal schedule retries.
    try {
      await this.run_cycle_now(plugin);
    } catch (error) {
      log.error(`${plugin.name}: collection on agent connect failed: ${(error as Error).message}`);
    }
  }

  // Stores a monitor's CollectResult; the engine owns the write path and supplies the monitor's identity.
  private write(plugin: Plugin, result: CollectResult): void {
    this.db.apply_result(plugin.target, plugin.id, plugin.name, result);
  }

  exec_context_for(plugin: Plugin): ExecContext | null {
    return this.exec_contexts.get(plugin.id) ?? null;
  }

  // ── Building the tree ──────────────────────────────────────────────────

  private apply_ssh_defaults(plugin_config: PluginConfig, defaults: Record<string, unknown>): PluginConfig {
    if (!defaults || Object.keys(defaults).length === 0 || !("ssh_config" in plugin_config)) return plugin_config;
    return { ...plugin_config, ssh_config: { ...defaults, ...(plugin_config.ssh_config as Record<string, unknown>) } };
  }

  // A monitor's config as its plugin sees it: ssh_defaults merged in and its group's agent inherited.
  effective_config(plugin_config: PluginConfig, ssh_defaults: Record<string, unknown>, inherited_agent: string | null): PluginConfig {
    const config = this.apply_ssh_defaults(plugin_config, ssh_defaults);
    if (inherited_agent && !config.agent) return { ...config, agent: inherited_agent };
    return config;
  }

  // Constructs the monitors a config declares, reusing a running instance from `keep` wherever its config is
  // unchanged; nothing touches the running tree, and a `ref:` entry becomes a link resolved once the tree is built.
  private async build_tree(plugins_config: PluginConfig[], loader: PluginLoader, ssh_defaults: Record<string, unknown>, keep: Map<string, Plugin>, errors: string[], on_new: ((plugin: Plugin) => void) | null = null, inherited_agent: string | null = null): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];
    for (const plugin_config of plugins_config) {
      if ("ref" in plugin_config) {
        nodes.push({ plugin: new Link(String(plugin_config.ref), (plugin_config.name as string | undefined) ?? null), children: [] });
        continue;
      }
      const name = plugin_config.name as string;
      const type = plugin_config.type;
      const config = this.effective_config(plugin_config, ssh_defaults, inherited_agent);
      let plugin: Plugin;
      // One bad monitor config or module must not stop the rest from loading.
      try {
        const cls = await loader.resolve(type);
        const existing = keep.get(String(config.id ?? name));
        if (existing !== undefined && same_monitor(existing, config, cls)) {
          plugin = existing;
        } else {
          plugin = new cls(name, config);
          on_new?.(plugin);
          log.info(`Loaded plugin '${name}' of type '${String(type)}'`);
        }
      } catch (error) {
        errors.push(`'${String(name)}' (${String(type)}): ${(error as Error).message}`);
        continue;
      }
      let children: TreeNode[] = [];
      if ("children" in config) children = await this.build_tree((config.children as PluginConfig[]) ?? [], loader, ssh_defaults, keep, errors, on_new, (config.agent as string | undefined) ?? null);
      nodes.push({ plugin, children });
    }
    return nodes;
  }

  // Gives every monitor in a built tree its children, returning the roots with links still unresolved.
  private static attach(nodes: TreeNode[]): (Plugin | Link)[] {
    for (const node of nodes) {
      if (node.plugin instanceof Link) continue;
      node.plugin.links = new Map();
      node.plugin.children = XMonitorEngine.attach(node.children) as Plugin[];
    }
    return nodes.map((node) => node.plugin);
  }

  // Puts a built tree in place: attaches every monitor's children, then swaps each link for the monitor it names.
  private static place(nodes: TreeNode[]): Plugin[] {
    return resolve_links<Plugin>(XMonitorEngine.attach(nodes));
  }

  private wire_new(plugin: Plugin): void {
    plugin.engine = this;
    this.wire_plugin(plugin, plugin.config);
  }

  // Builds and wires the monitor tree config.yaml declares, skipping any monitor that fails to load.
  async setup_modules(): Promise<Plugin[]> {
    const errors: string[] = [];
    const nodes = await this.build_tree(this.config_loader.plugins, this.plugin_loader, this.config_loader.ssh_defaults, new Map(), errors, (plugin) => this.wire_new(plugin));
    for (const error of errors) log.error(`Failed to load plugin ${error} — this monitor will not run`);
    this.plugins = XMonitorEngine.place(nodes);
    log.info(`Plugin registry built with ${this.plugins.length} root-level monitors.`);
    this.warn_on_duplicate_ids();
    return this.plugins;
  }

  // Every monitor in the tree, once each, parents before children.
  all_monitors(): Plugin[] {
    return [...iter_monitors(this.plugins)];
  }

  private warn_on_duplicate_ids(): void {
    const seen = new Map<string, string>();
    const duplicates = new Map<string, string[]>();
    // A linked monitor is the same instance in every place, so only separate definitions can collide.
    for (const plugin of this.all_monitors()) {
      const first = seen.get(plugin.id);
      if (first === undefined) seen.set(plugin.id, plugin.name);
      else duplicates.set(plugin.id, [...(duplicates.get(plugin.id) ?? [first]), plugin.name]);
    }
    for (const [id, names] of duplicates) {
      const unique = [...new Set(names)].sort();
      log.error(`Duplicate monitor id ${python_repr(id)} used by ${names.length} monitors (${unique.join(", ")}). Their status, metrics and logs will overwrite each other — give each an explicit unique \`id\`.`);
      this.db.insert_event("ERROR", `[x_monitor_core] Duplicate monitor id ${python_repr(id)} used by: ${unique.join(", ")}`, "x_monitor_core");
    }
  }

  private start_exporters(): void {
    this.exporters.start(() => iter_monitors(this.plugins));
  }

  // ── Collection ─────────────────────────────────────────────────────────

  // One collection cycle: the monitor's requests (or its io_call) run through the connectors, its pure parse turns the
  // results into a CollectResult, and the database stores it.
  async run_cycle(plugin: Plugin): Promise<boolean> {
    const started = performance.now() / 1000;
    let collected: number;
    let result: CollectResult;
    let did_io: boolean;
    let wait_seconds = 0;
    const io = plugin.io_call();
    if (io !== null) {
      const io_result = await io();
      collected = performance.now() / 1000;
      result = plugin.parse_results([io_result as Result]);
      did_io = true;
    } else {
      const requests = plugin.requests();
      const net = this.exec_context_for(plugin);
      const results = await measure_channel_wait(async (tally) => {
        const gathered = requests.length > 0 ? await this.connectors.dispatch(net, requests) : [];
        wait_seconds = tally.seconds;
        return gathered;
      });
      collected = performance.now() / 1000;
      result = settle_result(plugin, results, plugin.parse_results(results));
      did_io = requests.length > 0;
    }
    const parsed = performance.now() / 1000;
    if (this.retired.has(plugin)) return false;
    this.write(plugin, result);
    this.react(plugin, result);
    this.check_triggers(plugin, result, this.time());
    if (did_io) {
      this.cycle_stats.record(plugin.id, parsed - started, wait_seconds);
      if (this.cycle_timings) this.record_cycle_timing(plugin, started, collected, parsed);
    }
    return true;
  }

  // Records where a cycle's wall clock went, so transport cost and parse cost are separable.
  private record_cycle_timing(plugin: Plugin, started: number, collected: number, parsed: number): void {
    this.db.insert_metric(plugin.target, plugin.id, "cycle_collect_seconds", collected - started);
    this.db.insert_metric(plugin.target, plugin.id, "cycle_parse_seconds", parsed - collected);
  }

  // Runs one cycle now, single-flight with the scheduler: a cycle already running is not started again.
  async run_cycle_now(plugin: Plugin): Promise<boolean> {
    if (this.agent_runs(plugin)) return this.agent_plans.poll_now(plugin);
    if (this.collecting.get(plugin.id)) {
      log.debug(`${plugin.name}: previous collection still running, skipping poll-triggered cycle`);
      return false;
    }
    this.collecting.set(plugin.id, true);
    try {
      return await this.held_awake(plugin, () => this.run_cycle(plugin));
    } finally {
      this.last_collected_at.set(plugin.id, this.monotonic());
      this.collecting.set(plugin.id, false);
    }
  }

  // The connected agents on the hosts a monitor works on remotely, other than the one it runs on.
  private target_agents(plugin: Plugin): AgentConnection[] {
    const config = plugin.config ?? {};
    const hosts = new Set(target_host_keys.filter((key) => config[key]).map((key) => bare_host(config[key])));
    if (hosts.size === 0) return [];
    const own = this.exec_context_for(plugin)?.conn;
    return this.connectors.agents.all.filter((conn) => conn !== own && conn.is_connected && hosts.has(bare_host(conn.host)));
  }

  // Keeps the hosts a monitor scans or acts on from elsewhere awake while `work` runs.
  private async held_awake<Value>(plugin: Plugin, work: () => Promise<Value>): Promise<Value> {
    const targets = this.target_agents(plugin);
    const key = `${plugin.id}:${crypto.randomUUID().replaceAll("-", "")}`;
    for (const conn of targets) await conn.inhibit(key, true);
    try {
      return await work();
    } finally {
      for (const conn of targets) await conn.inhibit(key, false);
    }
  }

  // Monotonic seconds of a monitor's last finished cycle, 0 when none has finished yet.
  last_collected(plugin_id: string): number {
    return this.last_collected_at.get(plugin_id) ?? 0;
  }

  // A monitor's recent cycle durations and SSH channel wait, null before its first cycle that did IO.
  cycle_timing(plugin_id: string): CycleTiming | null {
    return this.cycle_stats.get(plugin_id);
  }

  // ── Actions ────────────────────────────────────────────────────────────

  // Runs one action with the hosts it works on held awake; a monitor its agent runs takes the action there.
  async dispatch_action(plugin: Plugin, action_id: string, args: Record<string, unknown> = {}): Promise<DispatchResult> {
    if (this.agent_runs(plugin)) return this.agent_plans.dispatch(plugin, action_id, args);
    return this.held_awake(plugin, () => this.dispatch_action_here(plugin, action_id, args));
  }

  // Returns success and the metadata of the CollectResult it applied, if any, such as `content` for a read-style action.
  private async dispatch_action_here(plugin: Plugin, action_id: string, args: Record<string, unknown>): Promise<DispatchResult> {
    let net = this.exec_context_for(plugin)!;
    const finish = (outcome: ActionOutcome) => this.finish_action(plugin, outcome);

    const custom = plugin.custom_action(action_id);
    if (custom !== null) {
      const plan = custom.plan();
      if (plan.detached) return this.action_jobs.launch(plugin, action_id, plan, this.action_context(net, plan), (result) => custom.interpret(result), args);
      const result = await this.connectors.execute(this.action_context(net, plan), plan);
      return finish(custom.interpret(result));
    }

    const plan = plugin.plan_action(action_id, args);
    if (plan === null) return [false, null];
    if (plan instanceof CollectResult) {
      this.write(plugin, plan);
      return [plan.success, Object.keys(plan.metadata).length > 0 ? plan.metadata : null];
    }
    switch (plan.kind) {
      case "io_action": {
        const io_result = await plan.call();
        return finish(plugin.interpret_action(action_id, io_result, args));
      }
      case "http":
      case "dns":
      case "ping": {
        const [result] = await this.connectors.dispatch(net, [plan]);
        return finish(plugin.interpret_action(action_id, result, args));
      }
      case "action_plan": {
        // A short command, on another monitor's transport when the plan names one.
        if (plan.via) {
          const via = this.exec_contexts.get(plan.via);
          if (via === undefined) return finish(plugin.interpret_action(action_id, cmd_result(-1, "", `No monitor ${python_repr(plan.via)} to run this through`), args));
          net = via;
        }
        if (plan.detached) {
          return this.action_jobs.launch(plugin, action_id, plan, this.action_context(net, plan), (result) => plugin.interpret_action(action_id, result, args), args);
        }
        const result = await this.connectors.execute(this.action_context(net, plan), plan);
        return finish(plugin.interpret_action(action_id, result, args));
      }
    }
  }

  // Stores an action's outcome when it is a CollectResult, and returns it as [success, metadata].
  finish_action(plugin: Plugin, outcome: ActionOutcome): DispatchResult {
    if (outcome instanceof CollectResult) {
      this.write(plugin, outcome);
      return [outcome.success, Object.keys(outcome.metadata).length > 0 ? outcome.metadata : null];
    }
    return [Boolean(outcome), null];
  }

  // The connection a job of this monitor runs over, or null when the monitor has none.
  job_context(plugin: Plugin, agent: string | null = null): ExecContext | null {
    const net = this.exec_context_for(plugin);
    if (net === null) return null;
    return agent ? this.action_context(net, action_plan("", { agent })) : net;
  }

  // The connection a plan runs over: the monitor's own target, or another agent's host when the plan names one.
  action_context(net: ExecContext, plan: ActionPlan): ExecContext {
    if (!plan.agent) return net;
    return new ExecContext(this.connectors.agent_connection(plan.agent), net.collect_timeout);
  }

  // Runs the action a monitor asks for in reaction to the status its cycle just recorded, as its own task.
  private react(plugin: Plugin, result: CollectResult): void {
    if (result.status === null) return;
    let reaction;
    try {
      reaction = plugin.on_status(String(result.status), this.monotonic());
    } catch (error) {
      log.error(`${plugin.name}: on_status() failed: ${(error as Error).message}`);
      return;
    }
    if (reaction) {
      const [action_id, args] = reaction;
      this.spawn(() => this.run_reaction(plugin, action_id, args));
    }
  }

  private async run_reaction(plugin: Plugin, action_id: string, args: Record<string, unknown>): Promise<void> {
    // The action logs its own outcome; a crash in it is only logged, so the next cycle can ask again.
    try {
      await this.dispatch_action(plugin, action_id, args);
    } catch (error) {
      log.error(`${plugin.name}: automatic ${python_repr(action_id)} failed: ${(error as Error).message}`);
    }
  }

  // A setting the page writes, such as a group's expand state.
  set_setting(key: string, value: string): void {
    this.db.set_setting(key, value);
  }

  // Stores a CollectResult a monitor produced outside a cycle, such as a push from the REST endpoint.
  apply(plugin: Plugin, result: CollectResult): void {
    this.write(plugin, result);
  }

  // Runs one request through the shared HTTP connector, for a monitor whose HTTP calls depend on each other.
  http_fetch(request: HttpRequest): Promise<HttpResult> {
    return this.connectors.http.fetch(request);
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  // Seconds until a monitor's saved result is one interval old, or 0 when it has none or it is already stale.
  seconds_until_due(plugin: Plugin): number {
    const last = this.db.latest_status_time(plugin.id);
    if (last === null) return 0;
    return Math.max(0, plugin.interval - (Date.now() - last.getTime()) / 1000);
  }

  // Polls one monitor until aborted, first waiting at least `hold` seconds for a saved result to come due.
  async monitor_loop(plugin: Plugin, hold: number, signal: AbortSignal): Promise<void> {
    const offset = plugin.offset;
    if (offset === null) await this.sleep(Math.max(hold, this.random() * this.startup_jitter_seconds), signal);
    else await this.sleep(seconds_to_clock_slot(plugin.interval, offset, this.time()), signal);
    if (signal.aborted) return;
    if (hold) this.awaiting_due.delete(plugin.id);
    let next_due = this.monotonic();
    let early = false;
    while (!signal.aborted) {
      // A failing cycle must not end its loop; the next tick retries.
      try {
        if (this.agent_runs(plugin)) this.agent_plans.check_silence(plugin);
        else await this.run_cycle_now(plugin);
      } catch (error) {
        log.error(`Plugin execution error (${plugin.name}): ${(error as Error).message}`);
      }
      if (signal.aborted) return;
      let wait: number;
      if (offset !== null) {
        // A clock-pinned monitor reads the wall clock each cycle, so a suspend or a slow cycle never shifts its slot.
        wait = seconds_to_clock_slot(plugin.interval, offset, this.time());
        if (wait < 1) wait += plugin.interval;
      } else {
        // The interval is the period, not the gap; an overrun re-anchors rather than bursts, and an early cycle leaves
        // the due time where it was.
        if (!early) next_due += plugin.interval;
        const now = this.monotonic();
        if (next_due <= now) next_due = now + plugin.interval;
        wait = next_due - now;
      }
      const sooner = sooner_cycle(plugin);
      early = sooner !== null && sooner < wait;
      // A log view opened mid-sleep starts the faster polling at once, and that cycle counts as early.
      early = (await this.sleep_unless_watched(early ? sooner! : wait, plugin.id, signal)) || early;
    }
  }

  private async schedule_loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.start_due_schedules(this.time());
      } catch (error) {
        log.error(`Scheduled action check failed: ${(error as Error).message}`);
      }
      await this.sleep(SCHEDULE_CHECK_SECONDS, signal);
    }
  }

  // Starts every scheduled action whose next run has come, recording it as handled first, so a restart never repeats
  // it and runs missed while X-Monitor was down collapse into one; a schedule seen for the first time only records.
  start_due_schedules(now: number): void {
    for (const plugin of iter_monitors(this.plugins)) {
      // The agent that runs a monitor runs its schedule too.
      if (this.agent_runs(plugin)) continue;
      for (const entry of plugin.scheduled_actions) {
        const key = entry.state_key(plugin.id);
        if (this.scheduled_running.has(key)) continue;
        const handled = this.db.get_setting(key);
        if (handled !== null && !entry.due(Number.parseFloat(handled), now)) continue;
        this.db.set_setting(key, String(Math.trunc(now)));
        if (handled === null) continue;
        this.scheduled_running.add(key);
        this.spawn(() => this.run_scheduled(plugin, entry, key));
      }
    }
  }

  // Runs one scheduled action as its button would, recording the outcome on the monitor and for the Schedules view.
  private async run_scheduled(plugin: Plugin, entry: ScheduledAction, key: string): Promise<void> {
    const label = `Scheduled ${entry.action} (${entry.cron.expression})`;
    const started = Math.trunc(this.time());
    let success = false;
    let line: [string, string];
    try {
      [success] = await this.dispatch_action(plugin, entry.action, entry.args);
      line = success ? [`${label} ran`, "INFO"] : [`${label} failed`, "ERROR"];
    } catch (error) {
      line = [`${label} failed: ${(error as Error).message}`, "ERROR"];
    } finally {
      this.scheduled_running.delete(key);
    }
    this.db.set_setting(entry.result_key(plugin.id), python_dumps({ at: started, ok: Boolean(success), message: line[0] }));
    this.write(plugin, new CollectResult({ logs: [line] }));
  }

  // Starts every triggered action whose condition this cycle has held long enough, recording it as run first, so a
  // restart never repeats it for the same episode.
  check_triggers(plugin: Plugin, result: CollectResult, now: number): void {
    for (const entry of plugin.triggered_actions ?? []) {
      const key = entry.state_key(plugin.id);
      let fire: boolean;
      try {
        const state = this.trigger_state(key);
        const [next, fires] = entry.step(state, entry.condition.holds(result), now);
        fire = fires;
        if (!deep_equal(next, state)) {
          this.trigger_states.set(key, next);
          this.db.set_setting(key, python_dumps(next));
        }
      } catch (error) {
        log.error(`${plugin.name}: trigger for ${python_repr(entry.action)} failed: ${(error as Error).message}`);
        continue;
      }
      if (fire) this.spawn(() => this.run_triggered(plugin, entry));
    }
  }

  // A trigger's state, read from the settings store the first time and kept in memory after.
  private trigger_state(key: string): TriggerState {
    let state = this.trigger_states.get(key);
    if (state === undefined) {
      let stored: unknown;
      try {
        stored = JSON.parse(this.db.get_setting(key) || "{}");
      } catch {
        stored = {};
      }
      state = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as TriggerState) : {};
      this.trigger_states.set(key, state);
    }
    return state;
  }

  private async run_triggered(plugin: Plugin, entry: TriggeredAction): Promise<void> {
    const label = `Triggered ${entry.action} (${entry.describe()})`;
    const started = Math.trunc(this.time());
    let success = false;
    let line: [string, string];
    try {
      [success] = await this.dispatch_action(plugin, entry.action, entry.args);
      line = success ? [`${label} ran`, "INFO"] : [`${label} failed`, "ERROR"];
    } catch (error) {
      line = [`${label} failed: ${(error as Error).message}`, "ERROR"];
    }
    this.db.set_setting(entry.result_key(plugin.id), python_dumps({ at: started, ok: Boolean(success), message: line[0] }));
    this.write(plugin, new CollectResult({ logs: [line] }));
  }

  private async prune_loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.maybe_prune_logs();
      await this.sleep(PRUNE_CHECK_SECONDS, signal);
    }
  }

  // Starts a background task, kept in `tasks` until it ends or is aborted.
  spawn(work: (signal: AbortSignal) => Promise<unknown>): Task {
    const controller = new AbortController();
    const aborted = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    const running = (async () => {
      try {
        await work(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) log.error(`Background task failed: ${(error as Error).message}`);
      }
    })();
    const task: Task = {
      done: Promise.race([running, aborted]).finally(() => this.tasks.delete(task)),
      signal: controller.signal,
      abort: () => controller.abort(),
    };
    this.tasks.add(task);
    return task;
  }

  // Waits until every background task has ended, as a test does after a cycle that spawns actions.
  async settle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks].map((task) => task.done));
  }

  // ── Log levels ─────────────────────────────────────────────────────────

  log_levels(): Record<string, string> {
    return this.log_level_control.levels();
  }

  known_loggers(): string[] {
    return LogLevels.known_loggers();
  }

  // Changes one logger's level now, or the root's when no logger is named; no level makes a named logger inherit.
  set_log_level(logger: string | null, level: string | null, source = "runtime"): Record<string, string> {
    return this.log_level_control.set_level(logger, level, source);
  }

  // SIGHUP reloads the config; SIGUSR1 and SIGUSR2 step logging more verbose or quieter.
  install_signal_handlers(): void {
    const handlers: [NodeJS.Signals, () => void][] = [
      ["SIGUSR1", () => void this.log_level_control.step(true, "SIGUSR1")],
      ["SIGUSR2", () => void this.log_level_control.step(false, "SIGUSR2")],
      ["SIGHUP", () => void this.spawn(() => this.reload_config("SIGHUP"))],
    ];
    for (const [name, handler] of handlers) {
      try {
        process.on(name, handler);
        this.signals_installed.push([name, handler]);
      } catch (error) {
        log.warn(`Cannot handle ${name}: ${(error as Error).message}`);
      }
    }
  }

  remove_signal_handlers(): void {
    for (const [name, handler] of this.signals_installed) process.off(name, handler);
    this.signals_installed = [];
  }

  get signals(): NodeJS.Signals[] {
    return this.signals_installed.map(([name]) => name);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  // Stops background tasks, closes every transport, and flushes pending writes to disk.
  async shutdown(): Promise<void> {
    this.remove_signal_handlers();
    for (const task of [...this.tasks]) task.abort();
    this.exporters.stop();
    this.notifications.stop();
    this.connectors.close();
    this.db.stop_downsampling();
    await this.db.flush();
    await this.plugin_loader.close();
    log.info("X-Monitor Engine shut down cleanly.");
  }

  // Restores the store from the database and records the restart.
  async load_state(): Promise<void> {
    const started = this.monotonic();
    await this.db.hydrate();
    this.db.insert_event("INFO", "X-Monitor Engine initialized.", "x_monitor_core");
    const orphaned = this.db.reconcile_orphaned_jobs();
    if (orphaned) log.warn(`Marked ${orphaned} orphaned job(s) as failed after restart`);
    log.info(`Saved state loaded in ${(this.monotonic() - started).toFixed(1)}s`);
  }

  async run(): Promise<void> {
    const monitors = this.all_monitors();
    let polled = monitors.filter((plugin) => !this.is_event_driven(plugin));
    let holds = new Map<string, number>();
    if (!this.ready) {
      await this.load_state();
      this.ready = true;
      // Which monitors their agents run is only known once the store has loaded.
      polled = monitors.filter((plugin) => !this.is_event_driven(plugin));
      holds = new Map(polled.map((plugin) => [plugin.id, this.seconds_until_due(plugin)]));
      this.awaiting_due = new Set([...holds].filter(([, hold]) => hold > 0).map(([id]) => id));
      for (const agent_id of [...this.early_agents].sort()) this.on_agent_connected(agent_id);
      this.early_agents.clear();
    }
    log.info("X-Monitor Engine started...");
    this.db.insert_event("INFO", "X-Monitor Engine started polling loop.", "x_monitor_core");
    this.start_exporters();
    // Broken notification settings must not stop monitoring.
    try {
      this.notifications.start(this.plugins);
    } catch (error) {
      log.error(`Failed to start notifications — none will be sent: ${(error as Error).message}`);
    }
    log.info(`Starting ${polled.length} independent monitor schedule(s); ${monitors.length - polled.length} collect on their agent.`);
    for (const plugin of polled) {
      const hold = holds.get(plugin.id) ?? 0;
      this.monitor_tasks.set(plugin.id, this.spawn((signal) => this.monitor_loop(plugin, hold, signal)));
    }
    if (monitors.some((plugin) => plugin.scheduled_actions.length > 0)) this.spawn((signal) => this.schedule_loop(signal));
    this.spawn((signal) => this.prune_loop(signal));
    this.spawn((signal) => this.action_jobs.run(signal));
    this.spawn((signal) => this.watch_config(signal));
    if (this.handle_signals) this.install_signal_handlers();
  }

  maybe_prune_logs(interval = 3600): void {
    // Nothing to prune when every retention window is off.
    if (this.log_retention_days <= 0 && this.metric_retention_days <= 0 && this.metric_downsample_days <= 0) return;
    const now = this.monotonic();
    if (now - this.last_prune < interval) return;
    this.last_prune = now;
    const failed = (error: unknown) => log.error(`Retention prune failed: ${(error as Error).message}`);
    // A failed prune must not end the prune loop; the next hourly pass retries.
    try {
      // Logs and jobs share the log window; metrics and status history use their own, each off at 0 or less.
      this.db.prune_logs(this.log_retention_days).catch(failed);
      this.db.prune_jobs(this.log_retention_days).catch(failed);
      this.db.prune_metrics(this.metric_retention_days).catch(failed);
      this.db.prune_status(this.metric_retention_days).catch(failed);
      this.db.downsample_metrics(this.metric_downsample_days);
    } catch (error) {
      failed(error);
    }
  }

  // ── Config reload ──────────────────────────────────────────────────────

  // Re-reads the config and applies it in place, or keeps the running config and says why; unchanged monitors keep
  // running untouched. Reloads run one at a time, and each records a summary event.
  reload_config(source = "api"): Promise<ReloadResult> {
    const next = this.reload_chain.then(() => this.reload_now(source));
    this.reload_chain = next.catch(() => {});
    return next;
  }

  private async reload_now(source: string): Promise<ReloadResult> {
    const result = new ReloadResult(source);
    if (!this.ready) {
      result.ok = false;
      result.error = "X-Monitor is still starting";
      return result;
    }
    // Anything wrong with the new file must leave the running config exactly as it was.
    let plan: ReloadPlan;
    try {
      plan = await this.plan_reload();
    } catch (error) {
      result.ok = false;
      result.error = (error as Error).message;
      this.record_reload(result);
      return result;
    }
    await this.apply_reload(plan, result);
    this.record_reload(result);
    this.spawn(() => this.agent_plans.refresh());
    return result;
  }

  // Parses the config file and constructs every monitor it declares, throwing at the first sign it cannot apply whole.
  private async plan_reload(): Promise<ReloadPlan> {
    const config = new ConfigFileManager(this.config_loader.path, true);
    const loader = this.new_loader(config);
    const keep = new Map(this.all_monitors().map((plugin) => [plugin.id, plugin]));
    const errors: string[] = [];
    const nodes = await this.build_tree(config.plugins, loader, config.ssh_defaults, keep, errors);
    if (errors.length > 0) throw new Error(`monitor ${errors.join("; ")}`);
    const ids = [...walk(nodes)].map((node) => node.plugin.id);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
    if (duplicates.length > 0) throw new Error(`duplicate monitor id(s) ${duplicates.join(", ")} — give each an explicit unique \`id\``);
    return { config, loader, nodes };
  }

  private async apply_reload(plan: ReloadPlan, result: ReloadResult): Promise<void> {
    const old = new Map(this.all_monitors().map((plugin) => [plugin.id, plugin]));
    const fresh_tree = new Map([...walk(plan.nodes)].map((node) => [node.plugin.id, node.plugin]));
    result.added = [...fresh_tree.keys()].filter((id) => !old.has(id)).sort();
    result.removed = [...old.keys()].filter((id) => !fresh_tree.has(id)).sort();
    result.changed = [...fresh_tree.keys()].filter((id) => old.has(id) && fresh_tree.get(id) !== old.get(id)).sort();
    const old_config = this.config;
    const old_shape = shape(this.plugins);

    const agents = await this.retire([...result.removed, ...result.changed].map((id) => old.get(id)!));

    const old_loader = this.plugin_loader;
    this.config_loader = plan.config;
    this.config = plan.config.data;
    this.plugin_loader = plan.loader;
    this.config_digest = plan.config.digest;
    this.apply_settings(old_config);
    if (old_loader !== plan.loader) void old_loader.close();

    const fresh = [...result.added, ...result.changed].map((id) => fresh_tree.get(id)!);
    for (const plugin of fresh) {
      // Wiring builds no IO, so it does not fail in practice; if it does, only that monitor stays down.
      try {
        this.wire_new(plugin);
      } catch (error) {
        log.error(`${plugin.name}: could not be wired after reload — it will not run: ${(error as Error).message}`);
        continue;
      }
      const net = this.exec_context_for(plugin);
      if (net !== null && net.conn instanceof AgentConnection) agents.add(net.conn);
    }
    this.plugins = XMonitorEngine.place(plan.nodes);

    const closed = this.connectors.close_unused([...this.exec_contexts.values()].map((context) => context.conn));
    if (closed) log.info(`Closed ${closed} SSH connection(s) no monitor uses any more`);
    await Promise.all([...agents].map((conn) => conn.push_subscriptions()));
    for (const plugin of fresh) {
      if (this.exec_contexts.has(plugin.id) && !this.is_event_driven(plugin)) {
        this.monitor_tasks.set(plugin.id, this.spawn((signal) => this.monitor_loop(plugin, 0, signal)));
      }
    }

    const tree_changed = result.added.length + result.removed.length + result.changed.length > 0 || shape(this.plugins) !== old_shape;
    if (tree_changed || section_changed(old_config, this.config, "notifications")) this.restart_notifications();
    if (section_changed(old_config, this.config, "exporters")) {
      this.exporters.stop();
      this.exporters = this.make_exporters(this.db, this.config_loader.exporters);
      this.start_exporters();
    }
    result.restart_required = restart_required(old_config, this.config, this.db_path_overridden);
    if (tree_changed) {
      this.monitors_version += 1;
      CHANGES.publish(changes.MONITORS);
    }
  }

  // Stops monitors a reload removes or replaces, returning the agents whose stream sets changed.
  private async retire(plugins: Plugin[]): Promise<Set<AgentConnection>> {
    const stopping: Promise<void>[] = [];
    const agents = new Set<AgentConnection>();
    for (const plugin of plugins) {
      this.retired.add(plugin);
      const task = this.monitor_tasks.get(plugin.id);
      this.monitor_tasks.delete(plugin.id);
      if (task !== undefined) {
        task.abort();
        stopping.push(task.done);
      }
      const net = this.exec_contexts.get(plugin.id);
      this.exec_contexts.delete(plugin.id);
      for (const [stream_id, target] of [...this.event_targets]) {
        if (target !== plugin) continue;
        this.event_targets.delete(stream_id);
        this.collection_streams.delete(stream_id);
        if (net !== undefined && net.conn instanceof AgentConnection) {
          net.conn.unregister_stream(stream_id);
          agents.add(net.conn);
        }
      }
    }
    await Promise.allSettled(stopping);
    for (const plugin of plugins) {
      this.collecting.delete(plugin.id);
      this.last_collected_at.delete(plugin.id);
      this.cycle_stats.forget(plugin.id);
    }
    // The agent keeps a stream whose id it already runs, so retired streams leave first and a changed one restarts.
    await Promise.all([...agents].map((conn) => conn.push_subscriptions()));
    return agents;
  }

  // Applies the global settings a reload can change in place.
  private apply_settings(old_config: Record<string, unknown>): void {
    this.log_retention_days = this.config_loader.log_retention_days;
    this.metric_retention_days = this.config_loader.metric_retention_days;
    this.metric_downsample_days = this.config_loader.metric_downsample_days;
    this.cycle_timings = this.config_loader.cycle_timings;
    const old_logging = (old_config.logging || {}) as Record<string, unknown>;
    const new_logging = (this.config.logging || {}) as Record<string, unknown>;
    if (!deep_equal([old_logging.level ?? null, old_logging.levels ?? null], [new_logging.level ?? null, new_logging.levels ?? null])) {
      this.log_level_control.configure(this.config_loader.log_level, this.config_loader.log_levels);
    }
    if (section_changed(old_config, this.config, "agents")) this.connectors.agents.configure(this.config_loader.agents as Record<string, unknown>[]);
  }

  private restart_notifications(): void {
    // Deliveries already under way finish; only the watching moves to the new rules.
    this.notifications.stop({ cancel_deliveries: false });
    this.notifications = this.make_notifications(this.db, this.config_loader.notifications, this.connectors.agents);
    try {
      this.notifications.start(this.plugins);
    } catch (error) {
      log.error(`Failed to start notifications after reload — none will be sent: ${(error as Error).message}`);
    }
  }

  private record_reload(result: ReloadResult): void {
    const level = !result.ok ? "ERROR" : result.restart_required.length > 0 ? "WARNING" : "INFO";
    if (level === "ERROR") log.error(result.summary());
    else if (level === "WARNING") log.warn(result.summary());
    else log.info(result.summary());
    this.db.insert_event(level, `[x_monitor_core] ${result.summary()}`, "x_monitor_core");
  }

  // Reloads when the config changes: checked every few seconds, and applied once it has held still for one check.
  private async watch_config(signal: AbortSignal): Promise<void> {
    const watch = watch_config({
      path: this.config_loader.path, loaded_digest: () => this.config_digest, reload: () => this.reload_config("file change"),
      // A failed reload is already reported; the watcher keeps watching.
      on_error: (error) => log.error(`Config reload after a file change failed: ${(error as Error).message}`),
    }, false);
    while (!signal.aborted) {
      await this.sleep(this.config_poll_seconds, signal);
      if (signal.aborted) return;
      await watch.check();
    }
  }
}
