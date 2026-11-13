// Run-time control of log verbosity, for the whole process or one named logger, on the levels in core/logging.ts.

import {
  create_logger_for, is_level_name, known_logger_names, own_log_level, root_log_level, set_own_log_level, set_root_log_level, type LevelName,
} from "../logging.ts";

// The levels an operator may pick, most verbose first.
export const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;

// The name that stands for the root logger, which every unconfigured logger inherits from.
export const ROOT = "root";

const announce_name = "x_monitor.log_levels";
// Its own explicit level keeps every change visible however quiet the rest of logging is set.
set_own_log_level(announce_name, "WARNING");
const announce = create_logger_for(announce_name);

// The canonical name of a level, throwing for one X-Monitor does not offer.
export function normalize_level(level: unknown): LevelName {
  const name = String(level).trim().toUpperCase();
  if (!is_level_name(name)) throw new Error(`unknown log level '${String(level)}'; use one of ${LEVELS.join(", ")}`);
  return name;
}

function current_level(name: string): LevelName | null {
  return name === "" || name === ROOT ? root_log_level() : own_log_level(name);
}

// The process's log levels: set from config at startup and on reload, and changed by hand at run time.
export class LogLevels {
  private readonly baseline: LevelName;
  private readonly named = new Set<string>();
  private from_config = new Set<string>();

  constructor() {
    this.baseline = root_log_level();
  }

  // Applies `logging.level` and `logging.levels`, undoing what a previous config set and this one drops.
  configure(level: string | null, levels: Record<string, string>): void {
    const wanted: Record<string, string> = { [ROOT]: level || this.baseline, ...levels };
    for (const name of [...this.from_config].filter((each) => !Object.hasOwn(levels, each)).sort()) {
      this.set_level(name, null, "config");
    }
    for (const [name, value] of Object.entries(wanted)) {
      // A bad entry is reported and skipped so the rest still apply.
      try {
        if (current_level(name) !== normalize_level(value)) this.set_level(name, value, "config");
      } catch (error) {
        announce.warn(`logging.levels: ${name}: ${(error as Error).message}`);
      }
    }
    this.from_config = new Set(Object.keys(levels).filter((name) => name !== ROOT));
  }

  // Sets one logger's level, or with no level returns a named logger to inheriting; returns the new levels.
  set_level(name: string | null, level: string | null, source = "runtime"): Record<string, string> {
    const logger = (name || ROOT).trim() || ROOT;
    if ((level === null || level === "") && logger === ROOT) throw new Error("the root logger always has a level");
    const next = level === null || level === "" ? null : normalize_level(level);
    const old = current_level(logger) ?? "inherited";
    if (logger === ROOT) {
      set_root_log_level(next!);
    } else {
      set_own_log_level(logger, next);
      if (next === null) this.named.delete(logger);
      else this.named.add(logger);
    }
    announce.warn(`Log level for ${logger} changed from ${old} to ${next ?? "inherited"} (${source})`);
    return this.levels();
  }

  // Moves the root level one step more or less verbose, stopping at either end; returns the new level.
  step(more_verbose: boolean, source: string): LevelName {
    const current = root_log_level();
    let index = LEVELS.indexOf(current);
    index = more_verbose ? Math.max(0, index - 1) : Math.min(LEVELS.length - 1, index + 1);
    if (LEVELS[index] !== current) this.set_level(ROOT, LEVELS[index], source);
    return LEVELS[index];
  }

  // The root level plus every logger given a level of its own.
  levels(): Record<string, string> {
    const out: Record<string, string> = { [ROOT]: root_log_level() };
    for (const name of [...this.named].sort()) out[name] = own_log_level(name) ?? root_log_level();
    return out;
  }

  // Every X-Monitor logger made so far, for picking one to change.
  static known_loggers(): string[] {
    return known_logger_names().filter((name) => name === "x_monitor" || name.startsWith("x_monitor."));
  }
}
