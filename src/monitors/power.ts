// Battery charge, external power and battery wear, read from /sys/class/power_supply.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, LayoutRow } from "../shared/ui_spec.ts";
import { floor_level_for, limit_from, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin, worst_status } from "./base/signal_plugin.ts";
import { float_or_null, format_fixed, partition, split_lines } from "./base/text_parsing.ts";

// Kernel health values that mean the battery is failing rather than just outside its comfort zone.
const failed_health = new Set(["Dead", "Overheat", "Over voltage", "Over current", "Unspecified failure", "No battery"]);
const good_health = new Set(["Good", "Unknown"]);

const query = 'for f in /sys/class/power_supply/*/uevent; do [ -r "$f" ] && cat "$f"; done; true';

type Supply = Record<string, string>;

function sanitize(name: string): string {
  return [...name.toLowerCase()].map((character) => (/^[\p{L}\p{N}_]$/u.test(character) ? character : "_")).join("");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// Concatenated power_supply uevent files as one record per supply, keyed without the POWER_SUPPLY_ prefix.
export function parse_uevents(stdout: string): Supply[] {
  const supplies: Supply[] = [];
  for (const line of split_lines(stdout)) {
    const [raw_key, separator, value] = partition(line, "=");
    if (!separator || !raw_key.startsWith("POWER_SUPPLY_")) continue;
    const key = raw_key.slice("POWER_SUPPLY_".length);
    if (key === "NAME") supplies.push({});
    if (supplies.length > 0) supplies.at(-1)![key] = value.trim();
  }
  return supplies;
}

function number_of(supply: Supply, key: string): number | null {
  return key in supply ? float_or_null(supply[key]) : null;
}

function ratio_pct(now: number | null, full: number | null): number | null {
  return now !== null && full ? (now / full) * 100 : null;
}

// Current charge, from the kernel's own percentage or else from energy or charge counters.
function charge_pct(battery: Supply): number | null {
  const capacity = number_of(battery, "CAPACITY");
  if (capacity !== null) return capacity;
  return ratio_pct(number_of(battery, "ENERGY_NOW"), number_of(battery, "ENERGY_FULL")) || ratio_pct(number_of(battery, "CHARGE_NOW"), number_of(battery, "CHARGE_FULL"));
}

// How much of the factory capacity the battery still holds, if its gauge reports a learned full capacity.
function capacity_health_pct(battery: Supply): number | null {
  return ratio_pct(number_of(battery, "ENERGY_FULL"), number_of(battery, "ENERGY_FULL_DESIGN")) || ratio_pct(number_of(battery, "CHARGE_FULL"), number_of(battery, "CHARGE_FULL_DESIGN"));
}

function is_battery(supply: Supply): boolean {
  return supply.TYPE === "Battery" && (supply.PRESENT ?? "1") !== "0";
}

// The named battery, else the first one powering the system itself rather than an accessory like a keyboard case.
function primary_battery(batteries: Supply[], name: string | null): Supply | null {
  if (name) return batteries.find((battery) => battery.NAME === name) ?? null;
  const system = batteries.filter((battery) => battery.SCOPE !== "Device");
  return (system.length > 0 ? system : batteries)[0] ?? null;
}

// Whether any charger or USB input is live, or the battery says it is being charged; an accessory battery's own state
// is the only sign of its charger, since the host's inputs may be fed by that very battery.
function plugged_in(supplies: Supply[], battery: Supply): boolean {
  if (battery.SCOPE !== "Device" && supplies.some((supply) => supply.TYPE !== "Battery" && supply.ONLINE === "1")) return true;
  return ["Charging", "Full", "Not charging"].includes(battery.STATUS);
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Battery charge, whether the device is plugged in, and how worn the battery is; a host with no battery stays online
// with no metric rather than reporting a problem it cannot see.
export class Power extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly battery: string | null;
  readonly charge_warning: number | null;
  readonly charge_threshold: number | null;
  readonly capacity_warning: number | null;
  readonly capacity_threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.battery = (config.battery as string | null | undefined) ?? null;
    this.charge_warning = limit_from(config, "charge_warning", 20);
    this.charge_threshold = limit_from(config, "charge_threshold", 10);
    this.capacity_warning = limit_from(config, "capacity_warning", 60);
    this.capacity_threshold = limit_from(config, "capacity_threshold", 40);
  }

  private get setting_prefix(): string {
    return `power:${this.id}`;
  }

  // A reading where lower is worse; a null reading never fires.
  private floor_level(value: number | null, warning: number | null, threshold: number | null): Status {
    if (value === null) return "online";
    return floor_level_for(value, warning, threshold);
  }

  // One overall verdict and its level: the kernel's own complaint if it has one, else how worn the cells are.
  private health(kernel_health: string | undefined, capacity_pct: number | null): [verdict: string, level: Status] {
    if (kernel_health && !good_health.has(kernel_health)) return [kernel_health, failed_health.has(kernel_health) ? "failed" : "warning"];
    if (capacity_pct === null) return [kernel_health || "Unknown", "online"];
    const level = this.floor_level(capacity_pct, this.capacity_warning, this.capacity_threshold);
    const verdicts: Record<string, string> = { online: "Good", warning: "Worn", failed: "Replace" };
    return [verdicts[level], level];
  }

  override commands(): Command[] {
    return [command(query)];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to read /sys/class/power_supply: ${stderr}`);

    const supplies = parse_uevents(stdout);
    const batteries = supplies.filter(is_battery);
    const battery = primary_battery(batteries, this.battery);
    if (battery === null) {
      if (this.battery) return CollectResult.unavailable(`Battery '${this.battery}' not found`);
      return new CollectResult({ logs: [["No battery found — skipping", "INFO"]], status: "online" });
    }

    const charge = charge_pct(battery);
    const capacity = capacity_health_pct(battery);
    const plugged = plugged_in(supplies, battery);
    const [health, health_level] = this.health(battery.HEALTH, capacity);

    const metrics: Record<string, number> = { plugged_in: plugged ? 1 : 0 };
    if (charge !== null) metrics.charge_pct = charge;
    if (capacity !== null) metrics.capacity_health_pct = capacity;
    for (const each of this.battery ? [battery] : batteries) {
      const pct = charge_pct(each);
      if (pct !== null) metrics[`battery_${sanitize(each.NAME ?? "")}_charge_pct`] = pct;
    }

    const charge_level = plugged ? "online" : this.floor_level(charge, this.charge_warning, this.charge_threshold);
    const status = worst_status([charge_level, health_level]);

    const charge_text = charge === null ? "?" : `${format_fixed(charge, 0)}%`;
    const capacity_text = capacity === null ? "unreported" : `${format_fixed(capacity, 0)}% of design`;
    const state = battery.STATUS ?? "Unknown";
    return new CollectResult({
      metrics,
      logs: [[`${battery.NAME ?? "None"}: ${charge_text}, ${state.toLowerCase()}, ${plugged ? "plugged in" : "on battery"}; health ${health}, capacity ${capacity_text}`, log_level_of(status)]],
      status,
      settings: {
        [`${this.setting_prefix}:health`]: health,
        [`${this.setting_prefix}:health_level`]: health_level,
        [`${this.setting_prefix}:state`]: state,
      },
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get health_text(): string {
    return this.data.get_setting(`${this.setting_prefix}:health`) || "Checking...";
  }

  get health_level(): string | null {
    return this.data.get_setting(`${this.setting_prefix}:health_level`);
  }

  get state_text(): string {
    return this.data.get_setting(`${this.setting_prefix}:state`) || "Checking...";
  }

  static plugged_text(value: number | null): string {
    if (value === null) return "Checking...";
    return value > 0.5 ? "Plugged in" : "On battery";
  }

  // Low charge only matters while running on the battery.
  readonly charge_color = (value: number | null): Status | null => {
    if (value === null) return null;
    const plugged = this.data.latest_metric("plugged_in");
    if (plugged !== null && plugged.value > 0.5) return "online";
    return this.floor_level(value, this.charge_warning, this.charge_threshold);
  };

  readonly capacity_color = (value: number | null): Status | null => (value === null ? null : this.floor_level(value, this.capacity_warning, this.capacity_threshold));

  override cards(): Record<string, CardSpec> {
    return {
      charge_card: { kind: "gauge", metric: "charge_pct", title: "CHARGE", format: "percent0", color: this.charge_color },
      power_card: { metric: "plugged_in", title: "POWER", format: Power.plugged_text },
      state_card: { title: "STATE", value_attr: "state_text", refresh: true },
      health_card: { title: "HEALTH", value_attr: "health_text", color_attr: "health_level" },
      capacity_card: { metric: "capacity_health_pct", title: "CAPACITY LEFT", format: "percent0", color: this.capacity_color },
      batteries: {
        title: "BATTERIES",
        repeat: {
          source: "metrics_prefix",
          metrics_prefix: "battery_",
          metrics_suffix: "_charge_pct",
          item_format: "percent0",
          label_transform: "spaces_upper",
          container: "bars",
          bar_marker: this.charge_warning ?? this.charge_threshold ?? undefined,
          empty_text: "No battery found",
        },
      },
    };
  }

  override card_row(): string[] {
    return ["charge_card", "power_card", "state_card", "health_card", "capacity_card"];
  }

  override rows(): LayoutRow[] {
    return [["batteries"]];
  }

  override charts(): Record<string, ChartSpec> {
    return {
      charge_chart: { metric: "charge_pct", title: "CHARGE (%)" },
      capacity_chart: { metric: "capacity_health_pct", title: "CAPACITY LEFT (%)" },
    };
  }
}
