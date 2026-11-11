// Finds the Plugin class for a monitor's `type`: among X-Monitor's own monitor types, or in the folders `plugin_paths`
// names. Each folder holds X-Libs folder plugins, whose server entry provides `monitor_type` entries keyed by type
// name; they load through an X-Libs plugin host. A built-in wins over a folder's type of the same name unless that
// folder's entry says `override: true`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { plugin_entries } from "@x-tech-laboratories/x-libs/plugin_folder";
import { create_plugin_host, type Plugin as HostPlugin, type PluginHost } from "@x-tech-laboratories/x-libs/plugins";

import { builtin_monitor_types } from "../../monitors/index.ts";
import type { PluginClass } from "../../monitors/base/plugin_base.ts";
import { create_logger_for } from "../logging.ts";
import { python_repr } from "../python.ts";

const log = create_logger_for("x_monitor.core.coordination.plugin_loader");

// What X-Monitor lets a folder plugin reach: it provides monitor types by name.
export interface MonitorPluginApi {
  providers: { monitor_type: PluginClass };
}

// The side of a folder plugin the server loads.
export const PLUGIN_SIDE = "server";

function app_version(): string {
  try {
    const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
    return String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

// ── Plugin paths ─────────────────────────────────────────────────────────────

// One `plugin_paths` folder; with override its monitor types win over a built-in of the same name.
export interface PluginPath {
  readonly directory: string;
  readonly override: boolean;
}

function is_directory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Reads `plugin_paths`: each entry a folder, or a mapping with `path` and `override`, relative to the config file.
export function parse_plugin_paths(entries: unknown, base: string): PluginPath[] {
  const paths: PluginPath[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    let raw: unknown;
    let override = false;
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      raw = (entry as Record<string, unknown>).path;
      override = Boolean((entry as Record<string, unknown>).override ?? false);
    } else {
      raw = entry;
    }
    if (!raw) {
      log.warn(`plugin_paths: entry ${python_repr(entry)} names no directory, ignored`);
      continue;
    }
    let directory = String(raw);
    if (directory === "~" || directory.startsWith("~/")) directory = join(homedir(), directory.slice(1));
    if (!isAbsolute(directory)) directory = resolve(base, directory);
    if (!is_directory(directory)) {
      log.warn(`plugin_paths: ${directory} is not a directory, ignored`);
      continue;
    }
    paths.push({ directory, override });
  }
  return paths;
}

// ── Loader ───────────────────────────────────────────────────────────────────

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Resolves monitor types to classes, loading each at most once per loader.
export class PluginLoader {
  readonly paths: PluginPath[];
  private readonly classes = new Map<string, PluginClass>();
  private readonly builtins: Record<string, () => Promise<PluginClass>>;
  private host: PluginHost<MonitorPluginApi> | null = null;
  private loading: Promise<void> | null = null;
  // Which plugin_paths folder each folder plugin came from, by its plugin id.
  private readonly origins = new Map<string, PluginPath>();

  constructor(paths: PluginPath[] = [], builtins: Record<string, () => Promise<PluginClass>> = builtin_monitor_types) {
    this.paths = [...paths];
    this.builtins = builtins;
  }

  // The Plugin class for a monitor type, rejecting with the reason when there is none.
  async resolve(name: unknown): Promise<PluginClass> {
    const key = String(name ?? "");
    const cached = this.classes.get(key);
    if (cached !== undefined) return cached;
    if (!name || !identifier.test(key)) throw new Error(`plugin type ${python_repr(name ?? null)} is not a valid module name`);
    const cls = await this.load(key);
    this.classes.set(key, cls);
    return cls;
  }

  private async load(name: string): Promise<PluginClass> {
    const external = await this.find_external(name);
    const builtin = Object.hasOwn(this.builtins, name);
    if (external !== null && builtin) {
      const [path, cls, plugin_id] = external;
      if (path.override) {
        log.warn(`plugin type ${python_repr(name)}: ${plugin_id} in ${path.directory} overrides X-Monitor's built-in plugin`);
        return cls;
      }
      log.warn(`plugin type ${python_repr(name)}: ${plugin_id} in ${path.directory} is shadowed by X-Monitor's built-in plugin and ignored; give its plugin_paths entry \`override: true\` to use it instead`);
    }
    if (builtin) return this.builtins[name]();
    if (external !== null) return external[1];
    const searched = this.paths.map((path) => path.directory).join(", ") || "none configured";
    throw new Error(`no plugin type ${python_repr(name)}: it is not one of X-Monitor's plugins and is not in plugin_paths (${searched})`);
  }

  // The first folder, in plugin_paths order, whose plugins provide this type.
  private async find_external(name: string): Promise<[PluginPath, PluginClass, string] | null> {
    if (this.paths.length === 0) return null;
    await this.load_folders();
    const provided = this.host!.providers("monitor_type").filter((each) => each.id === name);
    for (const path of this.paths) {
      const found = provided.find((each) => this.origins.get(each.plugin_id) === path);
      if (found === undefined) continue;
      if (typeof found.value !== "function") throw new Error(`plugin type ${python_repr(name)} from ${path.directory} is not a monitor class`);
      return [path, found.value, found.plugin_id];
    }
    return null;
  }

  // Imports every folder plugin once per loader, fresh, so a reload's new loader picks up an edited file.
  private load_folders(): Promise<void> {
    this.loading ??= (async () => {
      const host = create_plugin_host<MonitorPluginApi>({
        app: { id: "x-monitor", version: app_version() },
        on_error: (plugin_id, error) => log.error(`plugin ${plugin_id} failed: ${(error as Error)?.message ?? String(error)}`),
      });
      const fresh = Date.now();
      for (const path of this.paths) {
        const { entries, problems } = plugin_entries(path.directory, PLUGIN_SIDE);
        for (const problem of problems) log.warn(`plugin_paths: ${path.directory}/${problem.name}: ${problem.problem}`);
        for (const entry of entries) {
          try {
            if (!existsSync(entry.file)) throw new Error(`Its ${PLUGIN_SIDE} entry is missing.`);
            const module = (await import(`${pathToFileURL(entry.file).href}?loaded=${fresh}`)) as { default?: HostPlugin<MonitorPluginApi>; plugin?: HostPlugin<MonitorPluginApi> };
            const plugin = module.default ?? module.plugin;
            if (!plugin || typeof plugin.start !== "function") throw new Error(`Its ${PLUGIN_SIDE} entry exports no plugin.`);
            if (!this.origins.has(plugin.id)) this.origins.set(plugin.id, path);
            await host.add(plugin);
          } catch (error) {
            log.warn(`plugin_paths: ${path.directory}/${entry.name} failed to load: ${(error as Error).message}`);
          }
        }
      }
      await host.start();
      for (const status of host.list()) {
        if (status.state !== "running" && status.state !== "off") log.warn(`plugin ${status.manifest.id} is ${status.state}: ${status.problem ?? ""}`);
      }
      this.host = host;
    })();
    return this.loading;
  }

  // Stops the folder plugins this loader started.
  async close(): Promise<void> {
    await this.host?.stop();
  }
}
