import { describe, expect, it } from "vitest";

import { CollectResult } from "../../src/core/connectors/types.ts";
import { Cpu } from "../../src/monitors/cpu.ts";
import { form_field, form_options, table_view } from "../../src/server/views/components.ts";
import { build_spec, card_color_rule, spec_layout } from "../../src/server/views/spec.ts";
import { form_values, substitute } from "../../src/shared/page_view.ts";
import { COLOR_RULES } from "../../src/shared/ui_registry.ts";
import type { UISpec } from "../../src/shared/ui_spec.ts";
import { make_plugin, store_of } from "../harness.ts";
import { apply, SpecPlugin, widgets_by_type } from "./helpers.ts";

// ── Colour rules ─────────────────────────────────────────────────────────────

describe("a card's inline thresholds", () => {
  it("build the banded rule", () => {
    const rule = card_color_rule({ color: { warning: 70, threshold: 85 } }, "cpu_card")!;
    expect(rule(50)).toBe("online");
    expect(rule(70)).toBe("warning");
    expect(rule(85)).toBe("failed");
    expect(rule(null)).toBeNull();
  });

  it("name the card when a bound is missing", () => {
    expect(() => card_color_rule({ color: { warning: 70 } }, "cpu_card")).toThrow(/cpu_card/);
  });
});

describe("named and function colour rules", () => {
  it("resolve a registered name to its rule", () => {
    expect(card_color_rule({ color: "nonzero_failed" }, "errors_card")).toBe(COLOR_RULES.nonzero_failed);
  });

  it("use a function as the rule", () => {
    const mine = () => "warning" as const;
    expect(card_color_rule({ color: mine }, "own_card")).toBe(mine);
  });

  it("reject an unknown name", () => {
    expect(() => card_color_rule({ color: "no_such_rule" }, "own_card")).toThrow(/register_color_rule/);
  });

  it("give no rule without a colour", () => {
    expect(card_color_rule({ metric: "cpu_pct" }, "cpu_card")).toBeNull();
  });

  it("map a one-zero verdict onto online and failed", () => {
    const rule = COLOR_RULES.zero_failed;
    expect(rule(1)).toBe("online");
    expect(rule(0)).toBe("failed");
    expect(rule(null)).toBeNull();
  });
});

// ── Building cards ───────────────────────────────────────────────────────────

function cpu_probe(): Cpu {
  return make_plugin(Cpu, { name: "probe", id: "probe", warning: 70, threshold: 85, ssh_config: { host: "test.host" } });
}

const metric_card_spec: UISpec = {
  layout: [["cpu_card"]],
  cards: { cpu_card: { metric: "cpu_pct", title: "CPU", format: "percent1", color: { warning: 70, threshold: 85 } } },
};

function built(plugin: Cpu | SpecPlugin, spec: UISpec) {
  const layout = spec_layout(plugin, spec.layout ?? []);
  build_spec(plugin, { spec, layout });
  return layout.rows;
}

describe("a metric card with inline thresholds", () => {
  it("shows a reading under the warning as online", () => {
    const plugin = cpu_probe();
    apply(plugin, { metrics: { cpu_pct: 12.0 }, status: "online" });
    const [card] = widgets_by_type(built(plugin, metric_card_spec), "value");
    expect(card).toMatchObject({ text: "12.0%", state: "online" });
  });

  it("shows a reading past the threshold as failed", () => {
    const plugin = cpu_probe();
    apply(plugin, { metrics: { cpu_pct: 97.5 }, status: "failed" });
    expect(widgets_by_type(built(plugin, metric_card_spec), "value")[0]).toMatchObject({ text: "97.5%", state: "failed" });
  });

  it("shows a reading between the bounds as warning", () => {
    const plugin = cpu_probe();
    apply(plugin, { metrics: { cpu_pct: 78.0 }, status: "warning" });
    expect(widgets_by_type(built(plugin, metric_card_spec), "value")[0].state).toBe("warning");
  });

  it("leaves the card uncoloured with no reading", () => {
    const [card] = widgets_by_type(built(cpu_probe(), metric_card_spec), "value");
    expect(card).toMatchObject({ text: "-- %", state: null });
  });
});

describe("the per-core bars", () => {
  const cores_spec = (plugin: Cpu): UISpec => ({ layout: [["cores"]], cards: { cores: plugin.UI_SPEC.cards!.cores } });

  it("fill each core's bar to its share", () => {
    const plugin = cpu_probe();
    apply(plugin, { metrics: { cpu_pct: 50 }, status: "online", snapshot: [{ label: "0", value: 20.0 }, { label: "1", value: 90.0 }] });
    const [panel] = widgets_by_type(built(plugin, cores_spec(plugin)), "repeat");
    expect(panel.items.map((item) => item.percent)).toEqual([20, 90]);
  });

  it("fill a busy core with the failed colour", () => {
    const plugin = cpu_probe();
    apply(plugin, { metrics: { cpu_pct: 50 }, status: "online", snapshot: [{ label: "0", value: 10.0 }, { label: "1", value: 99.0 }] });
    const [panel] = widgets_by_type(built(plugin, cores_spec(plugin)), "repeat");
    expect(panel.items.map((item) => item.state)).toEqual(["online", "failed"]);
  });

  it("draw no bars without a snapshot", () => {
    const plugin = cpu_probe();
    expect(widgets_by_type(built(plugin, cores_spec(plugin)), "repeat")[0].items).toEqual([]);
  });
});

describe("the reserved and attribute cards", () => {
  it("show the target host and an on/off status", () => {
    const plugin = make_plugin(SpecPlugin, { name: "svc", id: "svc", ui_spec: { layout: [["host_card", "status_card"]], cards: { status_card: { metric: "active" } } } });
    apply(plugin, { metrics: { active: 1 } });
    const cards = widgets_by_type(built(plugin, plugin.UI_SPEC!), "value");
    expect(cards).toEqual([
      { type: "value", title: "TARGET HOST", text: "test.host", state: null },
      { type: "value", title: "STATUS", text: "ACTIVE", state: "online" },
    ]);
  });

  it("says Checking... while the status metric is absent", () => {
    const plugin = make_plugin(SpecPlugin, { name: "svc", id: "svc" });
    const spec: UISpec = { layout: [["status_card"]], cards: { status_card: { metric: "active", title: "SERVICE STATUS" } } };
    expect(widgets_by_type(built(plugin, spec), "value")[0]).toMatchObject({ title: "SERVICE STATUS", text: "Checking...", state: null });
  });

  it("read a plugin attribute through its format and colour it by another", () => {
    const plugin = make_plugin(SpecPlugin, { name: "svc", id: "svc" }) as SpecPlugin & { state_text: string; state_color: string };
    plugin.state_text = "IDLE";
    plugin.state_color = "online";
    const spec: UISpec = { layout: [["state"]], cards: { state: { title: "STATE", value_attr: "state_text", value_format: "[{}]", color_attr: "state_color" } } };
    expect(widgets_by_type(built(plugin, spec), "value")[0]).toMatchObject({ text: "[IDLE]", state: "online" });
  });

  it("combine several metrics through an item formatter", () => {
    const plugin = make_plugin(SpecPlugin, { name: "svc", id: "svc" });
    apply(plugin, { metrics: { used: 3, total: 4 } });
    const spec: UISpec = {
      layout: [["both"]],
      cards: { both: { title: "BOTH", metrics: ["used", "total"], format_fn: (values) => `${String(values.used)} of ${String(values.total)}`, color_fn: () => "warning" } },
    };
    expect(widgets_by_type(built(plugin, spec), "value")[0]).toMatchObject({ text: "3 of 4", state: "warning" });
  });

  it("leaves out a widget the layout has no cell for", () => {
    const plugin = make_plugin(SpecPlugin, { name: "svc", id: "svc" });
    const spec: UISpec = { layout: [["a"]], cards: { a: { title: "A", value: "1" }, b: { title: "B", value: "2" } } };
    expect(widgets_by_type(built(plugin, spec), "value").map((card) => card.title)).toEqual(["A"]);
  });
});

// ── Snapshots ────────────────────────────────────────────────────────────────

describe("a plugin's latest snapshot", () => {
  it("falls back to the default when never written", () => {
    const plugin = make_plugin(SpecPlugin, { name: "probe", id: "probe" });
    expect(plugin.data.latest_snapshot([])).toEqual([]);
    expect(plugin.data.latest_snapshot()).toBeNull();
  });

  it("returns the list a collector wrote", () => {
    const plugin = make_plugin(SpecPlugin, { name: "probe", id: "probe" });
    apply(plugin, { snapshot: [{ pid: 1 }, { pid: 2 }] });
    expect(plugin.data.latest_snapshot([])).toEqual([{ pid: 1 }, { pid: 2 }]);
  });

  it("is scoped by plugin id", () => {
    const plugin = make_plugin(SpecPlugin, { name: "probe", id: "probe" });
    store_of(plugin).apply_result("host1", "someone-else", "probe", new CollectResult({ snapshot: [{ pid: 99 }] }));
    expect(plugin.data.latest_snapshot([])).toEqual([]);
  });
});

// ── Forms and templates ──────────────────────────────────────────────────────

describe("form fields", () => {
  const plugin = make_plugin(SpecPlugin, { name: "probe", id: "probe" }) as SpecPlugin & Record<string, unknown>;
  plugin.entries = { "0001": "Linux", "0003": "Windows" };
  plugin.chosen = "0003";
  plugin.profiles = ["quiet", "balanced"];

  it("offer a select over a plugin attribute with its preselected choice", () => {
    expect(form_field(plugin, { name: "entry", options_attr: "entries", default_attr: "chosen" })).toMatchObject({ type: "select", default: "0003", options: [["0001", "Linux"], ["0003", "Windows"]] });
  });

  it("fall back to the first option when the default is not one", () => {
    expect(form_field(plugin, { name: "p", options: ["a", "b"], default: "z" }).default).toBe("a");
  });

  it("make a checkbox start unticked and a text box hold its default", () => {
    expect(form_field(plugin, { name: "reboot", type: "checkbox" })).toMatchObject({ type: "checkbox", default: false });
    expect(form_field(plugin, { name: "path", default: "/etc" })).toMatchObject({ type: "text", default: "/etc" });
  });

  it("take literal options, an attribute's, or nothing for a missing attribute", () => {
    expect(form_options(null, { name: "x", options: ["a", "b"] })).toEqual(["a", "b"]);
    expect(form_options(plugin, { name: "x", options_attr: "profiles" })).toEqual(["quiet", "balanced"]);
    expect(form_options(plugin, { name: "x", options_attr: "missing" })).toEqual([]);
  });

  it("trim text and keep checkboxes as booleans", () => {
    expect(form_values({ path: "  /etc  ", reboot: true, entry: null })).toEqual({ path: "/etc", reboot: true, entry: "" });
  });
});

describe("templates", () => {
  it("fill a plugin attribute and a row field", () => {
    expect(substitute("Reboot {plugin.target} into {row[entry]}?", { entry: "x" }, { target: "host1" })).toBe("Reboot host1 into x?");
  });

  it("read a missing attribute as empty", () => {
    expect(substitute("[{plugin.nothing}]", null, {})).toBe("[]");
  });

  it("still take the item form", () => {
    expect(substitute("{plugin[target]}", null, { target: "host1" })).toBe("host1");
  });
});

// ── Callable cell colours ────────────────────────────────────────────────────

describe("a table whose column colours its cells with a function", () => {
  it("sends no function to the page and colours the cell", () => {
    const plugin = make_plugin(SpecPlugin, { name: "probe", id: "probe" }) as SpecPlugin & { rows: unknown[] };
    plugin.rows = [{ key: "a", grade: "failed" }];
    const view = table_view(plugin, { row_key: "key", rows_attr: "rows", columns: [{ name: "grade", label: "Grade", field: "grade", cell_color_by: (row) => row.grade as "failed" }] });
    expect(() => JSON.stringify(view)).not.toThrow();
    expect(JSON.parse(JSON.stringify(view.columns[0]))).not.toHaveProperty("cell_color_by");
    expect(view.rows[0]._color_grade).toBe("failed");
  });
});
