import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Md } from "../../src/monitors/md.ts";
import type { ItemColorRule, ItemFormatter } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const mdstat_clean = `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0]
      1953382464 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`;

const mdstat_degraded = `Personalities : [raid1]
md0 : active raid1 sda1[0]
      1953382464 blocks super 1.2 [2/1] [U_]

unused devices: <none>
`;

const mdstat_recovering = `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0]
      1953382464 blocks super 1.2 [2/2] [UU]
      [====>................]  recovery = 22.6% (442k/1953k) finish=30.0min speed=100000K/sec

unused devices: <none>
`;

const mdstat_empty = `Personalities :
unused devices: <none>
`;

const mdstat_two_arrays = `Personalities : [raid1] [raid6] [raid5] [raid4]
md1 : active raid5 sdd1[2] sdc1[1] sdb2[0]
      3906764800 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]
      [========>............]  resync = 42.0% (820k/1953k) finish=60.0min speed=100000K/sec

md0 : active raid1 sdb1[1] sda1[0]
      1953382464 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`;

const mdstat_degraded_recovering = `Personalities : [raid1]
md0 : active raid1 sdc1[2] sda1[0]
      1953382464 blocks super 1.2 [2/1] [U_]
      [==>..................]  recovery = 12.5% (244k/1953k) finish=90.0min speed=100000K/sec

unused devices: <none>
`;

const md = (): Md => make_plugin(Md, { name: "test-md", id: "test-md", ssh_config: { host: "test.host" } });
const run = (plugin: Md, body: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, body, stderr));
const latest_status = (plugin: Md) => store_of(plugin).latest_status("test-md");
const latest_metric = (plugin: Md, name: string) => store_of(plugin).latest_metric("test-md", name)?.value ?? null;
const tiles = (plugin: Md) => plugin.UI_SPEC.cards!.md_array_tiles.repeat!;

describe("collection", () => {
  it("calls clean arrays online", () => {
    const plugin = md();
    run(plugin, mdstat_clean);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "arrays_total")).toBeCloseTo(1.0);
    expect(latest_metric(plugin, "arrays_ok")).toBeCloseTo(1.0);
    expect(latest_metric(plugin, "arrays_degraded")).toBeCloseTo(0.0);
  });

  it("fails a degraded array", () => {
    const plugin = md();
    run(plugin, mdstat_degraded);
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "arrays_degraded")).toBeCloseTo(1.0);
  });

  it("warns on a rebuilding array", () => {
    const plugin = md();
    run(plugin, mdstat_recovering);
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "arrays_ok")).toBeCloseTo(1.0);
  });

  it("calls a host with no arrays unavailable", () => {
    const plugin = md();
    run(plugin, mdstat_empty);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreadable mdstat unavailable", () => {
    const plugin = md();
    run(plugin, "", 1, "no such file");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("contributes its cards", () => {
    expect(new Set(Object.keys(md().UI_SPEC.cards!))).toEqual(new Set(["md_total_card", "md_degraded_card", "md_array_tiles"]));
  });

  it("shares one bar between clean and degraded arrays", () => {
    const health = md().UI_SPEC.cards!.md_degraded_card;
    expect(health.kind).toBe("share");
    expect(health.parts!.map((part) => [part.metric, part.color])).toEqual([["arrays_ok", "online"], ["arrays_degraded", "failed"]]);
  });
});

describe("array tiles", () => {
  it("records a clean array with its level", () => {
    expect(md().parse([cmd_result(0, mdstat_clean, "")]).snapshot).toEqual([{ label: "md0", level: "raid1", state: "clean", action: null, progress: null }]);
  });

  it("records a resyncing array's progress", () => {
    expect(md().parse([cmd_result(0, mdstat_two_arrays, "")]).snapshot).toEqual([
      { label: "md1", level: "raid5", state: "resyncing", action: "resync", progress: 42.0 },
      { label: "md0", level: "raid1", state: "clean", action: null, progress: null },
    ]);
  });

  it("keeps a degraded array's rebuild progress", () => {
    const result = md().parse([cmd_result(0, mdstat_degraded_recovering, "")]);
    expect(result.snapshot).toEqual([{ label: "md0", level: "raid1", state: "degraded", action: "recovery", progress: 12.5 }]);
    expect(result.status).toBe("failed");
  });

  it("reads the level of an auto-read-only array", () => {
    const mdstat = mdstat_clean.replace("active raid1", "active (auto-read-only) raid1");
    expect((md().parse([cmd_result(0, mdstat, "")]).snapshot as { level: string }[])[0].level).toBe("raid1");
  });

  it("clears the tiles when there are no arrays", () => expect(md().parse([cmd_result(0, mdstat_empty, "")]).snapshot).toEqual([]));

  it("puts the tiles on their own row", () => {
    const plugin = md();
    expect(plugin.UI_SPEC.layout).toContainEqual(["md_array_tiles"]);
    expect(plugin.card_row()).not.toContain("md_array_tiles");
  });

  it("repeats the tiles over the snapshot", () => {
    const repeat = tiles(md());
    expect(repeat.source).toBe("snapshot");
    expect(repeat.container).toBe("tiles");
  });

  it.each([
    [{ level: "raid1", state: "clean", action: null, progress: null }, "raid1 · clean"],
    [{ level: "raid5", state: "resyncing", action: "resync", progress: 42.0 }, "raid5 · resync 42%"],
    [{ level: "raid1", state: "degraded", action: null, progress: null }, "raid1 · degraded"],
    [{ level: "raid1", state: "degraded", action: "recovery", progress: 12.5 }, "raid1 · degraded · recovery 12%"],
    [{ level: null, state: "clean", action: null, progress: null }, "clean"],
  ])("captions %o as %s", (item, caption) => {
    expect((tiles(md()).item_format_fn as ItemFormatter)(item)).toBe(caption);
  });

  it.each([["clean", "online"], ["resyncing", "warning"], ["degraded", "failed"]])("colors a %s tile %s", (state, color) => {
    expect((tiles(md()).item_color_by as ItemColorRule)({ state })).toBe(color);
  });
});
