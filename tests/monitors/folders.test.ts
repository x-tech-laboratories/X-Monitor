import { describe, expect, it } from "vitest";

import { cmd_result, type CmdResult } from "../../src/core/connectors/types.ts";
import { Folders } from "../../src/monitors/folders.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const gigabyte = 1024 ** 3;

const folders = (extra: PluginConfig = {}): Folders => make_plugin(Folders, { name: "test-folders", id: "test-folders", ssh_config: { host: "test.host" }, ...extra });
const latest_status = (plugin: Folders) => store_of(plugin).latest_status("test-folders");
const latest_metric = (plugin: Folders, name: string) => store_of(plugin).latest_metric("test-folders", name)?.value ?? null;
const in_turn = (outputs: CmdResult[]) => () => outputs.shift()!;

describe("collection", () => {
  it("calls folders under their limits online", () => {
    const plugin = folders({ folders: [{ path: "/var/log", warning: 5, threshold: 10 }] });
    run_cycle(plugin, () => cmd_result(0, `${2 * gigabyte}\t/var/log`, ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "folder_var_log_gb")).toBeCloseTo(2.0);
  });

  it("warns past the warning", () => {
    const plugin = folders({ folders: [{ path: "/data", warning: 5, threshold: 10 }] });
    run_cycle(plugin, () => cmd_result(0, `${7 * gigabyte}\t/data`, ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails past the threshold", () => {
    const plugin = folders({ folders: [{ path: "/data", warning: 5, threshold: 10 }] });
    run_cycle(plugin, () => cmd_result(0, `${12 * gigabyte}\t/data`, ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("takes the worst across folders", () => {
    const plugin = folders({ folders: [{ path: "/a", warning: 5, threshold: 10 }, { path: "/b", warning: 5, threshold: 10 }] });
    run_cycle(plugin, in_turn([cmd_result(0, `${2 * gigabyte}\t/a`, ""), cmd_result(0, `${12 * gigabyte}\t/b`, "")]));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("stays online for a size-only folder", () => {
    const plugin = folders({ folders: [{ path: "/media" }] });
    run_cycle(plugin, () => cmd_result(0, `${999 * gigabyte}\t/media`, ""));
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls a du timeout unavailable", () => {
    const plugin = folders({ folders: [{ path: "/huge" }], timeout: 1 });
    run_cycle(plugin, () => cmd_result(124, "", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a missing folder unavailable", () => {
    const plugin = folders({ folders: [{ path: "/nope" }] });
    run_cycle(plugin, () => cmd_result(1, "", "du: cannot access"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("ranks a measured breach above an unmeasured folder", () => {
    const plugin = folders({ folders: [{ path: "/a", warning: 5, threshold: 10 }, { path: "/b" }] });
    run_cycle(plugin, in_turn([cmd_result(0, `${12 * gigabyte}\t/a`, ""), cmd_result(1, "", "du: cannot access")]));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls no folders unavailable", () => {
    const plugin = folders();
    run_cycle(plugin, () => cmd_result(0, "", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("actions", () => {
  it("plans no action", () => {
    expect(folders({ folders: [{ path: "/x" }] }).plan_action("anything")).toBeNull();
  });
});

describe("page", () => {
  it("fills folder meters against the largest folder", () => {
    const plugin = folders({ folders: [{ path: "/a" }, { path: "/b" }] });
    const repeat = plugin.UI_SPEC.cards!.folders.repeat!;
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_max).toBe("largest");
    expect(repeat.item_color_by).toBe(plugin.item_color);
  });

  it("drops the largest card the meters make redundant", () => {
    const spec = folders({ folders: [{ path: "/a" }] }).UI_SPEC;
    expect("worst_card" in spec.cards!).toBe(false);
    expect(spec.layout!.flat()).not.toContain("worst_card");
  });

  it("colors a folder's meter by its own limits", () => {
    const plugin = folders({ folders: [{ path: "/a", warning: 5, threshold: 10 }] });
    expect(plugin.item_color({ key: "a", value: 7 })).toBe("warning");
    expect(plugin.item_color({ key: "b", value: 70 })).toBe("online");
  });
});
