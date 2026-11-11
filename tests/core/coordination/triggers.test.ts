import { describe, expect, it } from "vitest";

import { CollectResult } from "../../../src/core/connectors/types.ts";
import { parse_triggers } from "../../../src/core/coordination/triggers.ts";

const one = (entry: Record<string, unknown>) => parse_triggers([{ action: "switch", ...entry }])[0];

describe("parsing", () => {
  it("reads nothing configured as no triggers", () => {
    expect(parse_triggers(null)).toEqual([]);
  });

  it("reads a status entry", () => {
    const entry = one({ status: ["warning", "failed"], for: "5m", args: { kind: "data" } });
    expect(entry.condition.statuses).toEqual(new Set(["warning", "failed"]));
    expect([entry.hold, entry.args]).toEqual([300, { kind: "data" }]);
    expect(entry.describe()).toBe("when status is failed or warning for 5 Minutes");
  });

  it("needs no list for a single status", () => {
    expect(one({ status: "failed" }).condition.statuses).toEqual(new Set(["failed"]));
  });

  it("reads a metric entry", () => {
    expect(one({ metric: "up_to_date", below: 1 }).describe()).toBe("when up_to_date < 1");
  });

  it.each([
    [{}, "exactly one of `status` or `metric`"],
    [{ status: "failed", metric: "x", above: 1 }, "exactly one of `status` or `metric`"],
    [{ status: "broken" }, "unknown status 'broken'"],
    [{ status: [] }, "at least one status"],
    [{ metric: "x" }, "exactly one of `above`, `below` or `equals`"],
    [{ metric: "x", above: 1, below: 2 }, "exactly one of `above`, `below` or `equals`"],
    [{ metric: "x", above: "lots" }, "must be a number"],
    [{ status: "failed", args: ["x"] }, "`args`"],
  ])("rejects the malformed entry %j", (entry, message) => {
    expect(() => one(entry)).toThrow(message);
  });

  it("rejects an entry without an action", () => {
    expect(() => parse_triggers([{ status: "failed" }])).toThrow("needs an `action`");
  });

  it("gives a changed condition a new state key", () => {
    expect(one({ status: "failed" }).state_key("m")).not.toBe(one({ status: "warning" }).state_key("m"));
  });
});

describe("conditions", () => {
  it("holds a status only for a listed one", () => {
    const condition = one({ status: ["failed"] }).condition;
    expect(condition.holds(new CollectResult({ status: "failed" }))).toBe(true);
    expect(condition.holds(new CollectResult({ status: "online" }))).toBe(false);
  });

  it("does not know about a cycle without a status", () => {
    expect(one({ status: ["failed"] }).condition.holds(new CollectResult())).toBeNull();
  });

  it.each([
    ["above", 91, true], ["above", 90, false],
    ["below", 0, true], ["below", 1, false],
    ["equals", 1, true], ["equals", 2, false],
  ] as const)("compares a metric %s with %d as %s", (comparison, value, expected) => {
    const limit = { above: 90, below: 1, equals: 1 }[comparison];
    const condition = one({ metric: "m", [comparison]: limit }).condition;
    expect(condition.holds(new CollectResult({ metrics: { m: value } }))).toBe(expected);
  });

  it("does not know about a cycle without the metric", () => {
    expect(one({ metric: "m", above: 1 }).condition.holds(new CollectResult({ metrics: { other: 5 } }))).toBeNull();
  });
});

describe("deciding", () => {
  it("runs at once without a hold", () => {
    expect(one({ status: "failed" }).step({}, true, 100)).toEqual([{ since: 100, fired: true }, true]);
  });

  it("runs once per episode", () => {
    const entry = one({ status: "failed" });
    const [state] = entry.step({}, true, 100);
    expect(entry.step(state, true, 200)).toEqual([state, false]);
  });

  it("waits out the hold", () => {
    const entry = one({ status: "failed", for: 60 });
    let [state, fire] = entry.step({}, true, 100);
    expect(fire).toBe(false);
    [state, fire] = entry.step(state, true, 159);
    expect(fire).toBe(false);
    expect(entry.step(state, true, 160)).toEqual([{ since: 100, fired: true }, true]);
  });

  it("re-arms once it clears", () => {
    const entry = one({ status: "failed" });
    let [state] = entry.step({}, true, 100);
    [state] = entry.step(state, false, 200);
    expect(state).toEqual({});
    expect(entry.step(state, true, 300)[1]).toBe(true);
  });

  it("restarts the hold when it clears during it", () => {
    const entry = one({ status: "failed", for: 60 });
    let [state] = entry.step({}, true, 100);
    [state] = entry.step(state, false, 130);
    const [next, fire] = entry.step(state, true, 140);
    expect(fire).toBe(false);
    expect(next.since).toBe(140);
  });

  it("changes nothing on a cycle that does not know", () => {
    const state = { since: 100, fired: false };
    expect(one({ status: "failed" }).step(state, null, 999)).toEqual([state, false]);
  });
});
