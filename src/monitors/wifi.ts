// WiFi link quality and signal strength, read from /proc/net/wireless.

import { format_fixed, parse_float, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import { floor_level_for, limit_from, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

// ── Parsing ──────────────────────────────────────────────────────────────────

// Each wireless interface's [link quality, signal dBm].
export function parse_wireless(stdout: string): Map<string, [link: number, level: number]> {
  const result = new Map<string, [number, number]>();
  for (const line of split_lines(stdout)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const interface_name = line.slice(0, colon).trim();
    const fields = split_words(line.slice(colon + 1));
    if (fields.length < 3) continue;
    try {
      result.set(interface_name, [parse_float(fields[1].replace(/\.+$/, "")), parse_float(fields[2].replace(/\.+$/, ""))]);
    } catch {
      continue;
    }
  }
  return result;
}

// The wireless interface with the best link quality, if any.
export function strongest_interface(stats: Map<string, [number, number]>): string | null {
  let best: string | null = null;
  for (const [name, [link]] of stats) if (best === null || link > stats.get(best)![0]) best = name;
  return best;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Its limits are floors, where lower is worse, and either may be null to turn that level off.
export class Wifi extends SignalPlugin {
  override readonly SAMPLED = true;
  // Most drivers report link quality in /proc/net/wireless out of 70.
  readonly QUALITY_MAX = 70.0;
  readonly interface: string | null;
  readonly quality_warning: number | null;
  readonly quality_threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.interface = (config.interface as string | null | undefined) ?? null;
    this.quality_warning = limit_from(config, "quality_warning", 40);
    this.quality_threshold = limit_from(config, "quality_threshold", 20);
  }

  get setting_key(): string {
    return `network:${this.id}:wifi_interface`;
  }

  private level_for_quality(quality: number): Status {
    return floor_level_for(quality, this.quality_warning, this.quality_threshold);
  }

  quality_color(quality: number | null): Status | null {
    return quality === null ? null : this.level_for_quality(quality);
  }

  override commands(): Command[] {
    return [command("cat /proc/net/wireless")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to read /proc/net/wireless: ${stderr}`);

    const stats = parse_wireless(stdout);
    const interface_name = this.interface || strongest_interface(stats);
    if (!interface_name) return CollectResult.unavailable("No wireless interface found");
    const stat = stats.get(interface_name);
    if (stat === undefined) return CollectResult.unavailable(`Interface '${interface_name}' not found in /proc/net/wireless`);

    const [quality, signal] = stat;
    const status = this.level_for_quality(quality);
    return new CollectResult({
      metrics: { link_quality: quality, signal_dbm: signal },
      logs: [[`${interface_name}: link quality ${format_fixed(quality, 0)}, signal ${format_fixed(signal, 0)} dBm`, log_level_of(status)]],
      status,
      settings: { [this.setting_key]: interface_name },
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get active_interface_text(): string {
    return this.data.get_setting(this.setting_key) || this.interface || "Detecting...";
  }

  readonly quality_color_rule = (quality: number | null): Status | null => this.quality_color(quality);

  override cards(): Record<string, CardSpec> {
    return {
      wifi_iface_card: { title: "WIFI INTERFACE", value_attr: "active_interface_text", refresh: true },
      quality_card: { kind: "gauge", metric: "link_quality", title: "LINK QUALITY", format: "int_rounded", color: this.quality_color_rule, max: this.QUALITY_MAX },
      signal_card: { metric: "signal_dbm", title: "SIGNAL", format: "dbm0" },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return {
      quality_chart: { metric: "link_quality", title: "LINK QUALITY" },
      signal_chart: { metric: "signal_dbm", title: "SIGNAL (dBm)" },
    };
  }
}
