import { describe, expect, it } from "vitest";

import { builtin_monitor_types } from "../../src/monitors/index.ts";
import { monitor_page_view } from "../../src/server/views/monitor.ts";
import { make_plugin } from "../harness.ts";

// The path to every function in a view, which the page could not receive as JSON.
function functions_in(value: unknown, path = "view"): string[] {
  if (typeof value === "function") return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => functions_in(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => functions_in(item, `${path}.${key}`));
  return [];
}

describe("every built-in monitor type", () => {
  it.each(Object.keys(builtin_monitor_types))("builds its page as plain JSON with an empty store: %s", async (type) => {
    const plugin = make_plugin(await builtin_monitor_types[type](), { name: type, id: type, type });
    const view = monitor_page_view({ notifications: null }, plugin);
    expect(functions_in(view)).toEqual([]);
    expect(view.id).toBe(type);
  });
});
