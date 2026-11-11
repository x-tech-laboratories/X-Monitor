// Metric families: the metrics a monitor records one per dynamic item, such as folder_<name>_gb or fs_<name>_used_pct,
// found by name prefix and suffix. Monitors count them and the page's repeat cards draw one item per key, so both read
// the same pure scan over a monitor's latest metrics.

import type { MetricFieldSpec } from "../../shared/ui_spec.ts";

// The part of a metric record a scan reads.
export interface NamedValue {
  readonly metric_name: string;
  readonly value: number;
}

// Each matching metric's latest value under its name with the prefix and suffix taken off, in the order given.
export function scan_metric_family(records: Iterable<NamedValue>, prefix: string, suffix: string, exclude: ReadonlySet<string> = new Set()): Map<string, number> {
  const latest = new Map<string, number>();
  for (const record of records) {
    const name = record.metric_name;
    if (exclude.has(name)) continue;
    if (prefix && !name.startsWith(prefix)) continue;
    if (suffix && !name.endsWith(suffix)) continue;
    let key = name;
    if (prefix) key = key.slice(prefix.length);
    if (suffix && key.endsWith(suffix)) key = key.slice(0, key.length - suffix.length);
    latest.set(key, record.value);
  }
  return latest;
}

// One repeat-card item per key, sorted by key: with `fields`, several families merged into {key, <field name>: value},
// else the single prefix and suffix pair as {key, value}.
export function metric_family_items(records: readonly NamedValue[], spec: { metrics_prefix?: string; metrics_suffix?: string; metrics_exclude?: readonly string[]; fields?: readonly MetricFieldSpec[] }): Record<string, unknown>[] {
  const exclude = new Set(spec.metrics_exclude ?? []);
  let items: Record<string, unknown>[];
  if (spec.fields && spec.fields.length > 0) {
    const merged = new Map<string, Record<string, unknown>>();
    for (const field of spec.fields) {
      for (const [key, value] of scan_metric_family(records, field.prefix ?? "", field.suffix ?? "", exclude)) {
        if (!merged.has(key)) merged.set(key, { key });
        merged.get(key)![field.name] = value;
      }
    }
    items = [...merged.values()];
  } else {
    items = [...scan_metric_family(records, spec.metrics_prefix ?? "", spec.metrics_suffix ?? "", exclude)].map(([key, value]) => ({ key, value }));
  }
  return items.sort((first, second) => (String(first.key) < String(second.key) ? -1 : String(first.key) > String(second.key) ? 1 : 0));
}
