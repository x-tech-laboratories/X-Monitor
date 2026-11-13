// Thermal zone temperatures, read from /sys/class/thermal.

import { format_fixed, parse_int, split_lines } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of } from "../shared/status.ts";
import type { CardSpec, ChartSpec, LayoutRow } from "../shared/ui_spec.ts";
import { level_for, limit_from, limits_text, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

const query =
  "for d in /sys/class/thermal/thermal_zone*; do " +
  '  [ -f "$d/temp" ] || continue; ' +
  '  type=$(cat "$d/type" 2>/dev/null || echo unknown); ' +
  '  temp=$(cat "$d/temp" 2>/dev/null || echo 0); ' +
  '  echo "SENSOR:${type}:${temp}"; ' +
  "done";

function sanitize_zone(name: string): string {
  return [...name.toLowerCase()].map((character) => (/^[\p{L}\p{N}_]$/u.test(character) ? character : "_")).join("");
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// The hottest zone sets the status, with one metric per zone; a host with no thermal zones, typically a VM, stays
// online with no metric rather than reporting a problem it cannot see.
export class Temperature extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly warning: number | null;
  readonly threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.warning = limit_from(config, "warning", 70);
    this.threshold = limit_from(config, "threshold", 80);
  }

  // The reading that fills the gauge and zone meters: 100°C, or the threshold if higher.
  get scale_max(): number {
    return this.threshold !== null ? Math.max(100, this.threshold) : 100;
  }

  // One sensor's chip, by its own reading against this monitor's thresholds.
  readonly item_level = (item: Record<string, unknown>): "online" | "warning" | "failed" => level_for(Number(item.value) || 0, this.warning, this.threshold);

  override commands(): Command[] {
    return [command(query)];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Temperature collection failed: ${stderr}`);

    const sensors = new Map<string, number>();
    for (const line of split_lines(stdout)) {
      if (!line.startsWith("SENSOR:")) continue;
      const first = line.indexOf(":");
      const second = line.indexOf(":", first + 1);
      if (second === -1) continue;
      const zone_type = line.slice(first + 1, second);
      let temp_c: number;
      try {
        temp_c = parse_int(line.slice(second + 1).trim()) / 1000;
      } catch {
        continue;
      }
      const key = sanitize_zone(zone_type);
      sensors.set(key, Math.max(sensors.get(key) ?? 0, temp_c));
    }

    if (sensors.size === 0) return new CollectResult({ logs: [["No thermal zones found — skipping", "INFO"]], status: "online" });

    const max_temp = Math.max(...sensors.values());
    const metrics: Record<string, number> = { temp_c: max_temp };
    for (const [key, temp_c] of sensors) metrics[`temp_zone_${key}`] = temp_c;

    const status = level_for(max_temp, this.warning, this.threshold);
    return new CollectResult({
      metrics,
      logs: [[`Max ${format_fixed(max_temp, 1)}°C across ${sensors.size} zone(s) (${limits_text(this.warning, this.threshold, "°C")})`, log_level_of(status)]],
      status,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      temp_card: { kind: "gauge", metric: "temp_c", title: "MAX TEMP", format: "temp_c1", max: this.scale_max, color: { warning: this.warning, threshold: this.threshold } },
      sensors: {
        title: "THERMAL ZONES",
        repeat: {
          source: "metrics_prefix",
          metrics_prefix: "temp_zone_",
          metrics_suffix: "",
          item_format: "temp_c1",
          item_color_by: this.item_level,
          label_transform: "spaces_upper",
          container: "bars",
          bar_max: this.scale_max,
          bar_marker: this.warning !== null ? (this.warning / this.scale_max) * 100 : undefined,
          empty_text: "No thermal zones found",
        },
      },
    };
  }

  override card_row(): string[] {
    return ["temp_card"];
  }

  override rows(): LayoutRow[] {
    return [["sensors"]];
  }

  override charts(): Record<string, ChartSpec> {
    return { temp_chart: { metric: "temp_c", title: "TEMPERATURE (°C)" } };
  }
}
