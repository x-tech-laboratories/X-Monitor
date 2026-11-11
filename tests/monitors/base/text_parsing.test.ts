import { describe, expect, it } from "vitest";

import { float_or_null, fnmatch, format_fixed, python_float_repr, python_regex, int_or_null, parse_float, parse_int, partition, split_lines, split_words } from "../../../src/monitors/base/text_parsing.ts";

describe("splitting", () => {
  it("drops the empty line after a final newline", () => expect(split_lines("a\nb\n")).toEqual(["a", "b"]));
  it("keeps an inner empty line", () => expect(split_lines("a\n\nb")).toEqual(["a", "", "b"]));
  it("reads empty text as no lines", () => expect(split_lines("")).toEqual([]));
  it("splits words on any whitespace", () => expect(split_words("  a \t b\n")).toEqual(["a", "b"]));
  it("keeps the rest whole past the split limit", () => expect(split_words("a b  c ", 1)).toEqual(["a", "b  c "]));
  it("partitions at the first separator", () => expect(partition("a:b:c", ":")).toEqual(["a", ":", "b:c"]));
  it("partitions without the separator", () => expect(partition("abc", ":")).toEqual(["abc", "", ""]));
});

describe("numbers", () => {
  it("reads an int as Python does", () => expect(parse_int(" -42 ")).toBe(-42));
  it("refuses a decimal int", () => expect(() => parse_int("4.2")).toThrow());
  it("reads a float as Python does", () => expect(parse_float("1e3")).toBe(1000));
  it("refuses garbage as a float", () => expect(() => parse_float("garbage")).toThrow());
  it("gives null where Python raises", () => {
    expect(int_or_null("x")).toBeNull();
    expect(float_or_null("x")).toBeNull();
  });
});

describe("format fixed", () => {
  it("rounds an exact tie to even", () => {
    expect(format_fixed(12.5, 0)).toBe("12");
    expect(format_fixed(13.5, 0)).toBe("14");
    expect(format_fixed(0.25, 1)).toBe("0.2");
    expect(format_fixed(-2.5, 0)).toBe("-2");
  });

  it("rounds anything else as toFixed does", () => {
    expect(format_fixed(42.6, 0)).toBe("43");
    expect(format_fixed(1.005, 2)).toBe("1.00");
  });
});

describe("fnmatch", () => {
  it("matches stars, marks and sets as Python does", () => {
    expect(fnmatch("veth12ab", "veth*")).toBe(true);
    expect(fnmatch("eth0", "eth?")).toBe(true);
    expect(fnmatch("eth10", "eth?")).toBe(false);
    expect(fnmatch("eth1", "eth[0-2]")).toBe(true);
    expect(fnmatch("eth3", "eth[!0-2]")).toBe(true);
    expect(fnmatch("a.b", "a.b")).toBe(true);
    expect(fnmatch("axb", "a.b")).toBe(false);
    expect(fnmatch("ETH0", "eth*")).toBe(false);
  });
});

describe("python float repr", () => {
  it("writes floats as Python's str does", () => {
    expect(python_float_repr(42)).toBe("42.0");
    expect(python_float_repr(2.5)).toBe("2.5");
    expect(python_float_repr(0.1)).toBe("0.1");
    expect(python_float_repr(1e-5)).toBe("1e-05");
    expect(python_float_repr(1e16)).toBe("1e+16");
    expect(python_float_repr(123456789012345.6)).toBe("123456789012345.6");
    expect(python_float_repr(-0.001)).toBe("-0.001");
  });
});

describe("python regex", () => {
  it("rewrites named groups", () => {
    expect(python_regex("(?P<value>\\d+)").exec("a 12")!.groups!.value).toBe("12");
  });
});
