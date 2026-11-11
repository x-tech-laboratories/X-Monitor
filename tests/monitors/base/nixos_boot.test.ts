import { describe, expect, it } from "vitest";

import { boot_parts_script, changed_parts, reboot_required } from "../../../src/monitors/base/nixos_boot.ts";

describe("nixos boot", () => {
  it("prints a booted and a current line per part", () => {
    const script = boot_parts_script().join("\n");
    expect(script).toContain("for part in initrd kernel kernel-modules systemd; do");
    expect(script).toContain("readlink -f /run/booted-system/$part");
    expect(script).toContain("readlink -f /run/current-system/$part");
  });

  it("needs a reboot when a part differs", () => expect(reboot_required(["a", "b"], ["a", "c"])).toBe(true));
  it("needs none when every part matches", () => expect(reboot_required(["a", "b"], ["a", "b"])).toBe(false));
  it("cannot tell from empty or mismatched readings", () => {
    expect(reboot_required([], [])).toBeNull();
    expect(reboot_required(["a"], ["a", "b"])).toBeNull();
    expect(reboot_required(["", ""], ["", ""])).toBeNull();
  });
  it("names the parts that changed", () => expect(changed_parts(["a", "b", "c", "d"], ["a", "x", "y", "d"])).toEqual(["kernel", "kernel-modules"]));
});
