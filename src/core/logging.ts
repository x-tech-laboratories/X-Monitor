// Loggers named by module path, such as "x_monitor.core.connectors.ssh_connector", whose levels change at run time.
// A logger without a level of its own takes its nearest dotted parent's, then the root's, as Python's logging does.

import { create_logger, format_record, type Level, type Logger, type LogRecord } from "@x-tech-laboratories/x-libs/log";

// ── Levels ───────────────────────────────────────────────────────────────────

// The level names the config and the API use.
export const level_names = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;
export type LevelName = (typeof level_names)[number];

const to_level: Record<LevelName, Level> = { DEBUG: "debug", INFO: "info", WARNING: "warn", ERROR: "error", CRITICAL: "critical" };

export function is_level_name(value: unknown): value is LevelName {
  return typeof value === "string" && Object.hasOwn(to_level, value);
}

let root_level: LevelName = "INFO";
const own_levels = new Map<string, LevelName>();
const known = new Set<string>();

export function root_log_level(): LevelName {
  return root_level;
}

export function set_root_log_level(level: LevelName): void {
  root_level = level;
}

// The level set on this logger itself, or null when it inherits.
export function own_log_level(name: string): LevelName | null {
  return own_levels.get(name) ?? null;
}

export function set_own_log_level(name: string, level: LevelName | null): void {
  if (level === null) own_levels.delete(name);
  else own_levels.set(name, level);
}

export function own_log_levels(): Map<string, LevelName> {
  return new Map(own_levels);
}

// The level a logger writes at: its own, its nearest parent's, or the root's.
export function effective_log_level(name: string): LevelName {
  for (let scope = name; scope !== ""; scope = scope.includes(".") ? scope.slice(0, scope.lastIndexOf(".")) : "") {
    const level = own_levels.get(scope);
    if (level !== undefined) return level;
  }
  return root_level;
}

// Every logger made so far, by name.
export function known_logger_names(): string[] {
  return [...known].sort();
}

// ── Sink ─────────────────────────────────────────────────────────────────────

let sink: (record: LogRecord) => void = (record) => process.stderr.write(`${format_record(record)}\n`);

// Sends every record somewhere else, as a test does to read what was logged.
export function set_log_sink(next: (record: LogRecord) => void): void {
  sink = next;
}

// ── Loggers ──────────────────────────────────────────────────────────────────

export function create_logger_for(name: string): Logger {
  known.add(name);
  return create_logger(name, () => ({ default: to_level[effective_log_level(name)], scopes: {} }), (record) => sink(record));
}
