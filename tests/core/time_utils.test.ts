import { describe, expect, it } from "vitest";

import { format_age, format_duration, parse_duration } from "../../src/monitors/base/plugin_helpers.ts";

describe("parse_duration", () => {
  it.each([
    [60, 60], [3600.9, 3600], ["120", 120], ["30s", 30], ["5m", 300], ["2h", 7200], ["3d", 3 * 86400], ["1w", 604800],
    ["2h30m", 2 * 3600 + 30 * 60], ["1d12h", 86400 + 12 * 3600], ["1w1d1h1m1s", 604800 + 86400 + 3600 + 60 + 1],
    ["1H", 3600], ["2M", 120], ["  1h  ", 3600],
  ])("reads %j as %d seconds", (text, seconds) => {
    expect(parse_duration(text)).toBe(seconds);
  });

  it("rejects an invalid string", () => {
    expect(() => parse_duration("invalid")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => parse_duration("")).toThrow();
  });
});

describe("format_duration", () => {
  it.each([
    [0, "0 Seconds"], [-100, "0 Seconds"], [1, "1 Second"], [45, "45 Seconds"], [60, "1 Minute"], [120, "2 Minutes"],
    [3600, "1 Hour"], [7200, "2 Hours"], [86400, "1 Day"], [604800, "1 Week"], [3661, "1 Hour 1 Minute"], [86400 + 7200, "1 Day 2 Hours"],
  ])("writes %d seconds as %s", (seconds, text) => {
    expect(format_duration(seconds)).toBe(text);
  });
});

describe("format_age", () => {
  it("says never for a negative age", () => {
    expect(format_age(-1)).toBe("Never");
    expect(format_age(-9999)).toBe("Never");
  });

  it.each([[0, "0 Seconds ago"], [3600, "1 Hour ago"], [86400 + 7200, "1 Day 2 Hours ago"]])("writes %d seconds as %s", (seconds, text) => {
    expect(format_age(seconds)).toBe(text);
  });
});
