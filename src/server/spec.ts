// A monitor's page as data: its declarative UI_SPEC made safe to send, with every rule it holds as a function either
// named by its registered name or worked out here, and everything the spec's widgets read, in one answer the page
// draws from and asks for again after each change.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonValue } from "./json.ts";
import { COLOR_RULES, ENABLED_PREDICATES, FORMATTERS, ITEM_COLOR_RULES, ITEM_FORMATTERS } from "../shared/ui_registry.ts";
import type { ServerPlugin } from "./engine_api.ts";

// ── Rules ────────────────────────────────────────────────────────────────────

// Which registry each function-valued key draws from, and what the rule is applied to.
const rule_keys: Record<string, { registry: Record<string, unknown>; applies_to: "value" | "values" | "item" | "plugin" }> = {
  format: { registry: FORMATTERS, applies_to: "value" },
  color: { registry: COLOR_RULES, applies_to: "value" },
  format_fn: { registry: ITEM_FORMATTERS, applies_to: "values" },
  color_fn: { registry: ITEM_COLOR_RULES, applies_to: "values" },
  item_format: { registry: FORMATTERS, applies_to: "item" },
  item_format_fn: { registry: ITEM_FORMATTERS, applies_to: "item" },
  item_color_by: { registry: ITEM_COLOR_RULES, applies_to: "item" },
  cell_color_by: { registry: ITEM_COLOR_RULES, applies_to: "item" },
  visible_if: { registry: ENABLED_PREDICATES, applies_to: "plugin" },
  enabled_if: { registry: ENABLED_PREDICATES, applies_to: "plugin" },
};

// A rule only the server can run, which the spec names as `{ server_rule: id }`.
interface ServerRule {
  id: string;
  key: string;
  applies_to: "value" | "values" | "item" | "plugin";
  rule: (input: never) => unknown;
  // The card it sits in, for a rule over its metric or metrics.
  card: Record<string, unknown> | null;
  // For an item formatter, the repeat's value field it formats.
  item_value: string | null;
}

export interface ResolvedSpec {
  spec: JsonValue;
  rules: ServerRule[];
}

function name_of(registry: Record<string, unknown>, rule: unknown): string | null {
  return Object.entries(registry).find(([, registered]) => registered === rule)?.[0] ?? null;
}

// The spec with each function replaced by its registered name, or by a server rule; predicates always run here.
export function resolve_spec(spec: unknown): ResolvedSpec {
  const rules: ServerRule[] = [];
  const walk = (value: unknown, card: Record<string, unknown> | null, repeat: Record<string, unknown> | null): JsonValue => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, card, repeat));
    if (typeof value !== "object" || value === null) return typeof value === "function" ? null : (value as JsonValue);
    const source = value as Record<string, unknown>;
    const here_card = "metric" in source || "metrics" in source ? source : card;
    const here_repeat = "item_value" in source || "source" in source ? source : repeat;
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(source)) {
      const known = rule_keys[key];
      if (typeof entry === "function" || (known?.applies_to === "plugin" && typeof entry === "string")) {
        const registered = known && typeof entry === "function" ? name_of(known.registry, entry) : null;
        if (registered !== null && known!.applies_to !== "plugin") {
          out[key] = registered;
          continue;
        }
        const rule = (typeof entry === "string" ? known?.registry[entry] : entry) as ServerRule["rule"] | undefined;
        if (!known || !rule) {
          out[key] = null;
          continue;
        }
        const id = `rule${rules.length}`;
        rules.push({ id, key, applies_to: known.applies_to, rule, card: here_card, item_value: (here_repeat?.item_value as string | undefined) ?? null });
        out[key] = { server_rule: id };
        continue;
      }
      out[key] = walk(entry, here_card, key === "repeat" ? (entry as Record<string, unknown>) : here_repeat);
    }
    return out;
  };
  return { spec: walk(spec, null, null), rules };
}

// ── Reading the plugin ───────────────────────────────────────────────────────

// Every plugin attribute a spec names through a key ending in `_attr`, such as a table's rows or a select's options.
export function attribute_names(spec: unknown): string[] {
  const names = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (key.endsWith("_attr") && typeof entry === "string") names.add(entry);
        else walk(entry);
      }
    }
  };
  walk(spec);
  return [...names];
}

// A plugin attribute as JSON, calling it when it is a method.
export function read_attribute(plugin: ServerPlugin, name: string): JsonValue {
  const value = (plugin as Record<string, unknown>)[name];
  const read = typeof value === "function" ? (value as () => unknown).call(plugin) : value;
  return to_json(read);
}

export function to_json(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) return [...value].map(to_json);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, entry]) => [String(key), to_json(entry)]));
  if (Array.isArray(value)) return value.map(to_json);
  if (typeof value === "function") return null;
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, to_json(entry)]));
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value as JsonValue;
}

// ── Running the server's rules ───────────────────────────────────────────────

// Each server rule's answer: a predicate's over the plugin, a card rule's over its metric or metrics.
export function run_rules(rules: ServerRule[], plugin: ServerPlugin, latest: (name: string) => number | null): Record<string, JsonValue> {
  const results: Record<string, JsonValue> = {};
  for (const rule of rules) {
    try {
      if (rule.applies_to === "plugin") results[rule.id] = Boolean((rule.rule as (plugin: unknown) => boolean)(plugin));
      else if (rule.applies_to === "value" && typeof rule.card?.metric === "string") results[rule.id] = to_json((rule.rule as (value: number | null) => unknown)(latest(rule.card.metric)));
      else if (rule.applies_to === "values" && Array.isArray(rule.card?.metrics)) {
        const values = Object.fromEntries((rule.card.metrics as string[]).map((name) => [name, latest(name)]));
        results[rule.id] = to_json((rule.rule as (values: unknown) => unknown)(values));
      }
    } catch {
      results[rule.id] = null;
    }
  }
  return results;
}

// The item rules' answers added to each item as `__rules`, so a table or repeat colors and formats its rows.
export function with_item_rules(items: unknown, rules: ServerRule[]): unknown {
  const item_rules = rules.filter((rule) => rule.applies_to === "item");
  if (item_rules.length === 0 || !Array.isArray(items)) return items;
  return items.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const record = item as Record<string, unknown>;
    const answers: Record<string, JsonValue> = {};
    for (const rule of item_rules) {
      try {
        answers[rule.id] = rule.key === "item_format"
          ? to_json((rule.rule as (value: unknown) => unknown)(rule.item_value ? record[rule.item_value] : null))
          : to_json((rule.rule as (item: unknown) => unknown)(record));
      } catch {
        answers[rule.id] = null;
      }
    }
    return { ...record, __rules: answers };
  });
}

// ── What the widgets read ────────────────────────────────────────────────────

// The metric names the spec's cards and single-metric charts read, as the page model tracks them.
export function metric_names(spec: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const card of Object.values((spec.cards as Record<string, Record<string, unknown>>) ?? {})) {
    if (typeof card.metric === "string") names.add(card.metric);
    for (const name of (card.metrics as string[] | undefined) ?? []) names.add(name);
    for (const part of (card.parts as { metric?: string }[] | undefined) ?? []) if (part.metric) names.add(part.metric);
  }
  for (const chart of [spec.chart, ...Object.values((spec.charts as Record<string, unknown>) ?? {})]) {
    const metric = (chart as { metric?: string } | undefined)?.metric;
    if (metric) names.add(metric);
  }
  return [...names];
}

// The histories the charts and strips draw, as `[metric, limit]` pairs.
export function history_requests(spec: Record<string, unknown>, default_limit = 30, strip_cells = 60): [string, number][] {
  const wanted = new Map<string, number>();
  const want = (metric: string | undefined, limit: number) => {
    if (metric) wanted.set(metric, Math.max(wanted.get(metric) ?? 0, limit));
  };
  for (const chart of [spec.chart, ...Object.values((spec.charts as Record<string, unknown>) ?? {})]) {
    const chart_spec = chart as { metric?: string; series?: { metric?: string }[]; limit?: number } | undefined;
    if (!chart_spec) continue;
    want(chart_spec.metric, chart_spec.limit ?? default_limit);
    for (const series of chart_spec.series ?? []) want(series.metric, chart_spec.limit ?? default_limit);
  }
  for (const card of Object.values((spec.cards as Record<string, Record<string, unknown>>) ?? {})) {
    if (card.kind !== "strip") continue;
    const cells = Number(card.cells ?? strip_cells);
    const rows = (card.rows as { metric?: string }[] | undefined) ?? [{ metric: card.metric as string | undefined }];
    for (const row of rows) want(row.metric, cells);
  }
  return [...wanted];
}
