import { describe, expect, it } from "vitest";

import { metric_family_items, scan_metric_family } from "../../../src/monitors/base/metric_family.ts";

const records = [
  { metric_name: "fs_root_used_pct", value: 40 },
  { metric_name: "fs_home_used_pct", value: 20 },
  { metric_name: "fs_home_inodes_pct", value: 5 },
  { metric_name: "worst_used_pct", value: 40 },
];

describe("scan metric family", () => {
  it("strips the prefix and suffix from each match", () => {
    expect(scan_metric_family(records, "fs_", "_used_pct")).toEqual(new Map([["root", 40], ["home", 20]]));
  });

  it("leaves out excluded names", () => {
    expect(scan_metric_family(records, "", "_used_pct", new Set(["worst_used_pct"])).has("worst")).toBe(false);
  });
});

describe("metric family items", () => {
  it("merges several families into one item per key, sorted", () => {
    const items = metric_family_items(records, { fields: [{ name: "used_pct", prefix: "fs_", suffix: "_used_pct" }, { name: "inodes_pct", prefix: "fs_", suffix: "_inodes_pct" }] });
    expect(items).toEqual([{ key: "home", used_pct: 20, inodes_pct: 5 }, { key: "root", used_pct: 40 }]);
  });

  it("reads one family as key and value", () => {
    expect(metric_family_items(records, { metrics_prefix: "fs_", metrics_suffix: "_inodes_pct" })).toEqual([{ key: "home", value: 5 }]);
  });
});
