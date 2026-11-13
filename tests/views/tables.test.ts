import { describe, expect, it } from "vitest";

import { table_view } from "../../src/server/views/components.ts";
import { run_cell_toggle, run_page_action } from "../../src/server/views/monitor.ts";
import { row_params, substitute, title_words, toggle_position } from "../../src/shared/page_view.ts";
import type { TableSpec } from "../../src/shared/ui_spec.ts";
import { make_plugin } from "../harness.ts";
import { SpecPlugin } from "./helpers.ts";

const TREE_ROWS = [
  { id: 1, parent: null, name: "init", cpu: 9 },
  { id: 2, parent: 1, name: "shell", cpu: 1 },
];

const FEED = [
  { timestamp: "10:00:02", message: "disk full" },
  { timestamp: "10:00:01", message: "started" },
  { timestamp: "10:00:01", message: "started" },
];

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
