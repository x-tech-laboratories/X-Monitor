// The named formatters, color rules and predicates a UI_SPEC may refer to, with the shared ones every monitor can use.
// A monitor registers a name of its own only to publish a rule other monitors may reuse.

import type { Status } from "./status.ts";
import type { ColorRule, EnabledPredicate, Formatter, ItemColorRule, ItemFormatter, RuleRef } from "./ui_spec.ts";

// ── Registries ───────────────────────────────────────────────────────────────

export const FORMATTERS: Record<string, Formatter> = {};
export const COLOR_RULES: Record<string, ColorRule> = {};
export const ITEM_FORMATTERS: Record<string, ItemFormatter> = {};
export const ITEM_COLOR_RULES: Record<string, ItemColorRule> = {};
export const ENABLED_PREDICATES: Record<string, EnabledPredicate> = {};

export function register_formatter(name: string, rule: Formatter): Formatter {
  FORMATTERS[name] = rule;
  return rule;
}

export function register_color_rule(name: string, rule: ColorRule): ColorRule {
  COLOR_RULES[name] = rule;
  return rule;
}

export function register_item_formatter(name: string, rule: ItemFormatter): ItemFormatter {
  ITEM_FORMATTERS[name] = rule;
  return rule;
}

export function register_item_color_rule(name: string, rule: ItemColorRule): ItemColorRule {
  ITEM_COLOR_RULES[name] = rule;
  return rule;
}

export function register_enabled_predicate(name: string, rule: EnabledPredicate): EnabledPredicate {
  ENABLED_PREDICATES[name] = rule;
  return rule;
}

// The function a spec entry names or holds; with `required`, an unknown name throws.
export function resolve<Rule>(registry: Record<string, Rule>, ref: RuleRef<Rule> | null | undefined, required = false): Rule | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref !== "string") return ref;
  const rule = Object.hasOwn(registry, ref) ? registry[ref] : undefined;
  if (required && rule === undefined) throw new Error(`unknown spec function '${ref}'`);
  return rule ?? null;
}

// ── Number text ──────────────────────────────────────────────────────────────

// Fixed decimals as Python's format spec writes them, with "," grouping when asked.
export function fixed(value: number, decimals: number, grouped = false): string {
  if (!grouped) return value.toFixed(decimals);
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true });
}

// A size read in `unit` as MB, GB or TB, as format_bytes in the monitors' helpers writes it.
export function format_bytes(value: number, unit: "B" | "KB" | "MB" | "GB" | "TB" = "GB"): string {
  const in_gb: Record<string, number> = { B: 1024 ** -3, KB: 1024 ** -2, MB: 1024 ** -1, GB: 1, TB: 1024 };
  if (!Object.hasOwn(in_gb, unit)) throw new Error(`unknown size unit '${unit}', expected one of B, GB, KB, MB, TB`);
  const gb = value * in_gb[unit];
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(gb * 1024).toFixed(0)} MB`;
}

// ── Shared formatters ────────────────────────────────────────────────────────

function dash_or(empty: string, write: (value: number) => string): Formatter {
  return (value) => (value === null || value === undefined ? empty : write(value));
}

register_formatter("int", dash_or("--", (value) => String(Math.trunc(value))));
register_formatter("int_rounded", dash_or("--", (value) => fixed(value, 0)));
register_formatter("count_comma", dash_or("--", (value) => fixed(Math.trunc(value), 0, true)));
register_formatter("count_comma_rounded", dash_or("--", (value) => fixed(value, 0, true)));
register_formatter("decimal1", dash_or("--", (value) => fixed(value, 1)));
register_formatter("percent0", dash_or("-- %", (value) => `${fixed(value, 0)}%`));
register_formatter("percent0_plain_dash", dash_or("--", (value) => `${fixed(value, 0)}%`));
register_formatter("percent1", dash_or("-- %", (value) => `${fixed(value, 1)}%`));
register_formatter("percent1_plain_dash", dash_or("--", (value) => `${fixed(value, 1)}%`));
register_formatter("ms0", dash_or("--", (value) => `${fixed(value, 0)} ms`));
register_formatter("ms1", dash_or("--", (value) => `${fixed(value, 1)} ms`));
register_formatter("seconds_ms", dash_or("-- ms", (value) => `${fixed(value, 1)} ms`));
register_formatter("temp_c0", dash_or("--", (value) => `${fixed(value, 0)}°C`));
register_formatter("temp_c1", dash_or("--", (value) => `${fixed(value, 1)}°C`));
register_formatter("bytes_gb", dash_or("--", (value) => format_bytes(value)));
register_formatter("kbps_rate", dash_or("-- KB/s", (value) => (value >= 1024 ? `${fixed(value / 1024, 1)} MB/s` : `${fixed(value, 1)} KB/s`)));
register_formatter("dbm0", dash_or("-- dBm", (value) => `${fixed(value, 0)} dBm`));
register_formatter("dedup_ratio", dash_or("--", (value) => `${fixed(value, 1)}x`));
register_formatter("ttl_seconds", dash_or("--", (value) => `${Math.trunc(value)}s`));

// ── Shared color rules ───────────────────────────────────────────────────────

register_color_rule("nonzero_warning", (value) => (value === null ? null : value > 0 ? "warning" : "online"));
register_color_rule("always_online", (value) => (value === null ? null : "online"));
register_color_rule("nonzero_failed", (value) => (value === null ? null : value > 0 ? "failed" : "online"));
// For a 1/0 verdict: anything non-zero passed, zero failed.
register_color_rule("zero_failed", (value) => (value === null ? null : value ? "online" : "failed"));

// A color rule mapping a value onto status colors by two limits, either of which may be off.
export function threshold_color(warning: number | null, threshold: number | null): ColorRule {
  return (value): Status | null => {
    if (value === null) return null;
    if (threshold !== null && value >= threshold) return "failed";
    if (warning !== null && value >= warning) return "warning";
    return "online";
  };
}
