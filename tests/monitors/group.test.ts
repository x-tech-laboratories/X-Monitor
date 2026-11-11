import { describe, expect, it } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { child_cell_style, expanded, make_inline_layout, toggle_expanded } from "../../src/monitors/base/child_cards.ts";
import type { Plugin } from "../../src/monitors/base/plugin_base.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { aggregate_status, BEST, Group, parse_aggregate, parse_ref, QUORUM, spec_with_titles, WORST, type CompositeView, type GroupView } from "../../src/monitors/group.ts";
import { Load } from "../../src/monitors/load.ts";
import { SystemdService } from "../../src/monitors/systemd_service.ts";
import type { UISpec } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_requests, store_of, type FakeEngine } from "../harness.ts";

const group_config: PluginConfig = { name: "test-group", id: "test-group", type: "group", interval: 60 };

const group = (extra: PluginConfig = {}, db = new DatabaseManager()): Group => make_plugin(Group, { ...group_config, ...extra }, db);

// A child monitor sharing the group's store, with a status recorded unless `status` is null.
function child(parent: Plugin, id: string, status: string | null): Load {
  const db = store_of(parent);
  if (status !== null) db.insert_status(id, status);
  return make_plugin(Load, { name: `Child ${id}`, id }, db);
}

function with_children(parent: Group, statuses: Record<string, string | null>): Group {
  parent.children = Object.entries(statuses).map(([id, status]) => child(parent, id, status));
  return parent;
}

const aggregated = (parent: Group) => parent.aggregate_children()[0];

describe("status aggregation", () => {
  it("calls all online children online", () => expect(aggregated(with_children(group(), { a: "online", b: "online" }))).toBe("online"));
  it("fails on one failed child", () => expect(aggregated(with_children(group(), { a: "online", b: "failed" }))).toBe("failed"));
  it("ranks failed above warning", () => expect(aggregated(with_children(group(), { a: "warning", b: "failed" }))).toBe("failed"));
  it("ranks warning above online", () => expect(aggregated(with_children(group(), { a: "online", b: "warning" }))).toBe("warning"));
  it("ranks warning above unavailable", () => expect(aggregated(with_children(group(), { a: "unavailable", b: "warning" }))).toBe("warning"));
  it("calls no children online", () => expect(aggregated(group())).toBe("online"));
  it("counts a child with no history as unavailable", () => expect(aggregated(with_children(group(), { "never-polled": null }))).toBe("unavailable"));
  it("calls online and unavailable children unavailable", () => expect(aggregated(with_children(group(), { a: "online", b: "unavailable" }))).toBe("unavailable"));
  it("calls all failed children failed", () => expect(aggregated(with_children(group(), { a: "failed", b: "failed" }))).toBe("failed"));
});

describe("aggregate setting", () => {
  it("defaults to worst", () => expect(parse_aggregate(null)).toEqual([WORST, 0]));

  it("reads best and quorum", () => {
    expect(parse_aggregate("best")).toEqual([BEST, 0]);
    expect(parse_aggregate({ quorum: 2 })).toEqual([QUORUM, 2]);
  });

  it.each(["any", { quorum: 0 }, { quorum: "two" }, { quorum: 2, of: 3 }])("falls back to worst for %j", (value) => expect(parse_aggregate(value)).toEqual([WORST, 0]));

  it("restates its children only when worst", () => {
    expect(group().restates_children).toBe(true);
    expect(group({ aggregate: "best" }).restates_children).toBe(false);
  });
});

describe("aggregate rules", () => {
  it("takes the healthiest child for best", () => {
    expect(aggregate_status(BEST, 0, ["failed", "online"])).toEqual(["online", null]);
    expect(aggregate_status(BEST, 0, ["failed", "unavailable"])).toEqual(["unavailable", null]);
  });

  it("calls best with no children online", () => expect(aggregate_status(BEST, 0, [])).toEqual(["online", null]));

  it("stays online with a quorum met despite a failed child", () => expect(aggregate_status(QUORUM, 2, ["online", "info", "failed"])).toEqual(["online", null]));

  it("takes the worst unhealthy child and says why when the quorum is lost", () => {
    expect(aggregate_status(QUORUM, 2, ["online", "unavailable", "failed"])).toEqual(["failed", "1 of 3 healthy, quorum is 2"]);
  });

  it("logs a lost quorum with the status", () => {
    const parent = with_children(group({ aggregate: { quorum: 2 } }), { a: "online", b: "warning" });
    const result = run_requests(parent);
    expect(store_of(parent).latest_status("test-group")).toBe("warning");
    expect(result.logs[0][0]).toBe("1 of 2 healthy, quorum is 2");
  });
});

describe("collection", () => {
  it("writes the aggregated status", () => {
    const parent = with_children(group(), { "child-x": "online" });
    run_requests(parent);
    expect(store_of(parent).latest_status("test-group")).toBe("online");
  });

  it("passes a failed child on to the group", () => {
    const parent = with_children(group(), { "child-ok": "online", "child-bad": "failed" });
    run_requests(parent);
    expect(store_of(parent).latest_status("test-group")).toBe("failed");
  });

  it("plans no action", () => expect(group().plan_action("restart")).toBeNull());
});

describe("poll now", () => {
  it("polls its children before itself", async () => {
    const parent = group();
    const order: string[] = [];
    parent.children = ["a", "b"].map((id) => {
      const leaf = child(parent, id, null);
      leaf.run_cycle = async () => (order.push(id), true);
      return leaf;
    });
    (parent.engine as FakeEngine).run_cycle_now = async () => (order.push("group"), true);
    expect(await parent.run_cycle()).toBe(true);
    expect(order.at(-1)).toBe("group");
    expect(order.slice(0, -1).sort()).toEqual(["a", "b"]);
  });

  it("polls a nested group's own children", async () => {
    const outer = group();
    const inner = make_plugin(Group, { ...group_config, id: "inner", name: "inner" }, store_of(outer));
    const polled: string[] = [];
    const leaf = child(outer, "leaf", null);
    leaf.run_cycle = async () => (polled.push("leaf"), true);
    inner.children = [leaf];
    outer.children = [inner];
    const cycle = async (plugin: unknown) => (polled.push((plugin as Plugin).id), true);
    (outer.engine as FakeEngine).run_cycle_now = cycle as unknown as FakeEngine["run_cycle_now"];
    inner.engine = outer.engine;
    await outer.run_cycle();
    expect(polled).toEqual(["leaf", "inner", "test-group"]);
  });

  it("goes on when a child throws", async () => {
    const parent = group();
    const broken = child(parent, "broken", null);
    broken.run_cycle = async () => {
      throw new Error("boom");
    };
    parent.children = [broken];
    expect(await parent.run_cycle()).toBe(true);
  });
});

describe("spec with titles", () => {
  const spec: UISpec = {
    cards: { cpu_card: { metric: "cpu", title: "CPU" } },
    chart: { metric: "cpu", title: "CPU HISTORY" },
    charts: { mem_chart: { metric: "mem", title: "MEMORY" } },
  };

  it("overrides a card title", () => expect(spec_with_titles(spec, { cpu_card: "RAGNAROK CPU" })!.cards!.cpu_card.title).toBe("RAGNAROK CPU"));

  it("overrides a chart title", () => {
    const patched = spec_with_titles(spec, { chart: "A", mem_chart: "B" })!;
    expect(patched.chart!.title).toBe("A");
    expect(patched.charts!.mem_chart.title).toBe("B");
  });

  it("leaves the plugin's own spec untouched", () => {
    spec_with_titles(spec, { cpu_card: "RAGNAROK CPU", chart: "A" });
    expect(spec.cards!.cpu_card.title).toBe("CPU");
    expect(spec.chart!.title).toBe("CPU HISTORY");
  });

  it("returns the spec itself when nothing is overridden", () => expect(spec_with_titles(spec, {})).toBe(spec));
});

describe("composite layout", () => {
  it("splits a ref into child and widget", () => expect(parse_ref("a.status_card")).toEqual(["a", "status_card"]));
  it("keeps a dotted child id's dots", () => expect(parse_ref("host.lan.cpu_card")).toEqual(["host.lan", "cpu_card"]));
  it("reads a bare ref as a whole child", () => expect(parse_ref("a")).toEqual(["a", null]));

  it("walks nested groups depth first", () => {
    const outer = group({ name: "Outer", id: "outer" });
    const inner = make_plugin(Group, { name: "Inner", id: "inner", type: "group" }, store_of(outer));
    inner.children = [child(outer, "b", null)];
    outer.children = [inner, child(outer, "a", null)];
    expect(outer.descendants().map((plugin) => plugin.id)).toEqual(["inner", "b", "a"]);
  });

  function composite(layout: unknown): CompositeView {
    const parent = group({ name: "G", id: "g", layout });
    parent.children = [child(parent, "a", "failed"), child(parent, "b", null)];
    return parent.custom_view().data as CompositeView;
  }

  it("places widgets of two children in declared rows", () => {
    const view = composite([["a.load_1m_card", "b.load_1m_card"], ["a.load_chart"]]);
    expect(view.mode).toBe("composite");
    expect(view.children.map((each) => [each.id, Object.keys(each.widgets)])).toEqual([["a", ["load_1m_card", "load_chart"]], ["b", ["load_1m_card"]]]);
    expect(view.unclaimed).toEqual([]);
  });

  it("carries a title override for a child's card", () => {
    const view = composite([[{ widget: "a.load_1m_card", title: "NODE A LOAD" }]]);
    expect(view.children[0].titles).toEqual({ load_1m_card: "NODE A LOAD" });
  });

  it("places a bare ref as the whole child under its title", () => {
    const view = composite([[{ widget: "a", title: "Node A" }]]);
    expect(view.children[0].whole!.title).toBe("Node A");
  });

  it("shows the child's live state in the status pseudo-widget", () => {
    const view = composite([["a.status"]]);
    expect(view.children[0].status_widget).toMatchObject({ title: "CHILD A", state: "failed" });
  });

  it("reports a ref nothing fills and ignores a hidden one", () => {
    expect(composite([["c.cpu_card", { widget: "d.cpu_card", visible: false }]]).unclaimed).toEqual(["c.cpu_card"]);
  });

  it("leaves the widgets of a child with its own page unclaimed", () => {
    const parent = group({ name: "G", id: "g", layout: [["svc.status_card"]] });
    parent.children = [make_plugin(SystemdService, { name: "svc", id: "svc", service_name: "x.service" }, store_of(parent))];
    expect((parent.custom_view().data as CompositeView).unclaimed).toEqual(["svc.status_card"]);
  });
});

describe("child cards", () => {
  it("spans a child's columns at the parent's minimum width", () => {
    expect(child_cell_style({ grid_col_span: 2 }, "320px")).toBe("flex: 2 1 calc(2 * 320px); min-width: 320px;");
  });

  it("adds a scrollbar for a child height", () => {
    expect(child_cell_style({ grid_height: "400px" }, "320px").endsWith(" height: 400px; overflow-y: auto;")).toBe(true);
  });

  it("draws one card per child without a layout", () => {
    const parent = with_children(group({ grid_min_width: "300px" }), { a: "warning", b: null });
    parent.links.set("b", "Linked B");
    const view = parent.custom_view().data as GroupView;
    expect(view.mode).toBe("cards");
    if (view.mode !== "cards") return;
    expect(view.min_card_width).toBe("300px");
    expect(view.cards.map((card) => [card.id, card.label, card.status, card.open, card.view])).toEqual([["a", "Child a", "warning", false, "spec"], ["b", "Linked B", "unavailable", false, "spec"]]);
  });

  it("keeps which cards are open as a setting", () => {
    const parent = with_children(group(), { a: "online" });
    expect(toggle_expanded(parent, "a")).toBe(true);
    expect(store_of(parent).get_setting("group_expanded_test-group")).toBe('{"a":true}');
    expect(expanded(parent)).toEqual({ a: true });
  });

  it("hides the host card and logs inline", () => {
    expect(make_inline_layout([["host_card", "cpu_card"], [{ widget: "logs", flex: 2 }]])).toEqual([[{ widget: "host_card", visible: false }, "cpu_card"], [{ widget: "logs", flex: 2, visible: false }]]);
  });
});
