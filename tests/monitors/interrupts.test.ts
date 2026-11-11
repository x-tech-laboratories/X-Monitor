import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Interrupts } from "../../src/monitors/interrupts.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-interrupts", id: "test-interrupts", ssh_config: { host: "test.host" } };

function snaps({ intr_delta = 1000, ctxt_delta = 2000 } = {}): string {
  const snap = (intr: number, ctxt: number): string => `cpu  100 0 50 900 10 0 5 0\nintr ${intr} 20 0 0\nctxt ${ctxt}\n`;
  return snap(1_000_000, 5_000_000) + "---SNAP---\n" + snap(1_000_000 + intr_delta, 5_000_000 + ctxt_delta);
}

const interrupts = (extra: PluginConfig = {}): Interrupts => make_plugin(Interrupts, { ...config, ...extra });
const latest_status = (plugin: Interrupts) => store_of(plugin).latest_status("test-interrupts");
const latest_metric = (plugin: Interrupts, name: string) => store_of(plugin).latest_metric("test-interrupts", name)?.value ?? null;

describe("collection", () => {
  it("takes rates as the delta between samples", () => {
    const plugin = interrupts();
    run_cycle(plugin, () => cmd_result(0, snaps({ intr_delta: 1500 }), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "irq_per_sec")).toBeCloseTo(1500.0);
    expect(latest_metric(plugin, "ctxt_per_sec")).toBeCloseTo(2000.0);
  });

  it("fails a high rate past the thresholds", () => {
    const plugin = interrupts({ warning: 500, threshold: 1000 });
    run_cycle(plugin, () => cmd_result(0, snaps({ intr_delta: 1200 }), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls unexpected output unavailable", () => {
    const plugin = interrupts();
    run_cycle(plugin, () => cmd_result(0, "cpu 1 2 3\n", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a failed read unavailable", () => {
    const plugin = interrupts();
    run_cycle(plugin, () => cmd_result(1, "", "cat: /proc/stat: Permission denied"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("takes its own /proc/stat sample", () => {
    expect(interrupts().commands()[0].text).toContain("---SNAP---");
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = interrupts({ warning: 500, threshold: null });
    run_cycle(plugin, () => cmd_result(0, snaps({ intr_delta: 10_000_000 }), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = interrupts({ warning: null, threshold: 1000 });
    run_cycle(plugin, () => cmd_result(0, snaps({ intr_delta: 999 }), ""));
    expect(latest_status(plugin)).toBe("online");
    run_cycle(plugin, () => cmd_result(0, snaps({ intr_delta: 1200 }), ""));
    expect(latest_status(plugin)).toBe("failed");
  });
});
