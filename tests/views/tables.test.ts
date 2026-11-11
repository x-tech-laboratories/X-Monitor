import { describe, expect, it } from "vitest";

import { table_view } from "../../src/server/views/components.ts";
import { run_cell_toggle, run_page_action } from "../../src/server/views/monitor.ts";
import { row_params, substitute, title_words, toggle_position } from "../../src/shared/page_view.ts";
import { filter_rows, keyed_rows, next_sort_keys, sort_rows, tree_rows, type SortColumn } from "../../src/shared/table_rows.ts";
import type { TableSpec } from "../../src/shared/ui_spec.ts";
import { make_plugin } from "../harness.ts";
import { SpecPlugin } from "./helpers.ts";

const COLUMNS: SortColumn[] = [
  { name: "host", field: "host" },
  { name: "status", field: "status" },
  { name: "size", field: "size", sort_field: "size_bytes" },
  { name: "actions", field: "actions" },
];

const ROWS = [
  { host: "host10", status: "online", size: "2 KB", size_bytes: 2048 },
  { host: "host9", status: "failed", size: "900 B", size_bytes: 900 },
  { host: "host2", status: "online", size: "", size_bytes: null },
];

const hosts = (rows: { host: unknown }[]) => rows.map((row) => row.host);

// ── Row ordering ─────────────────────────────────────────────────────────────

describe("sorting rows", () => {
  it("uses the first key then the next", () => {
    expect(hosts(sort_rows(ROWS, [["status", false], ["host", true]], COLUMNS))).toEqual(["host9", "host10", "host2"]);
  });

  it("orders numbers inside text naturally", () => {
    expect(hosts(sort_rows(ROWS, [["host", false]], COLUMNS))).toEqual(["host2", "host9", "host10"]);
  });

  it("uses the raw sort field and keeps empty cells last both ways", () => {
    expect(hosts(sort_rows(ROWS, [["size", false]], COLUMNS))).toEqual(["host9", "host10", "host2"]);
    expect(hosts(sort_rows(ROWS, [["size", true]], COLUMNS))).toEqual(["host10", "host9", "host2"]);
  });

  it("copes with numbers and text in one column", () => {
    const rows = [{ v: "abc" }, { v: 3 }, { v: null }, { v: 1.5 }];
    expect(sort_rows(rows, [["v", false]], [{ name: "v", field: "v" }]).map((row) => row.v)).toEqual([1.5, 3, "abc", null]);
  });

  it("filters on every word somewhere in the fields", () => {
    expect(hosts(filter_rows(ROWS, "ONLINE host1", ["host", "status"]))).toEqual(["host10"]);
    expect(filter_rows(ROWS, "  ", ["host"])).toEqual(ROWS);
  });
});

// ── Header clicks ────────────────────────────────────────────────────────────

describe("header clicks", () => {
  it("step one column from ascending to descending to off", () => {
    let keys = next_sort_keys([], "host", false);
    expect(keys).toEqual([["host", false]]);
    keys = next_sort_keys(keys, "host", false);
    expect(keys).toEqual([["host", true]]);
    expect(next_sort_keys(keys, "host", false)).toEqual([]);
  });

  it("replace a multi-column sort on a plain click on another column", () => {
    expect(next_sort_keys([["host", false], ["status", true]], "size", false)).toEqual([["size", false]]);
  });

  it("add, flip and drop a column on shift-clicks and keep the rest", () => {
    let keys = next_sort_keys([["host", false]], "status", true);
    expect(keys).toEqual([["host", false], ["status", false]]);
    keys = next_sort_keys(keys, "status", true);
    expect(keys).toEqual([["host", false], ["status", true]]);
    expect(next_sort_keys(keys, "status", true)).toEqual([["host", false]]);
  });
});

// ── Trees ────────────────────────────────────────────────────────────────────

const TREE_COLUMNS: SortColumn[] = [{ name: "name", field: "name" }, { name: "cpu", field: "cpu" }];

const TREE_ROWS = [
  { id: 1, parent: null, name: "init", cpu: 9 },
  { id: 2, parent: 1, name: "shell", cpu: 1 },
  { id: 3, parent: 1, name: "browser", cpu: 8 },
  { id: 4, parent: 3, name: "tab", cpu: 7 },
  { id: 5, parent: 99, name: "orphan", cpu: 0 },
];

function tree(sort_keys: [string, boolean][] = [], collapsed: number[] = [], term = "") {
  return tree_rows(TREE_ROWS, "id", "parent", sort_keys, TREE_COLUMNS, new Set(collapsed), term, ["name"]).map((row) => [row.name, row._depth]);
}

describe("tree rows", () => {
  it("nest each row under its parent and make a root of one whose parent is missing", () => {
    expect(tree()).toEqual([["init", 0], ["shell", 1], ["browser", 1], ["tab", 2], ["orphan", 0]]);
  });

  it("sort siblings within their parent", () => {
    expect(tree([["cpu", true]])).toEqual([["init", 0], ["browser", 1], ["tab", 2], ["shell", 1], ["orphan", 0]]);
  });

  it("leave out what sits under a collapsed row", () => {
    const rows = tree_rows(TREE_ROWS, "id", "parent", [], TREE_COLUMNS, new Set([3]), "", ["name"]);
    expect(rows.map((row) => row.name)).toEqual(["init", "shell", "browser", "orphan"]);
    expect([rows[2]._has_children, rows[2]._expanded]).toEqual([true, false]);
    expect(rows[1]._has_children).toBe(false);
  });

  it("keep each match with its ancestors under a filter even when collapsed", () => {
    expect(tree([], [1, 3], "tab")).toEqual([["init", 0], ["browser", 1], ["tab", 2]]);
  });

  it("copy the rows they mark", () => {
    tree_rows(TREE_ROWS, "id", "parent", [], TREE_COLUMNS, new Set());
    expect(TREE_ROWS[0]).not.toHaveProperty("_depth");
  });
});

// ── Row keys ─────────────────────────────────────────────────────────────────

const FEED = [
  { timestamp: "10:00:02", message: "disk full" },
  { timestamp: "10:00:01", message: "started" },
  { timestamp: "10:00:01", message: "started" },
];

describe("keyed rows", () => {
  it("give every row without a key its own", () => {
    expect(new Set(keyed_rows(FEED, "id").map((row) => row.id)).size).toBe(3);
  });

  it("keep a row's key when newer rows push in above it", () => {
    const before = keyed_rows(FEED, "id");
    const after = keyed_rows([{ timestamp: "10:00:03", message: "cleared" }, ...FEED.slice(0, 2)], "id");
    expect(after.slice(1).map((row) => row.id)).toEqual(before.slice(0, 2).map((row) => row.id));
  });

  it("leave a row's own key alone", () => {
    expect(keyed_rows([{ id: 7, name: "cpu" }], "id")).toEqual([{ id: 7, name: "cpu" }]);
  });

  it("copy the rows they key", () => {
    keyed_rows(FEED, "id");
    expect(FEED[0]).not.toHaveProperty("id");
  });
});

// ── Spec tables ──────────────────────────────────────────────────────────────

class TablePlugin extends SpecPlugin {
  rows: Record<string, unknown>[] = [];
  ran: [string, Record<string, unknown>][] = [];
  target_state: Record<string, string> = {};
  succeeds = true;

  override async run_action(action_id: string, args: Record<string, unknown> = {}): Promise<[boolean, string]> {
    this.ran.push([action_id, args]);
    if (this.succeeds && args.service_name) this.target_state[String(args.service_name)] = action_id === "enable_service" ? "enabled" : "disabled";
    return [this.succeeds, ""];
  }

  override async run_cycle(): Promise<boolean> {
    for (const row of this.rows) row.enabled = this.target_state[String(row.unit)] ?? row.enabled;
    return true;
  }
}

const TOGGLE = { on: ["enabled"], off: ["disabled"], on_action_id: "enable_service", off_action_id: "disable_service", params: { service_name: "unit" } };

const TOGGLE_SPEC: TableSpec = {
  row_key: "unit",
  rows_attr: "rows",
  columns: [{ name: "unit", label: "Unit", field: "unit" }, { name: "enabled", label: "Enabled", field: "enabled", toggle: TOGGLE }],
};

function toggle_plugin(succeeds = true): TablePlugin {
  const plugin = make_plugin(TablePlugin, { name: "svc", id: "svc" });
  plugin.rows = [{ unit: "nginx.service", enabled: "disabled" }, { unit: "tmp.mount", enabled: "static" }];
  plugin.succeeds = succeeds;
  return plugin;
}

const row_of = (plugin: TablePlugin, unit: string) => table_view(plugin, TOGGLE_SPEC).rows.find((row) => row.unit === unit)!;

describe("a toggle column", () => {
  it("places a value on, off or neither", () => {
    expect(toggle_position(TOGGLE, "enabled")).toBe(true);
    expect(toggle_position(TOGGLE, "disabled")).toBe(false);
    expect(toggle_position(TOGGLE, "static")).toBeNull();
  });

  it("carries each row's switch position and no toggle spec of its own", () => {
    const plugin = toggle_plugin();
    const view = table_view(plugin, TOGGLE_SPEC);
    expect(() => JSON.stringify(view)).not.toThrow();
    expect(view.columns[1].toggle).toEqual({ on_action_id: "enable_service", off_action_id: "disable_service", params: { service_name: "unit" } });
    expect(row_of(plugin, "nginx.service")._toggle_enabled).toBe(false);
    expect(row_of(plugin, "tmp.mount")._toggle_enabled).toBeNull();
  });

  it("runs the action for that row on a flip and reads it back", async () => {
    const plugin = toggle_plugin();
    const reply = await run_cell_toggle(plugin, "Enabled", "nginx.service", "enable_service", row_params(TOGGLE.params, { unit: "nginx.service" }), true);
    expect(reply.notice).toBe("Enabled on: nginx.service succeeded");
    expect(plugin.ran).toEqual([["enable_service", { service_name: "nginx.service" }]]);
    expect(row_of(plugin, "nginx.service")._toggle_enabled).toBe(true);
  });

  it("leaves the switch where it was when the action fails", async () => {
    const plugin = toggle_plugin(false);
    const reply = await run_cell_toggle(plugin, "Enabled", "nginx.service", "enable_service", { service_name: "nginx.service" }, true);
    expect(reply.notice).toBe("Enabled on: nginx.service failed");
    expect(row_of(plugin, "nginx.service")._toggle_enabled).toBe(false);
  });
});

describe("row actions", () => {
  const spec: TableSpec = {
    row_key: "name",
    rows_attr: "rows",
    columns: [{ name: "name", label: "Target", field: "name" }],
    row_actions: [{ id: "build", icon: "build", tooltip: "Build", kind: "dispatch", action_id: "build", params: { target: "name" }, confirm: "Build {row[name]} now?" }],
  };

  it("carry their confirm question for the row and add a buttons column", () => {
    const plugin = make_plugin(TablePlugin, { name: "x", id: "x" });
    plugin.rows = [{ name: "Alpha" }];
    const view = table_view(plugin, spec);
    expect(view.columns.at(-1)).toMatchObject({ name: "actions", sortable: false });
    expect(substitute(view.row_actions[0].confirm!, view.rows[0])).toBe("Build Alpha now?");
  });

  it("run for that row and name the action in the notice", async () => {
    const plugin = make_plugin(TablePlugin, { name: "x", id: "x" });
    const action = table_view(plugin, spec).row_actions[0];
    const reply = await run_page_action(plugin, action.action_id, row_params(action.params, { name: "Alpha" }), title_words(action.tooltip || action.action_id));
    expect(reply.notice).toBe("Build succeeded");
    expect(plugin.ran).toEqual([["build", { target: "Alpha" }]]);
  });

  it("leave out one whose predicate says no", () => {
    const plugin = make_plugin(TablePlugin, { name: "x", id: "x" });
    const hidden: TableSpec = { ...spec, row_actions: [{ ...spec.row_actions![0], visible_if: () => false }] };
    expect(table_view(plugin, hidden).row_actions).toEqual([]);
  });
});

describe("a tree table", () => {
  it("names its parent field and draws the tree in the first column by default", () => {
    const plugin = make_plugin(TablePlugin, { name: "x", id: "x" });
    plugin.rows = TREE_ROWS;
    const view = table_view(plugin, { row_key: "id", rows_attr: "rows", columns: [{ name: "name", field: "name" }], tree: { parent_field: "parent" } });
    expect(view.tree).toEqual({ parent_field: "parent", column: "name" });
  });
});

describe("a feed table", () => {
  it("keys its rows so the page can keep them", () => {
    const plugin = make_plugin(TablePlugin, { name: "x", id: "x" });
    plugin.rows = FEED;
    const view = table_view(plugin, { rows_attr: "rows", columns: [{ name: "message", label: "Message", field: "message" }] });
    expect(view.rows.every((row) => row.id)).toBe(true);
  });
});
