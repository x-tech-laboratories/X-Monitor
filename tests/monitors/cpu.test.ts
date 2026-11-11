import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Cpu } from "../../src/monitors/cpu.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-cpu", id: "test-cpu", ssh_config: { host: "test.host" } };

// Two /proc/stat samples, the second `total_delta` jiffies later with `idle_delta` of them idle; each entry of
// `cores` is one core's idle delta out of the same total.
function proc_stat({ idle_delta = 500, total_delta = 1000, cores = [] as number[] } = {}): string {
  const sample = (later: boolean): string => {
    const line = (name: string, idle: number): string => {
      const busy = later ? total_delta - idle : 0;
      return `${name} ${1000 + busy} 0 0 ${1000 + (later ? idle : 0)} 0 0 0 0\n`;
    };
    return line("cpu ", idle_delta) + cores.map((idle, index) => line(`cpu${index}`, idle)).join("");
  };
  return sample(false) + sample(true);
}

function cpu(extra: PluginConfig = {}): Cpu {
  return make_plugin(Cpu, { ...config, ...extra });
}

const latest_status = (plugin: Cpu) => store_of(plugin).store.statuses.get("test-cpu")?.state ?? null;
const latest_metric = (plugin: Cpu, name: string) => store_of(plugin).latest_metric("test-cpu", name)?.value ?? null;

describe("collection", () => {
  it("fails a busy cpu past its thresholds", () => {
    const plugin = cpu({ warning: 70, threshold: 85 });
    run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 100 }), ""));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "cpu_pct")).toBeCloseTo(90.0);
  });

  it("calls an idle cpu online", () => {
    const plugin = cpu();
    run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 1000 }), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "cpu_pct")).toBeCloseTo(0.0);
  });

  it("calls a failed command unavailable", () => {
    const plugin = cpu();
    run_cycle(plugin, () => cmd_result(1, "", "boom"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls incomplete output unavailable", () => {
    const plugin = cpu();
    run_cycle(plugin, () => cmd_result(0, "cpu  1 2 3 4 0 0 0 0\n", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls garbled output unavailable", () => {
    const plugin = cpu();
    run_cycle(plugin, () => cmd_result(0, "cpu  x\ncpu  y\n", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = cpu();
    run_cycle(plugin, () => cmd_result(-1, "", "Agent 'h' is not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("runs one command per cycle", () => {
    expect(cpu().commands()).toHaveLength(1);
  });

  it("reads every core in the same two samples", () => {
    expect(cpu().commands()[0].text.split("grep '^cpu' /proc/stat").length - 1).toBe(2);
  });
});

describe("per core", () => {
  it("puts each core in the snapshot in core order", () => {
    const cores = Array<number>(12).fill(1000);
    cores[10] = 250;
    const result = run_cycle(cpu(), () => cmd_result(0, proc_stat({ cores }), ""));
    const snapshot = result.snapshot as { label: string; value: number }[];
    expect(snapshot.map((item) => item.label)).toEqual(Array.from({ length: 12 }, (_, index) => String(index)));
    expect(snapshot[10].value).toBeCloseTo(75.0);
    expect(snapshot[0].value).toBeCloseTo(0.0);
  });

  it("keeps per-core metrics off by default", () => {
    const plugin = cpu();
    const result = run_cycle(plugin, () => cmd_result(0, proc_stat({ cores: [500, 900] }), ""));
    expect(new Set(Object.keys(result.metrics))).toEqual(new Set(["cpu_pct", "cpu_core_max_pct"]));
    expect(latest_metric(plugin, "cpu_core_max_pct")).toBeCloseTo(50.0);
  });

  it("writes per-core metrics when turned on", () => {
    const plugin = cpu({ per_core_metrics: true });
    run_cycle(plugin, () => cmd_result(0, proc_stat({ cores: [500, 900] }), ""));
    expect(latest_metric(plugin, "cpu0_pct")).toBeCloseTo(50.0);
    expect(latest_metric(plugin, "cpu1_pct")).toBeCloseTo(10.0);
  });

  it("skips a core that went offline", () => {
    const stdout = proc_stat({ cores: [500, 900] }).replace("cpu1 1000 0 0 1000 0 0 0 0\n", "");
    const result = run_cycle(cpu(), () => cmd_result(0, stdout, ""));
    expect((result.snapshot as { label: string }[]).map((item) => item.label)).toEqual(["0"]);
  });

  it("leaves the status alone for a pinned core by default", () => {
    const plugin = cpu();
    run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 900, cores: [0, 1000, 1000, 1000] }), ""));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a pinned core when the core rule is set", () => {
    const plugin = cpu({ core_warning: 90, core_threshold: 99 });
    const result = run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 900, cores: [0, 1000] }), ""));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[0][0]).toContain("busiest core 0 at 100%");
  });

  it("needs only a core failure limit", () => {
    const plugin = cpu({ core_threshold: 99 });
    run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 900, cores: [0, 1000] }), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("still reports the total without core lines", () => {
    const result = run_cycle(cpu(), () => cmd_result(0, proc_stat({ idle_delta: 400 }), ""));
    expect(Object.keys(result.metrics)).toEqual(["cpu_pct"]);
    expect(result.metrics.cpu_pct).toBeCloseTo(60.0);
    expect(result.snapshot).toEqual([]);
  });
});

describe("page", () => {
  it("gives the core bars their own row", () => {
    const spec = cpu().UI_SPEC;
    expect(spec.layout![0]).toEqual(["host_card", "cpu_card"]);
    expect(spec.layout).toContainEqual(["cores"]);
    expect(spec.cards!.cores.repeat!.container).toBe("bars");
  });

  it("colors bars by the core rule when set", () => {
    const plugin = cpu({ core_warning: 90, core_threshold: 99 });
    expect(plugin.core_level({ value: 95.0 })).toBe("warning");
    expect(plugin.core_level({ value: 80.0 })).toBe("online");
  });

  it("colors bars by the overall thresholds otherwise", () => {
    expect(cpu().core_level({ value: 75.0 })).toBe("warning");
  });

  it("draws the cpu card as a gauge banded by the thresholds", () => {
    const card = cpu({ warning: 60, threshold: 85 }).UI_SPEC.cards!.cpu_card;
    expect(card.kind).toBe("gauge");
    expect(card.metric).toBe("cpu_pct");
    expect(card.color).toEqual({ warning: 60, threshold: 85 });
  });

  it("keeps the history chart", () => {
    expect(cpu().UI_SPEC.charts!.cpu_chart.metric).toBe("cpu_pct");
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = cpu({ warning: 70, threshold: null });
    run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 0 }), ""));
    expect(latest_status(plugin)).toBe("warning");
    expect(plugin.UI_SPEC.cards!.cpu_card.color).toEqual({ warning: 70, threshold: null });
  });

  it("never warns with a failure only", () => {
    const plugin = cpu({ warning: null, threshold: 85 });
    run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 200 }), ""));
    expect(latest_status(plugin)).toBe("online");
    run_cycle(plugin, () => cmd_result(0, proc_stat({ idle_delta: 100 }), ""));
    expect(latest_status(plugin)).toBe("failed");
  });
});
