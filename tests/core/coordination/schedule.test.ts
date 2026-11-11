import { describe, expect, it } from "vitest";

import { CronSchedule, parse_schedule, ScheduledAction } from "../../../src/core/coordination/schedule.ts";

const at = (...parts: number[]): Date => new Date(parts[0], parts[1] - 1, parts[2] ?? 1, parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);

describe("cron expressions", () => {
  it("runs a daily time next at that time", () => {
    const cron = CronSchedule.parse("30 2 * * *");
    expect(cron.next_after(at(2026, 10, 21, 1, 0))).toEqual(at(2026, 10, 21, 2, 30));
    expect(cron.next_after(at(2026, 10, 21, 2, 30))).toEqual(at(2026, 10, 22, 2, 30));
  });

  it("reads steps, ranges and lists", () => {
    const cron = CronSchedule.parse("*/15 9-17 * * 1-5");
    expect(cron.minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(cron.hours).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
    // Saturday 24 October rolls on to Monday 26 October.
    expect(cron.next_after(at(2026, 10, 23, 17, 50))).toEqual(at(2026, 10, 26, 9, 0));
  });

  it("reads names and Sunday as seven", () => {
    expect(CronSchedule.parse("0 0 * jan,jul sun").months).toEqual(new Set([1, 7]));
    expect(CronSchedule.parse("0 0 * * 7").weekdays).toEqual(new Set([0]));
  });

  it("reads aliases", () => {
    expect(CronSchedule.parse("@weekly").next_after(at(2026, 10, 21, 12, 0))).toEqual(at(2026, 10, 25, 0, 0));
  });

  it("matches either a restricted day or weekday", () => {
    // The 1st of the month or any Monday, as cron reads it.
    const cron = CronSchedule.parse("0 0 1 * mon");
    expect(cron.next_after(at(2026, 10, 21))).toEqual(at(2026, 10, 26));
    expect(cron.next_after(at(2026, 10, 27))).toEqual(at(2026, 11, 1));
  });

  it("finds a leap day", () => {
    expect(CronSchedule.parse("0 0 29 2 *").next_after(at(2026, 3, 1))).toEqual(at(2028, 2, 29));
  });

  it.each(["* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "0 0 30 2 *", "x * * * *"])("rejects the bad expression %s", (expression) => {
    expect(() => CronSchedule.parse(expression)).toThrow();
  });
});

describe("parse_schedule", () => {
  it("reads entries", () => {
    const entries = parse_schedule([{ action: "run_backup", cron: "0 3 * * *" }, { action: "restart", cron: "@daily", args: { unit: "x" } }]);
    expect(entries.map((entry) => entry.action)).toEqual(["run_backup", "restart"]);
    expect(entries[1].args).toEqual({ unit: "x" });
  });

  it("reads nothing as no schedule", () => {
    expect(parse_schedule(null)).toEqual([]);
  });

  it.each([[{ action: "x" }], [[{ action: "x" }]], [[{ cron: "@daily" }]], [[{ action: "x", cron: "@daily", args: [1] }]]])("rejects the malformed entry %j", (value) => {
    expect(() => parse_schedule(value)).toThrow();
  });

  it("gives changed arguments their own state", () => {
    const cron = CronSchedule.parse("@daily");
    expect(new ScheduledAction("a", cron, { x: 1 }).state_key("p")).not.toBe(new ScheduledAction("a", cron, { x: 2 }).state_key("p"));
  });

  it("writes the state key as the Python app did", () => {
    const cron = CronSchedule.parse("@daily");
    expect(new ScheduledAction("a", cron, { y: "z", x: 1 }).state_key("p")).toBe('schedule:p:a:@daily:{"x": 1, "y": "z"}');
  });

  it("keeps the result key apart from the run key", () => {
    const [entry] = parse_schedule([{ action: "run_backup", cron: "0 3 * * *" }]);
    expect(entry.result_key("borg")).not.toBe(entry.state_key("borg"));
    expect(entry.result_key("borg")).toBe("schedule-result:borg:run_backup:0 3 * * *");
  });
});
