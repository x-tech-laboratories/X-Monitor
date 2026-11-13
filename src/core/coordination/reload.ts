// The pure half of a config reload: what a reload did, which settings need a restart, and how monitors compare.

import { deep_equal } from "../python.ts";

// Settings read once at startup, as [section, key]; a null key compares the whole section.
const restart_settings: [string, string | null][] = [
  ["database", "path"],
  ["database", "write_batch_seconds"],
  ["memory", null],
  ["auth", null],
  ["theme", null],
];

export interface ReloadDict {
  ok: boolean;
  source: string;
  added: string[];
  removed: string[];
  changed: string[];
  restart_required: string[];
  error: string | null;
  summary: string;
}

// The outcome of one reload: the monitor ids it touched, or why it was refused.
export class ReloadResult {
  readonly source: string;
  ok = true;
  added: string[] = [];
  removed: string[] = [];
  changed: string[] = [];
  restart_required: string[] = [];
  error: string | null = null;

  constructor(source: string) {
    this.source = source;
  }

  summary(): string {
    if (!this.ok) return `Config reload (${this.source}) failed, still running the previous config: ${this.error}`;
    let text = `Config reloaded (${this.source}): ${this.added.length} added, ${this.removed.length} removed, ${this.changed.length} changed`;
    if (this.restart_required.length > 0) text += `; restart required for: ${this.restart_required.join(", ")}`;
    return text;
  }

  as_dict(): ReloadDict {
    return {
      ok: this.ok, source: this.source, added: this.added, removed: this.removed, changed: this.changed,
      restart_required: this.restart_required, error: this.error, summary: this.summary(),
    };
  }
}

type Config = Record<string, unknown>;

function setting(config: Config, section: string, key: string | null): unknown {
  const value = config[section] || {};
  if (key === null) return value;
  return typeof value === "object" && !Array.isArray(value) ? (value as Config)[key] : null;
}

// The startup-only settings that differ between two configs, named as section or section.key.
export function restart_required(old: Config, next: Config, db_path_overridden = false): string[] {
  const names: string[] = [];
  for (const [section, key] of restart_settings) {
    if (db_path_overridden && section === "database" && key === "path") continue;
    if (!deep_equal(setting(old, section, key) ?? null, setting(next, section, key) ?? null)) names.push(key === null ? section : `${section}.${key}`);
  }
  return names;
}

// Whether any of these top-level sections differ between two configs.
export function section_changed(old: Config, next: Config, ...keys: string[]): boolean {
  return keys.some((key) => !deep_equal(old[key] ?? null, next[key] ?? null));
}

// A monitor's own config, without its children, which decides with its class whether it is unchanged.
export function own_config(config: Config): Config {
  return Object.fromEntries(Object.entries(config).filter(([key]) => key !== "children"));
}

// Whether a running monitor already matches this config and class, so a reload can keep it as it is.
export function same_monitor(existing: { config: Config; constructor: unknown }, config: Config, cls: unknown): boolean {
  return existing.constructor === cls && deep_equal(own_config(existing.config), own_config(config));
}
