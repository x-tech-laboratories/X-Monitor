import { describe, expect, it } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { child_cell_style, set_child_open, spec_with_titles } from "../../src/server/views/group.ts";
import { CompositeLayout, resolve_rows } from "../../src/server/views/layout.ts";
import { build_body, new_context } from "../../src/server/views/monitor.ts";
import { iter_monitors } from "../../src/core/coordination/monitor_graph.ts";
import type { BodyView, WidgetView } from "../../src/shared/page_view.ts";
import type { UISpec } from "../../src/shared/ui_spec.ts";
import { make_plugin } from "../harness.ts";
import { SpecPlugin } from "./helpers.ts";

// A monitor laid out as the uptime monitor is.
const UPTIME_SPEC: UISpec = {
  layout: [["host_card", "status_card", "latency_card"], ["uptime_strip"], ["chart"], ["events"]],
  cards: {
    status_card: { metric: "up", title: "CURRENT STATUS", on_text: "ONLINE", off_text: "OFFLINE" },
    latency_card: { metric: "latency_ms", title: "LAST LATENCY", format: "seconds_ms" },
    uptime_strip: { kind: "strip", metric: "up", title: "AVAILABILITY" },
  },
  chart: { metric: "latency_ms", title: "RESPONSE TIME HISTORY (ms)" },
  events: true,
};

function uptime(id: string, name: string, db: DatabaseManager): SpecPlugin {
  return make_plugin(SpecPlugin, { name, id, type: "uptime", ui_spec: UPTIME_SPEC }, db);
}

// Every title and value a body shows in its visible cells, in layout order, as a reader would meet them.
function titles(body: BodyView, with_values = false): string[] {
  const of_widget = (widget: WidgetView): string[] => {
    if (widget.type === "body") return titles(widget.body, with_values);
    if (widget.type === "value") return with_values ? [widget.title, widget.text] : [widget.title];
    return "title" in widget && widget.title ? [widget.title] : [];
  };
  return body.rows.flatMap((row) => row.cells.filter((cell) => cell.visible).flatMap((cell) => cell.content.flatMap(of_widget)));
}

describe("resolving rows", () => {
  it("fills defaults for a bare widget name", () => {
    expect(resolve_rows([["chart"]], {})).toEqual([[["chart", { flex: 1, visible: true, height: null, min_width: "280px", title: null }]]]);
  });

  it("lets config overrides reach a declared widget", () => {
    const [[[, config]]] = resolve_rows([["chart"]], { chart: { height: "500px", visible: false } });
    expect(config.height).toBe("500px");
    expect(config.visible).toBe(false);
  });

  it("lets inline properties win over config overrides", () => {
    const [[[, config]]] = resolve_rows([[{ widget: "chart", flex: 3 }]], { chart: { flex: 1 } });
    expect(config.flex).toBe(3);
  });
});

describe("a composite layout", () => {
  it("splits a ref into child and widget", () => {
    const grid = new CompositeLayout([["host-a.cpu_card", "host-b.cpu_card"]]);
    expect([...grid.widgets_for("host-a").keys()]).toEqual(["cpu_card"]);
    expect([...grid.widgets_for("host-b").keys()]).toEqual(["cpu_card"]);
  });

  it("keeps the dots of a dotted child id", () => {
    expect([...new CompositeLayout([["srv.example.com.cpu_card"]]).widgets_for("srv.example.com").keys()]).toEqual(["cpu_card"]);
  });

  it("reads a bare ref as a whole child", () => {
    const grid = new CompositeLayout([["host-a"]]);
    expect(grid.hosts_child("host-a")).toBe(true);
    expect(grid.widgets_for("host-a").size).toBe(0);
  });

  it("gives a child's view only its own placed widgets", () => {
    const view = new CompositeLayout([["host-a.cpu_card"]]).view("host-a");
    expect(view.renders("cpu_card")).toBe(true);
    expect(view.renders("mem_card")).toBe(false);
  });

  it("skips a widget hidden by config", () => {
    expect(new CompositeLayout([[{ widget: "host-a.cpu_card", visible: false }]]).view("host-a").renders("cpu_card")).toBe(false);
  });

  it("reports a ref nothing filled", () => {
    const grid = new CompositeLayout([["host-a.cpu_card", "typo.cpu_card"]]);
    grid.cell("host-a.cpu_card");
    expect(grid.unclaimed()).toEqual(["typo.cpu_card"]);
  });

  it("ignores a deliberately hidden ref", () => {
    expect(new CompositeLayout([[{ widget: "host-a.cpu_card", visible: false }]]).unclaimed()).toEqual([]);
  });
});

describe("spec with titles", () => {
  const SPEC: UISpec = {
    cards: { cpu_card: { metric: "cpu", title: "CPU" } },
    chart: { metric: "cpu", title: "CPU HISTORY" },
    charts: { mem_chart: { metric: "mem", title: "MEMORY" } },
  };

  it("overrides a card title", () => {
    expect(spec_with_titles(SPEC, { cpu_card: "RAGNAROK CPU" })!.cards!.cpu_card.title).toBe("RAGNAROK CPU");
  });

  it("overrides chart titles", () => {
    const patched = spec_with_titles(SPEC, { chart: "A", mem_chart: "B" })!;
    expect(patched.chart!.title).toBe("A");
    expect(patched.charts!.mem_chart.title).toBe("B");
  });

  it("leaves the plugin's own spec untouched", () => {
    spec_with_titles(SPEC, { cpu_card: "RAGNAROK CPU", chart: "A" });
    expect(SPEC.cards!.cpu_card.title).toBe("CPU");
    expect(SPEC.chart!.title).toBe("CPU HISTORY");
  });

  it("returns the spec itself when nothing is overridden", () => {
    expect(spec_with_titles(SPEC, {})).toBe(SPEC);
  });
});

describe("descendants", () => {
  it("are walked depth first through nested groups", () => {
    const db = new DatabaseManager();
    const leaf_a = uptime("a", "A", db);
    const leaf_b = uptime("b", "B", db);
    const inner = make_plugin(SpecPlugin, { name: "Inner", id: "inner", type: "group" }, db);
    const outer = make_plugin(SpecPlugin, { name: "Outer", id: "outer", type: "group" }, db);
    inner.children = [leaf_b];
    outer.children = [inner, leaf_a];
    expect([...iter_monitors(outer.children)].map((plugin) => plugin.id)).toEqual(["inner", "b", "a"]);
  });
});

describe("a page", () => {
  it("follows its layout rows, not the build order", () => {
    const body = build_body(uptime("a", "A", new DatabaseManager()), "page", new_context());
    expect(titles(body).slice(0, 3)).toEqual(["TARGET HOST", "CURRENT STATUS", "LAST LATENCY"]);
  });
});

describe("a composite group", () => {
  function group(layout: unknown, db = new DatabaseManager()): SpecPlugin {
    const plugin = make_plugin(SpecPlugin, { name: "G", id: "g", type: "group", layout }, db);
    plugin.children = [uptime("a", "A", db), uptime("b", "B", db)];
    return plugin;
  }

  it("mixes widgets of two children in declared order", () => {
    const body = build_body(group([["a.status_card", "b.latency_card"], ["a.chart"]]), "page", new_context());
    expect(titles(body).slice(0, 3)).toEqual(["CURRENT STATUS", "LAST LATENCY", "RESPONSE TIME HISTORY (ms)"]);
  });

  it("skips every widget the layout leaves out", () => {
    const shown = titles(build_body(group([["a.status_card"]]), "page", new_context()));
    expect(shown).not.toContain("TARGET HOST");
    expect(shown).not.toContain("LAST LATENCY");
    expect(shown.filter((title) => title === "CURRENT STATUS")).toHaveLength(1);
  });

  it("renames a child's card with a title override", () => {
    const body = build_body(group([[{ widget: "a.latency_card", title: "NODE A LATENCY" }, { widget: "b.latency_card", title: "NODE B LATENCY" }]]), "page", new_context());
    expect(titles(body).slice(0, 2)).toEqual(["NODE A LATENCY", "NODE B LATENCY"]);
  });

  it("draws a bare ref as the whole child under its title", () => {
    const shown = titles(build_body(group([[{ widget: "a", title: "Node A" }]]), "page", new_context()));
    expect(shown[0]).toBe("Node A");
    expect(shown).toContain("CURRENT STATUS");
  });

  it("shows a child's live state in the status pseudo-widget", () => {
    const db = new DatabaseManager();
    db.insert_status("a", "failed");
    expect(titles(build_body(group([["a.status"]], db), "page", new_context()), true)).toEqual(["A", "FAILED"]);
  });
});

describe("child cards", () => {
  function parent(db = new DatabaseManager()): SpecPlugin {
    const plugin = make_plugin(SpecPlugin, { name: "G", id: "g", type: "group" }, db);
    plugin.children = [uptime("a", "A", db), uptime("b", "B", db)];
    return plugin;
  }

  it("are closed until opened, each with its child's state", () => {
    const db = new DatabaseManager();
    db.insert_status("b", "warning");
    const body = build_body(parent(db), "page", new_context());
    expect(body.children.map((card) => [card.id, card.label, card.state, card.open, card.body])).toEqual([["a", "A", "unavailable", false, null], ["b", "B", "warning", false, null]]);
  });

  it("draw a child's page inline once opened, and keep it open", () => {
    const plugin = parent();
    set_child_open(plugin.engine!, plugin, "b", true);
    const card = build_body(plugin, "page", new_context()).children[1];
    expect(card.open).toBe(true);
    expect(titles(card.body!)).not.toContain("TARGET HOST");
    expect(titles(card.body!)).toContain("CURRENT STATUS");
  });

  it("size their cell from the grid keys", () => {
    expect(child_cell_style({ grid_col_span: 2 }, "320px")).toBe("flex: 2 1 calc(2 * 320px); min-width: 320px;");
    expect(child_cell_style({ grid_height: "400px" }, "320px").endsWith(" height: 400px; overflow-y: auto;")).toBe(true);
  });
});
