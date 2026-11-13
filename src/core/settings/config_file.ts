// Loads config.yaml into the XMonitorConfig tree and reads each setting with its default. JSON is valid YAML, so a
// config.json loads the same way. The file is read as YAML 1.1, as the Python app's PyYAML read it, so `yes` is still
// true and a repeated key still takes its last value.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { parse as parse_yaml } from "yaml";

import { python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { create_logger_for } from "../logging.ts";
import { close_matches, python_float, python_int, python_type_name } from "../python.ts";
import { default_buffer_sizes, type BufferSizes } from "../state/store.ts";
import type {
  AgentSettings, AuthSettings, DatabaseSettings, ExporterSettings, NotificationSettings, PluginConfig, SSHConfig, ThemeSettings, XMonitorConfig,
} from "./config_schema.ts";

const log = create_logger_for("x_monitor.core.settings.config_file");

// ── Structure warnings ───────────────────────────────────────────────────────

// The shape each top-level section must have, so a section written as the wrong kind of YAML is named at startup.
const section_shapes: Record<string, "list" | "dict"> = {
  agents: "list",
  plugins: "list",
  notifications: "dict",
  control: "list",
  database: "dict",
  theme: "dict",
  exporters: "dict",
  logging: "dict",
  memory: "dict",
  ssh_defaults: "dict",
  auth: "dict",
  plugin_paths: "list",
};

export function is_mapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function has_shape(value: unknown, shape: "list" | "dict"): boolean {
  return shape === "list" ? Array.isArray(value) : is_mapping(value);
}

// Logs one actionable warning per structural mistake; nothing here rejects a file or changes what loads.
function warn_on_structure(data: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(data)) {
    const expected = section_shapes[key];
    if (expected === undefined) {
      const near = close_matches(key, Object.keys(section_shapes), 1);
      const hint = near.length > 0 ? ` — did you mean '${near[0]}'?` : "";
      log.warn(`${path}: unknown top-level section '${key}', ignored${hint}`);
    } else if (!has_shape(value, expected)) {
      const wanted = expected === "list" ? "a list" : "a mapping";
      log.warn(`${path}: section '${key}' should be ${wanted}, got ${python_type_name(value)} — it will be ignored or fail when read`);
    }
  }
  for (const section of ["plugins", "agents"]) {
    const entries = data[section];
    if (!Array.isArray(entries)) continue;
    const required = section === "plugins" ? "type" : "id";
    entries.forEach((entry: unknown, index) => {
      const position = index + 1;
      if (!is_mapping(entry)) {
        log.warn(`${path}: ${section} entry ${position} should be a mapping, got ${python_type_name(entry)}`);
      } else if (!entry[required] && !(section === "plugins" && entry.ref)) {
        const label = entry.name || `entry ${position}`;
        log.warn(`${path}: ${section} ${String(label)} has no '${required}' and cannot load`);
      }
    });
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

// The configuration could not be read.
export class ConfigError extends Error {
  override name = "ConfigError";
}

// Reads YAML text as PyYAML's safe_load did, throwing on a syntax error.
export function load_yaml(text: string): unknown {
  return parse_yaml(text, { version: "1.1", uniqueKeys: false, maxAliasCount: -1 });
}

function get<Value>(data: Record<string, unknown>, key: string, fallback: Value): Value {
  return (Object.hasOwn(data, key) ? data[key] : fallback) as Value;
}

// One reading of config.yaml; strict throws ConfigError where the lenient startup read falls back to an empty config.
export class ConfigFileManager {
  static readonly DEFAULT_WRITE_BATCH_SECONDS = 1.0;
  static readonly DEFAULT_LOG_RETENTION_DAYS = 30;

  readonly path: string;
  readonly strict: boolean;
  // A hash of the bytes read, so a watcher can tell a real edit from a touch.
  digest: string | null = null;
  readonly data: XMonitorConfig;

  constructor(config_path: string, strict = false) {
    this.path = config_path;
    this.strict = strict;
    this.data = this.load();
  }

  private fail(message: string): XMonitorConfig {
    if (this.strict) throw new ConfigError(message);
    log.error(message);
    return {};
  }

  private load(): XMonitorConfig {
    if (!existsSync(this.path)) {
      if (this.strict) throw new ConfigError(`Configuration file not found at ${this.path}`);
      log.warn(`Configuration file not found at ${this.path}. Using empty configuration defaults.`);
      return {};
    }
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch (error) {
      return this.fail(`Failed to read configuration at ${this.path}: ${(error as Error).message}`);
    }
    this.digest = createHash("sha256").update(raw).digest("hex");
    let data: unknown;
    try {
      data = load_yaml(raw.toString("utf8"));
    } catch (error) {
      return this.fail(`Failed to parse YAML configuration at ${this.path}: ${(error as Error).message}`);
    }
    if (!is_mapping(data)) {
      if (this.strict) throw new ConfigError(`${this.path} is empty or not a mapping of sections`);
      return {};
    }
    warn_on_structure(data, this.path);
    return data as XMonitorConfig;
  }

  // ── Database ───────────────────────────────────────────────────────────

  get database_settings(): DatabaseSettings {
    return get(this.data, "database", { path: "x-monitor.db" });
  }

  get write_batch_seconds(): number {
    const value = get<unknown>(this.database_settings ?? {}, "write_batch_seconds", ConfigFileManager.DEFAULT_WRITE_BATCH_SECONDS);
    try {
      return python_float(value);
    } catch {
      log.warn(`Invalid database.write_batch_seconds=${python_repr(value)}; falling back to ${python_float_text(ConfigFileManager.DEFAULT_WRITE_BATCH_SECONDS)}`);
      return ConfigFileManager.DEFAULT_WRITE_BATCH_SECONDS;
    }
  }

  // ── Sections ───────────────────────────────────────────────────────────

  get plugins(): PluginConfig[] {
    return get(this.data, "plugins", []);
  }

  // The `agents:` list: each agent that may dial in, with its `id` and the `public_key` its login is checked against.
  get agents(): AgentSettings[] {
    return get(this.data, "agents", []);
  }

  get notifications(): NotificationSettings {
    return this.data.notifications || {};
  }

  get theme_settings(): ThemeSettings {
    return get(this.data, "theme", {});
  }

  get exporters(): ExporterSettings {
    return get(this.data, "exporters", {});
  }

  get ssh_defaults(): SSHConfig {
    return get(this.data, "ssh_defaults", {});
  }

  // Folders searched for monitor types X-Monitor does not ship, each a path or a mapping with `path` and `override`.
  get plugin_paths(): unknown[] {
    const value = this.data.plugin_paths || [];
    return Array.isArray(value) ? value : [];
  }

  get controllers(): Record<string, unknown>[] {
    return get(this.data, "control", []);
  }

  get auth_settings(): AuthSettings {
    return get(this.data, "auth", {});
  }

  // ── Logging ────────────────────────────────────────────────────────────

  get logging_settings(): Record<string, unknown> {
    return get(this.data, "logging", {});
  }

  get log_retention_days(): number {
    const value = get<unknown>(this.logging_settings, "retention_days", ConfigFileManager.DEFAULT_LOG_RETENTION_DAYS);
    try {
      return python_int(value);
    } catch {
      log.warn(`Invalid logging.retention_days=${python_repr(value)}; falling back to ${ConfigFileManager.DEFAULT_LOG_RETENTION_DAYS}`);
      return ConfigFileManager.DEFAULT_LOG_RETENTION_DAYS;
    }
  }

  // How long metric and status rows are kept; it follows log retention when unset, and 0 keeps them forever.
  get metric_retention_days(): number {
    const value = this.logging_settings.metric_retention_days;
    if (value === null || value === undefined) return this.log_retention_days;
    try {
      return python_int(value);
    } catch {
      log.warn(`Invalid logging.metric_retention_days=${python_repr(value)}; falling back to log retention (${this.log_retention_days}d)`);
      return this.log_retention_days;
    }
  }

  // The age past which metrics thin to one row per series per hour; 0, the default, turns downsampling off.
  get metric_downsample_days(): number {
    const value = get<unknown>(this.logging_settings, "metric_downsample_days", 0);
    try {
      return python_int(value);
    } catch {
      log.warn(`Invalid logging.metric_downsample_days=${python_repr(value)}; disabling downsampling`);
      return 0;
    }
  }

  // Whether the engine records the cycle timing metrics, which double the metric row count.
  get cycle_timings(): boolean {
    return Boolean(get(this.logging_settings, "cycle_timings", true));
  }

  // The root level from `logging.level`, or null to keep the command line's default.
  get log_level(): string | null {
    const value = this.logging_settings.level;
    return value ? String(value) : null;
  }

  // Per-logger levels from `logging.levels`, by logger name.
  get log_levels(): Record<string, string> {
    const value = this.logging_settings.levels || {};
    if (!is_mapping(value)) {
      log.warn(`logging.levels should be a mapping of logger name to level, got ${python_type_name(value)}`);
      return {};
    }
    return Object.fromEntries(Object.entries(value).map(([key, level]) => [key, String(level)]));
  }

  // ── Memory ─────────────────────────────────────────────────────────────

  get memory_settings(): Record<string, unknown> {
    return get(this.data, "memory", {});
  }

  // How much history the store keeps per stream; an unset or unreadable value keeps its default.
  get buffer_sizes(): BufferSizes {
    const configured = this.memory_settings;
    const values: Partial<BufferSizes> = {};
    for (const field of ["metric_history", "event_history", "log_history", "job_output", "jobs_per_plugin", "finished_job_output"] as const) {
      const raw = configured[field];
      if (raw === null || raw === undefined) continue;
      let parsed: number;
      try {
        parsed = python_int(raw);
      } catch {
        log.warn(`Invalid memory.${field}=${python_repr(raw)}; falling back to ${default_buffer_sizes[field]}`);
        continue;
      }
      if (parsed <= 0) {
        log.warn(`memory.${field} must be positive (got ${parsed}); falling back to ${default_buffer_sizes[field]}`);
        continue;
      }
      values[field] = parsed;
    }
    return { ...default_buffer_sizes, ...values };
  }
}

// A float as Python's str() writes it, so 1.0 stays "1.0".
function python_float_text(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
