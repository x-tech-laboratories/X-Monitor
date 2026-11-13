import { describe, expect, it } from "vitest";

import { http_result } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { age_hours, Traccar, type DeviceItem } from "../../src/monitors/traccar.ts";
import { make_plugin, run_requests, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-traccar",
  id: "test-traccar",
  api_url: "http://traccar.test:8082",
  username: "x-monitor",
  password: "hunter2",
  stale_warning: 24,
  stale_threshold: 72,
  ssh_config: { host: "test.host" },
};

function iso(hours_ago: number): string {
  return new Date(Date.now() - hours_ago * 3_600_000).toISOString();
}

function device(name = "Phone", hours_ago = 1.0, disabled = false): Record<string, unknown> {
  return { name, disabled, lastUpdate: iso(hours_ago) };
}

function traccar(extra: PluginConfig = {}): Traccar {
  return make_plugin(Traccar, { ...base_config, ...extra });
}

function without_username(): PluginConfig {
  const { username: _username, ...rest } = base_config;
  return rest;
}

function run(plugin: Traccar, devices: unknown[] = [device()]): void {
  const payload = JSON.stringify(devices);
  run_requests(plugin, () => http_result(200, payload));
}

const latest_status = (plugin: Traccar) => store_of(plugin).store.statuses.get("test-traccar")?.state ?? null;
const latest_metric = (plugin: Traccar, name: string) => store_of(plugin).latest_metric("test-traccar", name)?.value ?? null;
const snapshot = (plugin: Traccar) => plugin.data.latest_snapshot<DeviceItem[]>()!;

describe("age hours", () => {
  it("reads a recent timestamp", () => {
    expect(Math.abs(age_hours(iso(2.0))! - 2.0)).toBeLessThan(0.1);
  });

  it("is null for none", () => {
    expect(age_hours(null)).toBeNull();
  });

  it("is null for an unparseable timestamp", () => {
    expect(age_hours("not-a-date")).toBeNull();
  });

  it("reads a timestamp without a zone as UTC", () => {
    const text = iso(3.0).replace("Z", "");
    expect(Math.abs(age_hours(text)! - 3.0)).toBeLessThan(0.1);
  });
});

describe("requests", () => {
  it("targets the devices endpoint with basic auth", () => {
    const requests = traccar().requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "http", url: "http://traccar.test:8082/api/devices", auth: ["x-monitor", "hunter2"] });
  });

  it("asks nothing without a url", () => {
    expect(make_plugin(Traccar, { name: "t", id: "t", username: "x-monitor", ssh_config: { host: "h" } }).requests()).toEqual([]);
  });

  it("asks nothing without a username", () => {
    expect(make_plugin(Traccar, without_username()).requests()).toEqual([]);
  });
});

describe("collection", () => {
  it("calls a fresh device online", () => {
    const plugin = traccar();
    run(plugin, [device("Phone", 1.0)]);
    expect(latest_status(plugin)).toBe("online");
  });

  it("warns on a stale device", () => {
    const plugin = traccar();
    run(plugin, [device("Phone", 30.0)]);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails a very stale device", () => {
    const plugin = traccar();
    run(plugin, [device("Phone", 100.0)]);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("leaves out disabled devices", () => {
    const plugin = traccar();
    run(plugin, [device("Phone", 200.0, true)]);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("calls an auth failure unavailable", () => {
    const plugin = traccar();
    run_requests(plugin, () => http_result(401, ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a transport error unavailable", () => {
    const plugin = traccar();
    run_requests(plugin, () => http_result(null, "", { error: "connection refused" }));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a malformed payload unavailable", () => {
    const plugin = traccar();
    run_requests(plugin, () => http_result(200, "<html>not json"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "devices_total")).toBeNull();
  });

  it("calls a missing username unavailable", () => {
    const plugin = make_plugin(Traccar, without_username());
    run_requests(plugin, () => http_result(200, "[]"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("counts a device that never reported as stale", () => {
    const plugin = traccar();
    run(plugin, [{ name: "NoFix", disabled: false, lastUpdate: null }]);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("leaves out devices the filter does not name", () => {
    const plugin = traccar({ devices: ["Phone"] });
    run(plugin, [device("Phone", 1.0), device("OldTablet", 500.0)]);
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(traccar().plan_action("anything")).toBeNull();
  });
});

describe("device snapshot", () => {
  it("makes each watched device one item with its age", () => {
    const plugin = traccar();
    run(plugin, [device("Tablet", 30.0), device("Phone", 0.2), device("Old", 900.0, true)]);
    const items = snapshot(plugin);
    expect(items.map((item) => item.label)).toEqual(["Phone", "Tablet"]);
    expect(Math.abs(items[0].age_hours! - 0.2)).toBeLessThan(0.01);
    expect(items[0].state).toBe("online");
    expect(items[1].state).toBe("warning");
  });

  it("fails a device past the stale threshold or never reporting", () => {
    const plugin = traccar();
    run(plugin, [device("Lost", 100.0), { name: "NoFix", disabled: false, lastUpdate: null }]);
    const items = Object.fromEntries(snapshot(plugin).map((item) => [item.label, item]));
    expect(items.Lost.state).toBe("failed");
    expect(items.NoFix.state).toBe("failed");
    expect(items.NoFix.age_hours).toBeNull();
  });
});

describe("device bars", () => {
  it("fill to twice the stale threshold", () => {
    const spec = traccar().UI_SPEC;
    const repeat = spec.cards!.device_bars.repeat!;
    expect(repeat.source).toBe("snapshot");
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_value).toBe("age_hours");
    expect(repeat.bar_max).toBe(144.0);
    expect(repeat.bar_marker).toBe(50.0);
    expect((repeat.item_color_by as (item: Record<string, unknown>) => unknown)({ state: "warning" })).toBe("warning");
    expect(spec.layout!.some((row) => row.includes("device_bars"))).toBe(true);
  });

  it("read the age in minutes then hours", () => {
    const format_item = traccar().UI_SPEC.cards!.device_bars.repeat!.item_format_fn as (item: Record<string, unknown>) => string;
    expect(format_item({ age_hours: 0.2 })).toBe("12 min");
    expect(format_item({ age_hours: 8.44 })).toBe("8.4 h");
    expect(format_item({ age_hours: null })).toBe("never");
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = traccar({ stale_threshold: null });
    run(plugin, [device("Phone", 500.0)]);
    expect(latest_status(plugin)).toBe("warning");
    expect(snapshot(plugin)[0].state).toBe("warning");
    expect(plugin.UI_SPEC.cards!.device_bars.repeat!.bar_max).toBe(48.0);
  });

  it("never warns with a failure only", () => {
    const plugin = traccar({ stale_warning: null });
    run(plugin, [device("Phone", 30.0)]);
    expect(latest_status(plugin)).toBe("online");
    run(plugin, [device("Phone", 100.0)]);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("stays online with both off and keeps a bar scale", () => {
    const plugin = traccar({ stale_warning: null, stale_threshold: null });
    run(plugin, [device("Phone", 500.0)]);
    expect(latest_status(plugin)).toBe("online");
    expect(plugin.UI_SPEC.cards!.device_bars.repeat!.bar_max).toBe(168.0);
  });
});
