import { describe, expect, it } from "vitest";

import { build_spec, spec_layout } from "../../src/server/views/spec.ts";
import {
  align_series, card_metric_names, color_for, fill_percent, gauge_dash, GAUGE_SWEEP_LENGTH, share_percents, strip_cell_color, strip_states, STATUS_COLORS, up_share,
} from "../../src/shared/charts.ts";
import type { UISpec } from "../../src/shared/ui_spec.ts";
import { make_plugin } from "../harness.ts";
import { apply, SpecPlugin, widgets_by_type } from "./helpers.ts";

// ── Geometry ─────────────────────────────────────────────────────────────────

describe("fill percent", () => {
  it("is a value's share of the maximum", () => expect(fill_percent(54, 80)).toBeCloseTo(67.5));
  it("fills the bar and no further past the maximum", () => expect(fill_percent(140)).toBe(100));
  it("leaves the bar empty for a negative value", () => expect(fill_percent(-3)).toBe(0));
  it("leaves the bar empty with no reading", () => expect(fill_percent(null)).toBe(0));
  it("leaves the bar empty rather than divide by a zero maximum", () => expect(fill_percent(5, 0)).toBe(0));
});

describe("colour for", () => {
  it("gives a status name its status colour", () => expect(color_for("warning")).toBe(STATUS_COLORS.warning));
  it("gives a named series colour its token", () => expect(color_for("series-2")).toBe("var(--series-2)"));
  it("falls back to the accent", () => expect(color_for(null)).toBe("var(--accent)"));
});

describe("the gauge's dash", () => {
  it("is its share of the sweep", () => expect(gauge_dash(50).dash).toBe(`${(GAUGE_SWEEP_LENGTH / 2).toFixed(2)} 999`));
  it("draws no round cap when empty", () => expect(gauge_dash(0).stroke_visible).toBe(false));
});

describe("strip states", () => {
  it("are up above the line and down otherwise", () => expect(strip_states([1, 0, 1], 0.5, 3)).toEqual(["online", "failed", "online"]));
  it("pad a short history at its old end", () => expect(strip_states([1], 0.5, 3)).toEqual(["unavailable", "unavailable", "online"]));
  it("keep only the newest cells", () => expect(strip_states([0, 0, 1, 1], 0.5, 2)).toEqual(["online", "online"]));
  it("read a missing reading as no data rather than down", () => expect(strip_states([null, 1], 0.5, 2)).toEqual(["unavailable", "online"]));
  it("take a configurable up line", () => expect(strip_states([3, 7], 5, 2)).toEqual(["failed", "online"]));
});

describe("up share", () => {
  it("does not count cells with no data against uptime", () => expect(up_share(["unavailable", "online", "failed", "online"])).toBeCloseTo(200 / 3));
  it("counts an info cell as up", () => expect(up_share(["info", "online"])).toBe(100));
  it("has none with no measured cells", () => expect(up_share(["unavailable", "unavailable"])).toBeNull());
});

describe("strip cell colour", () => {
  it("is the cell's state colour", () => expect(strip_cell_color("failed")).toBe(STATUS_COLORS.failed));
  it("is the track colour with no data", () => expect(strip_cell_color("unavailable")).toBe("var(--surface-secondary)"));
});

describe("share percents", () => {
  it("give each part its share of the total", () => expect(share_percents([1, 3])).toEqual([25, 75]));
  it("count a missing part as zero", () => expect(share_percents([null, 2])).toEqual([0, 100]));
  it("leave every part empty with nothing to share", () => expect(share_percents([0, null])).toEqual([0, 0]));
});

describe("aligning series", () => {
  it("shares the first one's timestamps", () => expect(align_series([[["a", 1], ["b", 2]], [["a", 5], ["b", 6]]])).toEqual([["a", "b"], [[1, 2], [5, 6]]]));
  it("pads a shorter history at its old end", () => expect(align_series([[["a", 1], ["b", 2], ["c", 3]], [["c", 9]]])[1][1]).toEqual([null, null, 9]));
  it("keeps only a longer history's newest readings", () => expect(align_series([[["b", 2]], [["a", 8], ["b", 9]]])[1][1]).toEqual([9]));
  it("is empty with no history yet", () => expect(align_series([[], []])).toEqual([[], [[], []]]));
});

describe("card metric names", () => {
  it("are a gauge's metric", () => expect(card_metric_names({ kind: "gauge", metric: "cpu_pct" })).toEqual(["cpu_pct"]));
  it("are every part of a share", () => expect(card_metric_names({ kind: "share", parts: [{ metric: "a" }, { metric: "b" }] })).toEqual(["a", "b"]));
  it("are none for a strip, which reads history", () => expect(card_metric_names({ kind: "strip", metric: "up" })).toEqual([]));
});

// ── Chart cards built from a spec ────────────────────────────────────────────

const CHART_SPEC: UISpec = {
  layout: [["gauge", "share"], ["strip"], ["strips"], ["bars", "tiles"], ["sizes"], ["lines"]],
  cards: {
    gauge: { kind: "gauge", metric: "cpu_pct", title: "CPU", format: "percent1", color: { warning: 70, threshold: 85 } },
    share: { kind: "share", title: "QUERIES", format: "int", parts: [{ metric: "allowed", label: "Allowed" }, { metric: "blocked", label: "Blocked", color: "warning" }] },
    strip: { kind: "strip", metric: "up", title: "AVAILABILITY", cells: 4 },
    strips: { kind: "strip", title: "CHECKS", cells: 4, rows: [{ metric: "ssh_up", label: "SSH" }, { metric: "api_up", label: "API" }] },
    bars: { title: "SPACE USED", repeat: { source: "metrics_prefix", metrics_prefix: "fs_", metrics_suffix: "_pct", container: "bars", item_format: "percent0", bar_marker: 85 } },
    sizes: { title: "SIZES", repeat: { source: "metrics_prefix", metrics_prefix: "size_", metrics_suffix: "_gb", container: "bars", item_format: "bytes_gb", bar_max: "largest" } },
    tiles: { title: "DISKS", repeat: { source: "metrics_prefix", metrics_prefix: "disk_", metrics_suffix: "_ok", container: "tiles", item_format: "int", item_color_by: (item) => (item.value ? "online" : "failed") } },
  },
  charts: { lines: { title: "LOAD", style: "lines", series: [{ metric: "load_1", label: "1m" }, { metric: "load_5", label: "5m" }] } },
};

function probe(): SpecPlugin {
  return make_plugin(SpecPlugin, { name: "probe", id: "probe", ui_spec: CHART_SPEC });
}

function rows_of(plugin: SpecPlugin) {
  const layout = spec_layout(plugin, CHART_SPEC.layout!);
  build_spec(plugin, { layout });
  return layout.rows;
}

describe("a gauge card", () => {
  it("prints its value and fills its share in the status colour", () => {
    const plugin = probe();
    apply(plugin, { metrics: { cpu_pct: 78 }, status: "warning" });
    const [gauge] = widgets_by_type(rows_of(plugin), "gauge");
    expect(gauge).toMatchObject({ title: "CPU", text: "78.0%", percent: 78, state: "warning" });
  });

  it("leaves its arc empty with no reading", () => {
    const [gauge] = widgets_by_type(rows_of(probe()), "gauge");
    expect(gauge).toMatchObject({ text: "-- %", percent: 0, state: null });
  });
});

describe("a share card", () => {
  it("grows each part to its share and prints every part's value", () => {
    const plugin = probe();
    apply(plugin, { metrics: { allowed: 3, blocked: 1 }, status: "online" });
    const [share] = widgets_by_type(rows_of(plugin), "share");
    expect(share.parts).toEqual([
      { label: "Allowed", text: "3", percent: 75, color: "series-1" },
      { label: "Blocked", text: "1", percent: 25, color: "warning" },
    ]);
  });
});

describe("a strip card", () => {
  it("counts only measured checks in its up share", () => {
    const plugin = probe();
    for (const up of [1, 0, 1]) apply(plugin, { metrics: { up }, status: "online" });
    expect(widgets_by_type(rows_of(plugin), "strip")[0].rows[0].share_text).toBe("66.7% up");
  });

  it("draws a down check as failed and a missing one as no data", () => {
    const plugin = probe();
    apply(plugin, { metrics: { up: 0 }, status: "failed" });
    expect(widgets_by_type(rows_of(plugin), "strip")[0].rows[0].states).toEqual(["unavailable", "unavailable", "unavailable", "failed"]);
  });

  it("labels only a panel of several rows", () => {
    const [single, several] = widgets_by_type(rows_of(probe()), "strip");
    expect(single.rows.map((row) => row.label)).toEqual([null]);
    expect(several.rows.map((row) => row.label)).toEqual(["SSH", "API"]);
  });

  it("reads each row's own metric", () => {
    const plugin = probe();
    apply(plugin, { metrics: { up: 1, ssh_up: 1, api_up: 0 }, status: "failed" });
    expect(widgets_by_type(rows_of(plugin), "strip").flatMap((strip) => strip.rows.map((row) => row.share_text))).toEqual(["100.0% up", "100.0% up", "0.0% up"]);
  });
});

describe("repeated items as meters and tiles", () => {
  it("fill a meter per item to its value with the warning tick", () => {
    const plugin = probe();
    apply(plugin, { metrics: { fs_root_pct: 41, fs_storage_pct: 78 }, status: "online" });
    const [bars] = widgets_by_type(rows_of(plugin), "repeat");
    expect(bars.items.map((item) => [item.label, item.value, item.percent])).toEqual([["root", "41%", 41], ["storage", "78%", 78]]);
    expect(bars.marker).toBe(85);
    expect(bars.title).toBe("SPACE USED");
  });

  it("draw a tile per item in its state", () => {
    const plugin = probe();
    apply(plugin, { metrics: { disk_sda_ok: 1, disk_sdb_ok: 0 }, status: "failed" });
    const tiles = widgets_by_type(rows_of(plugin), "repeat").find((panel) => panel.container === "tiles")!;
    expect(tiles.items.map((item) => [item.label, item.state])).toEqual([["sda", "online"], ["sdb", "failed"]]);
  });

  it("fill against the largest item and follow it on each refresh", () => {
    const plugin = probe();
    apply(plugin, { metrics: { size_a_gb: 2, size_b_gb: 8 }, status: "online" });
    const sizes = () => widgets_by_type(rows_of(plugin), "repeat").find((panel) => panel.title === "SIZES")!.items.map((item) => item.percent);
    expect(sizes()).toEqual([25, 100]);
    apply(plugin, { metrics: { size_a_gb: 16, size_b_gb: 8 }, status: "online" });
    expect(sizes()).toEqual([100, 50]);
  });
});

describe("a series chart", () => {
  it("draws every series on the first one's timestamps", () => {
    const plugin = probe();
    for (const [one, five] of [[0.5, 0.4], [0.7, 0.45]]) apply(plugin, { metrics: { load_1: one, load_5: five }, status: "online" });
    const [chart] = widgets_by_type(rows_of(plugin), "chart");
    expect(chart.series).toEqual([{ label: "1m", values: [0.5, 0.7] }, { label: "5m", values: [0.4, 0.45] }]);
    expect(chart.times).toHaveLength(2);
  });

  it("hangs a mirror chart's second series below the axis", () => {
    const plugin = make_plugin(SpecPlugin, { name: "net", id: "net" });
    apply(plugin, { metrics: { down: 5, up: 2 } });
    const spec: UISpec = { layout: [["traffic"]], charts: { traffic: { title: "TRAFFIC", style: "mirror", series: [{ metric: "down" }, { metric: "up" }] } } };
    const layout = spec_layout(plugin, spec.layout!);
    build_spec(plugin, { spec, layout });
    expect(widgets_by_type(layout.rows, "chart")[0].series.map((series) => series.values)).toEqual([[5], [-2]]);
  });
});
