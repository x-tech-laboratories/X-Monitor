import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { sanitize_pool, Zfs } from "../../src/monitors/zfs.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import type { ItemColorRule, ItemFormatter } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-zfs", id: "test-zfs", ssh_config: { host: "test.host" } };

const make_zpool = (pools: Record<string, [string, number]>): string => Object.entries(pools).map(([name, [health, capacity]]) => `${name}\t${health}\t${capacity}%\n`).join("");
const zfs = (extra: PluginConfig = {}): Zfs => make_plugin(Zfs, { ...config, ...extra });
const run = (plugin: Zfs, body: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, body, stderr));
const latest_status = (plugin: Zfs) => store_of(plugin).latest_status("test-zfs");
const latest_metric = (plugin: Zfs, name: string) => store_of(plugin).latest_metric("test-zfs", name)?.value ?? null;

describe("sanitize pool", () => {
  it("lower-cases and replaces separators", () => expect(sanitize_pool("Tank-Fast.01")).toBe("tank_fast_01"));
});

describe("collection", () => {
  it("calls all online pools ok", () => {
    const plugin = zfs();
    run(plugin, make_zpool({ pool1: ["ONLINE", 10], pool2: ["ONLINE", 20] }));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "pools_total")).toBe(2);
    expect(latest_metric(plugin, "pools_ok")).toBe(2);
    expect(latest_metric(plugin, "pools_degraded")).toBe(0);
  });

  it("records each pool's usage", () => {
    const plugin = zfs();
    run(plugin, make_zpool({ tank: ["ONLINE", 10], "back-up": ["ONLINE", 55] }));
    expect(latest_metric(plugin, "pool_usage_tank")).toBeCloseTo(10.0);
    expect(latest_metric(plugin, "pool_usage_back_up")).toBeCloseTo(55.0);
    expect(latest_metric(plugin, "zfs_usage_max")).toBeCloseTo(55.0);
  });

  it.each(["DEGRADED", "FAULTED", "OFFLINE", "UNAVAIL", "REMOVED"])("fails a pool that is %s", (bad_state) => {
    const plugin = zfs();
    run(plugin, make_zpool({ pool1: [bad_state, 10] }));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "pools_degraded")).toBe(1);
  });

  it("warns on usage past the warning", () => {
    const plugin = zfs();
    run(plugin, make_zpool({ tank: ["ONLINE", 85] }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails usage at the threshold", () => {
    const plugin = zfs();
    run(plugin, make_zpool({ tank: ["ONLINE", 90] }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("applies custom thresholds", () => {
    const plugin = zfs({ warning: 60, threshold: 75 });
    run(plugin, make_zpool({ tank: ["ONLINE", 80] }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("narrows the query to named pools", () => {
    expect(zfs({ pools: ["tank", "backup"] }).commands()[0].text).toContain("name,health,capacity tank backup");
  });

  it("calls no pools unavailable", () => {
    const plugin = zfs();
    run(plugin, "");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("skips malformed lines", () => {
    const plugin = zfs();
    run(plugin, "pool1\tONLINE\t10%\njust_one_word\npool2\tONLINE\t20%\n");
    expect(latest_metric(plugin, "pools_total")).toBe(2);
  });

  it("calls a transport failure unavailable", () => {
    const plugin = zfs();
    run(plugin, "", -1, "timeout");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a missing zpool unavailable", () => {
    const plugin = zfs();
    run(plugin, "", 127, "zpool: command not found");
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "pools_total")).toBeNull();
  });
});

describe("page", () => {
  it("gives the per-pool repeat card its own row", () => expect(zfs().UI_SPEC.layout).toContainEqual(["zfs_pools"]));

  it("ticks the pool meters at the warning level", () => {
    const plugin = zfs();
    const repeat = plugin.UI_SPEC.cards!.zfs_pools.repeat!;
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_marker).toBe(plugin.warning);
    expect(repeat.item_color_by).toBe(plugin.item_level);
  });

  it("shares one bar between healthy and degraded pools", () => {
    const health = zfs().UI_SPEC.cards!.zfs_degraded_card;
    expect(health.kind).toBe("share");
    expect(health.parts!.map((part) => [part.metric, part.color])).toEqual([["pools_ok", "online"], ["pools_degraded", "failed"]]);
  });

  it("drops the count cards the meters replace", () => {
    const plugin = zfs();
    const cards = Object.keys(plugin.UI_SPEC.cards!);
    expect(cards).not.toContain("zfs_ok_card");
    expect(cards).not.toContain("zfs_usage_card");
    expect(plugin.card_row()).toEqual(["zfs_total_card", "zfs_degraded_card"]);
  });
});

describe("pool tiles", () => {
  it("records each pool with its health and usage", () => {
    const result = zfs().parse([cmd_result(0, make_zpool({ tank: ["ONLINE", 78], "back-up": ["DEGRADED", 12] }), "")]);
    expect(result.snapshot).toEqual([{ label: "tank", health: "ONLINE", usage: 78.0 }, { label: "back-up", health: "DEGRADED", usage: 12.0 }]);
  });

  it("clears the tiles when there are no pools", () => expect(zfs().parse([cmd_result(0, "", "")]).snapshot).toEqual([]));

  it("puts the tiles on their own row above the meters", () => {
    const layout = zfs().UI_SPEC.layout!.map((row) => JSON.stringify(row));
    expect(layout.indexOf(JSON.stringify(["zfs_pool_tiles"]))).toBeLessThan(layout.indexOf(JSON.stringify(["zfs_pools"])));
  });

  it("repeats the tiles over the snapshot", () => {
    const repeat = zfs().UI_SPEC.cards!.zfs_pool_tiles.repeat!;
    expect(repeat.source).toBe("snapshot");
    expect(repeat.container).toBe("tiles");
  });

  it("captions a tile with health and usage", () => {
    const format = zfs().UI_SPEC.cards!.zfs_pool_tiles.repeat!.item_format_fn as ItemFormatter;
    expect(format({ health: "ONLINE", usage: 78.0 })).toBe("ONLINE · 78%");
  });

  it.each([
    ["ONLINE", 10, "online"], ["ONLINE", 85, "warning"], ["ONLINE", 95, "failed"],
    ["DEGRADED", 10, "failed"], ["FAULTED", 10, "failed"], ["UNAVAIL", 10, "failed"],
  ])("colors a %s tile at %d%% %s", (health, usage, state) => {
    const color = zfs().UI_SPEC.cards!.zfs_pool_tiles.repeat!.item_color_by as ItemColorRule;
    expect(color({ health, usage })).toBe(state);
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = zfs({ threshold: null });
    run(plugin, make_zpool({ tank: ["ONLINE", 100] }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = zfs({ warning: null });
    run(plugin, make_zpool({ tank: ["ONLINE", 89] }));
    expect(latest_status(plugin)).toBe("online");
    run(plugin, make_zpool({ tank: ["ONLINE", 90] }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("still fails an unhealthy pool with no limits", () => {
    const plugin = zfs({ warning: null, threshold: null });
    run(plugin, make_zpool({ tank: ["DEGRADED", 10] }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("falls back to the threshold for the meter tick", () => {
    expect(zfs({ warning: null }).UI_SPEC.cards!.zfs_pools.repeat!.bar_marker).toBe(90);
  });
});
