import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { parse_uevents, Power } from "../../src/monitors/power.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-power", id: "test-power", ssh_config: { host: "test.host" } };

// A laptop on its charger, with a gauge that reports learned full capacity.
const laptop = `DEVTYPE=power_supply
POWER_SUPPLY_NAME=ACAD
POWER_SUPPLY_TYPE=Mains
POWER_SUPPLY_ONLINE=1
DEVTYPE=power_supply
POWER_SUPPLY_NAME=BAT1
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_STATUS=Full
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_ENERGY_FULL_DESIGN=45000000
POWER_SUPPLY_ENERGY_FULL=30070000
POWER_SUPPLY_ENERGY_NOW=30070000
POWER_SUPPLY_CAPACITY=100
`;

// A phone with a keyboard-case battery, whose gauges report only design capacity.
const phone = `DEVTYPE=power_supply
OF_NAME=battery-power
POWER_SUPPLY_NAME=axp20x-battery
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_HEALTH=Good
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_CHARGE_FULL_DESIGN=2750000
POWER_SUPPLY_CAPACITY=43
POWER_SUPPLY_NAME=axp20x-usb
POWER_SUPPLY_TYPE=USB
POWER_SUPPLY_ONLINE=0
POWER_SUPPLY_NAME=ip5xxx-battery
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_HEALTH=Good
POWER_SUPPLY_CAPACITY=27
POWER_SUPPLY_SCOPE=Device
`;

const unplugged = (text: string): string => text.replace("POWER_SUPPLY_ONLINE=1", "POWER_SUPPLY_ONLINE=0").replace("STATUS=Full", "STATUS=Discharging");
const power = (extra: PluginConfig = {}): Power => make_plugin(Power, { ...config, ...extra });
const run = (plugin: Power, stdout: string) => run_cycle(plugin, () => cmd_result(0, stdout, ""));
const latest_status = (plugin: Power) => store_of(plugin).latest_status("test-power");
const latest_metric = (plugin: Power, name: string) => store_of(plugin).latest_metric("test-power", name)?.value ?? null;

describe("parse uevents", () => {
  it("gives one record per supply without the prefix", () => {
    const supplies = parse_uevents(phone);
    expect(supplies.map((supply) => supply.NAME)).toEqual(["axp20x-battery", "axp20x-usb", "ip5xxx-battery"]);
    expect(supplies[0].CAPACITY).toBe("43");
    expect("OF_NAME" in supplies[0]).toBe(false);
  });
});

describe("collection", () => {
  it("reads a laptop on its charger", () => {
    const plugin = power();
    const result = run(plugin, laptop);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "charge_pct")).toBeCloseTo(100.0);
    expect(latest_metric(plugin, "plugged_in")).toBe(1.0);
    expect(Math.abs(latest_metric(plugin, "capacity_health_pct")! - 66.8)).toBeLessThanOrEqual(0.1);
    expect(result.settings["power:test-power:health"]).toBe("Good");
  });

  it("warns and then fails on worn cells", () => {
    const plugin = power({ capacity_warning: 70, capacity_threshold: 67 });
    const result = run(plugin, laptop);
    expect(latest_status(plugin)).toBe("failed");
    expect(result.settings["power:test-power:health"]).toBe("Replace");
  });

  it("headlines the phone battery, not the keyboard", () => {
    const plugin = power();
    run(plugin, phone);
    expect(latest_metric(plugin, "charge_pct")).toBeCloseTo(43.0);
    expect(latest_metric(plugin, "battery_ip5xxx_battery_charge_pct")).toBeCloseTo(27.0);
    expect(latest_metric(plugin, "plugged_in")).toBe(0.0);
  });

  it("leaves out unreported capacity", () => {
    const plugin = power();
    const result = run(plugin, phone);
    expect(latest_metric(plugin, "capacity_health_pct")).toBeNull();
    expect(result.settings["power:test-power:health"]).toBe("Good");
  });

  it("minds low charge only on battery", () => {
    const plugin = power();
    const low = laptop.replace("CAPACITY=100", "CAPACITY=8");
    run(plugin, low);
    expect(latest_status(plugin)).toBe("online");
    run(plugin, unplugged(low));
    expect(latest_status(plugin)).toBe("failed");
    run(plugin, unplugged(low.replace("CAPACITY=8", "CAPACITY=15")));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("counts a charging battery as plugged in", () => {
    const plugin = power();
    run(plugin, phone.replace("STATUS=Discharging\nPOWER_SUPPLY_HEALTH=Good\nPOWER_SUPPLY_PRESENT=1", "STATUS=Charging\nPOWER_SUPPLY_HEALTH=Good\nPOWER_SUPPLY_PRESENT=1"));
    expect(latest_metric(plugin, "plugged_in")).toBe(1.0);
  });

  it("fails a failure the kernel reports", () => {
    const plugin = power();
    const result = run(plugin, phone.replace("HEALTH=Good", "HEALTH=Overheat"));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.settings["power:test-power:health"]).toBe("Overheat");
  });

  it("keeps a host with no battery online", () => {
    const plugin = power();
    run(plugin, "POWER_SUPPLY_NAME=ACAD\nPOWER_SUPPLY_TYPE=Mains\n");
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "charge_pct")).toBeNull();
  });

  it("calls a missing named battery unavailable", () => {
    const plugin = power({ battery: "BAT0" });
    run(plugin, laptop);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a failed read unavailable", () => {
    const plugin = power();
    run_cycle(plugin, () => cmd_result(1, "", "permission denied"));
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("optional limits", () => {
  it("never fails with a charge warning only", () => {
    const plugin = power({ charge_threshold: null });
    run(plugin, unplugged(laptop.replace("CAPACITY=100", "CAPACITY=0")));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a charge failure only", () => {
    const plugin = power({ charge_warning: null });
    run(plugin, unplugged(laptop.replace("CAPACITY=100", "CAPACITY=15")));
    expect(latest_status(plugin)).toBe("online");
    run(plugin, unplugged(laptop.replace("CAPACITY=100", "CAPACITY=8")));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("never fails with a capacity warning only", () => {
    const plugin = power({ capacity_warning: 70, capacity_threshold: null });
    const result = run(plugin, laptop);
    expect(latest_status(plugin)).toBe("warning");
    expect(result.settings["power:test-power:health"]).toBe("Worn");
  });

  it("never warns with a capacity failure only", () => {
    const plugin = power({ capacity_warning: null });
    const result = run(plugin, laptop);
    expect(latest_status(plugin)).toBe("online");
    expect(result.settings["power:test-power:health"]).toBe("Good");
  });

  it("falls back to the charge threshold for the meter tick", () => {
    expect(power({ charge_warning: null }).UI_SPEC.cards!.batteries.repeat!.bar_marker).toBe(10);
  });
});

describe("cards", () => {
  it("colors low charge on the charge card only on battery", () => {
    const plugin = power();
    run(plugin, laptop);
    expect(plugin.charge_color(8.0)).toBe("online");
    run(plugin, unplugged(laptop));
    expect(plugin.charge_color(8.0)).toBe("failed");
  });

  it("names the power source", () => {
    expect(Power.plugged_text(1)).toBe("Plugged in");
    expect(Power.plugged_text(0)).toBe("On battery");
    expect(Power.plugged_text(null)).toBe("Checking...");
  });
});

describe("named battery", () => {
  it("gives a named battery its own page", () => {
    const plugin = power({ battery: "ip5xxx-battery" });
    run(plugin, phone);
    expect(latest_metric(plugin, "charge_pct")).toBeCloseTo(27.0);
    expect(latest_metric(plugin, "battery_ip5xxx_battery_charge_pct")).toBeCloseTo(27.0);
    expect(latest_metric(plugin, "battery_axp20x_battery_charge_pct")).toBeNull();
  });

  it("ignores the inputs an accessory battery feeds", () => {
    const plugin = power({ battery: "ip5xxx-battery" });
    const fed = phone.replace("POWER_SUPPLY_ONLINE=0", "POWER_SUPPLY_ONLINE=1");
    run(plugin, fed);
    expect(latest_metric(plugin, "plugged_in")).toBe(0.0);
    run(plugin, fed.replace("STATUS=Discharging\nPOWER_SUPPLY_HEALTH=Good\nPOWER_SUPPLY_CAPACITY=27", "STATUS=Charging\nPOWER_SUPPLY_HEALTH=Good\nPOWER_SUPPLY_CAPACITY=27"));
    expect(latest_metric(plugin, "plugged_in")).toBe(1.0);
  });
});

describe("page", () => {
  it("draws the charge card as a gauge with the on-battery coloring", () => {
    const plugin = power();
    const card = plugin.UI_SPEC.cards!.charge_card;
    expect(card.kind).toBe("gauge");
    expect(card.color).toBe(plugin.charge_color);
  });

  it("ticks each battery meter at the charge warning", () => {
    const plugin = power();
    const repeat = plugin.UI_SPEC.cards!.batteries.repeat!;
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_marker).toBe(plugin.charge_warning);
  });
});
