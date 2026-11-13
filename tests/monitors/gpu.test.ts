import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Gpu, intel_gpu_top_sample } from "../../src/monitors/gpu.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-gpu", id: "test-gpu", ssh_config: { host: "test.host" } };
const nvidia = "0x10de";
const amd = "0x1002";
const intel = "0x8086";

function nvidia_rows({ util = "10.0", mem_used = 1000, mem_total = 8000, temp = "50.0", count = 1, power = "75.5", clock = "1500" } = {}): string {
  return Array.from({ length: count }, (_, index) => `${index}, ${util}, ${mem_used}, ${mem_total}, ${temp}, ${power}, ${clock}\n`).join("");
}

// The nvidia-smi section of the probe's output.
function nvidia_section({ rows = null as string | null, exit_code = 0, ...rest }: Parameters<typeof nvidia_rows>[0] & { rows?: string | null; exit_code?: number } = {}): string {
  return `@@NVIDIA\n${rows ?? nvidia_rows(rest)}@@NVIDIA_EXIT ${exit_code}\n`;
}

const pci = (...vendors: string[]): string => vendors.map((vendor) => `@@PCI ${vendor}\n`).join("");

// One sysfs card section, `files` mapping a path under the card to its lines.
function card(name: string, vendor: string, files: Record<string, unknown> = {}, { asleep = false, igt = null as string | null } = {}): string {
  let out = `@@CARD ${name} ${vendor}\n`;
  if (asleep) return out + "@@ASLEEP\n";
  for (const [path, value] of Object.entries(files)) for (const line of String(value).split("\n")) out += `/sys/class/drm/${name}/${path}:${line}\n`;
  if (igt !== null) out += `@@IGT\n${igt}\n@@IGT_END\n`;
  return out;
}

function amd_files({ busy = 30, vram_used = 2 * 1024 ** 3, vram_total = 8 * 1024 ** 3, edge = 55000, junction = 70000, mem = 60000, power_uw = 120_000_000 } = {}): Record<string, unknown> {
  return {
    "device/gpu_busy_percent": busy,
    "device/mem_busy_percent": 12,
    "device/mem_info_vram_used": vram_used,
    "device/mem_info_vram_total": vram_total,
    "device/pp_dpm_sclk": "0: 500Mhz\n1: 1800Mhz *\n2: 2400Mhz",
    "device/hwmon/hwmon4/temp1_input": edge,
    "device/hwmon/hwmon4/temp1_label": "edge",
    "device/hwmon/hwmon4/temp2_input": junction,
    "device/hwmon/hwmon4/temp2_label": "junction",
    "device/hwmon/hwmon4/temp3_input": mem,
    "device/hwmon/hwmon4/temp3_label": "mem",
    "device/hwmon/hwmon4/power1_average": power_uw,
  };
}

// intel_gpu_top -J output cut off mid-array, the way a timed-out run leaves it.
function igt_json({ render = 20.0, video = 45.0, power = 6.5, actual = 1100.0 } = {}): string {
  const sample = {
    period: { duration: 500.2, unit: "ms" },
    frequency: { requested: 1150.0, actual, unit: "MHz" },
    power: { GPU: power, Package: 14.2, unit: "W" },
    engines: { "Render/3D": { busy: render, sema: 0.0, wait: 0.0, unit: "%" }, Video: { busy: video, sema: 0.0, wait: 0.0, unit: "%" } },
  };
  return "[\n" + JSON.stringify(sample, null, 1) + ",\n" + JSON.stringify(sample).slice(0, 40);
}

const gpu = (extra: PluginConfig = {}): Gpu => make_plugin(Gpu, { ...config, ...extra });
const ok = (stdout: string) => () => cmd_result(0, stdout, "");
const timed_out = () => cmd_result(1, "", "Command timed out after 15s");
const latest_status = (plugin: Gpu) => store_of(plugin).latest_status("test-gpu");
const latest_metric = (plugin: Gpu, name: string) => store_of(plugin).latest_metric("test-gpu", name)?.value ?? null;
const snapshot_of = (result: { snapshot: unknown }) => result.snapshot as Record<string, unknown>[];

describe("nvidia", () => {
  it("reports the peak across cards", () => {
    const plugin = gpu();
    run_cycle(plugin, ok(pci(nvidia, nvidia) + nvidia_section({ util: "40.0", temp: "60.0", count: 2 })));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "gpu_util")).toBeCloseTo(40.0);
    expect(latest_metric(plugin, "gpu1_util")).toBeCloseTo(40.0);
    expect(latest_metric(plugin, "gpu_temp")).toBeCloseTo(60.0);
    expect(latest_metric(plugin, "gpu0_mem_pct")).toBeCloseTo(12.5);
  });

  it("keeps power and clock", () => {
    const plugin = gpu();
    run_cycle(plugin, ok(pci(nvidia) + nvidia_section()));
    expect(latest_metric(plugin, "gpu0_power_w")).toBeCloseTo(75.5);
    expect(latest_metric(plugin, "gpu0_clock_mhz")).toBeCloseTo(1500.0);
  });

  it("leaves out power reported as not available", () => {
    const result = run_cycle(gpu(), ok(pci(nvidia) + nvidia_section({ power: "[N/A]", clock: "[N/A]" })));
    expect("gpu0_power_w" in result.metrics).toBe(false);
    expect(result.metrics.gpu0_util).toBeCloseTo(10.0);
  });

  it("still parses the older five-column output", () => {
    const result = run_cycle(gpu(), ok(nvidia_section({ rows: "0, 10, 1000, 8000, 50\n" })));
    expect(result.metrics.gpu0_temp).toBeCloseTo(50.0);
  });

  it("fails a hot GPU", () => {
    const plugin = gpu({ temp_threshold: 55 });
    run_cycle(plugin, ok(pci(nvidia) + nvidia_section({ temp: "60.0" })));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a missing nvidia-smi with no other GPU unavailable", () => {
    const plugin = gpu();
    const result = run_cycle(plugin, ok(pci(nvidia) + "@@NVIDIA_MISSING\n"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("nvidia-smi is not installed");
  });

  it("calls no GPU at all unavailable", () => {
    const plugin = gpu();
    const result = run_cycle(plugin, ok("@@NVIDIA_MISSING\n"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("no NVIDIA, AMD, Intel GPU found");
  });

  it("calls an nvidia-smi that cannot reach the driver unavailable", () => {
    const plugin = gpu();
    run_cycle(plugin, ok(pci(nvidia) + nvidia_section({ rows: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n", exit_code: 9 })));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("fails on an error nvidia-smi reports", () => {
    const plugin = gpu();
    const result = run_cycle(plugin, ok(pci(nvidia) + nvidia_section({ rows: "Unable to determine the device handle for GPU 0000:01:00.0: GPU is lost\n", exit_code: 15 })));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[0][0]).toContain("GPU is lost");
  });

  it("calls empty output unavailable", () => {
    const plugin = gpu();
    run_cycle(plugin, ok(""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a failed probe unavailable", () => {
    const plugin = gpu();
    run_cycle(plugin, () => cmd_result(-1, "", "Agent 'h' is not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("amd", () => {
  it("maps sysfs readings onto the shared names", () => {
    const plugin = gpu();
    run_cycle(plugin, ok(pci(amd) + card("card0", amd, amd_files()) + "@@NVIDIA_MISSING\n"));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "gpu0_util")).toBeCloseTo(30.0);
    expect(latest_metric(plugin, "gpu0_mem_pct")).toBeCloseTo(25.0);
    expect(latest_metric(plugin, "gpu0_mem_busy_pct")).toBeCloseTo(12.0);
    expect(latest_metric(plugin, "gpu0_temp")).toBeCloseTo(55.0);
    expect(latest_metric(plugin, "gpu0_temp_junction")).toBeCloseTo(70.0);
    expect(latest_metric(plugin, "gpu0_temp_mem")).toBeCloseTo(60.0);
    expect(latest_metric(plugin, "gpu0_power_w")).toBeCloseTo(120.0);
    expect(latest_metric(plugin, "gpu0_clock_mhz")).toBeCloseTo(1800.0);
    expect(latest_metric(plugin, "gpu_util")).toBeCloseTo(30.0);
  });

  it("fails a busy card past the utilization threshold", () => {
    const plugin = gpu();
    run_cycle(plugin, ok(card("card0", amd, amd_files({ busy: 97 }))));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("sets the status by the edge temperature, not the junction", () => {
    const plugin = gpu();
    run_cycle(plugin, ok(card("card0", amd, amd_files({ edge: 60000, junction: 95000 }))));
    expect(latest_status(plugin)).toBe("online");
  });

  it("takes an unlabelled sensor as the card temperature", () => {
    const result = run_cycle(gpu(), ok(card("card0", amd, { "device/gpu_busy_percent": 5, "device/hwmon/hwmon1/temp1_input": 48000 })));
    expect(result.metrics.gpu0_temp).toBeCloseTo(48.0);
  });

  it("falls back to the instant power reading", () => {
    const result = run_cycle(gpu(), ok(card("card1", amd, { "device/gpu_busy_percent": 5, "device/hwmon/hwmon1/power1_input": 16_000_000 })));
    expect(result.metrics.gpu0_power_w).toBeCloseTo(16.0);
  });

  it("calls a suspended card idle without reading it", () => {
    const plugin = gpu();
    const result = run_cycle(plugin, ok(card("card0", amd, {}, { asleep: true })));
    expect(latest_status(plugin)).toBe("online");
    expect(result.metrics.gpu0_util).toBe(0.0);
    expect("gpu0_temp" in result.metrics).toBe(false);
    expect(plugin.item_text(snapshot_of(result)[0])).toBe("asleep");
  });

  it("skips a suspended card before anything is read", () => {
    const text = gpu().commands()[0].text;
    expect(text.indexOf("@@ASLEEP")).toBeLessThan(text.indexOf("grep -Hs"));
  });
});

describe("intel", () => {
  it("leaves utilization unknown without intel_gpu_top", () => {
    const plugin = gpu();
    const result = run_cycle(plugin, ok(card("card0", intel, { gt_act_freq_mhz: 300 })));
    expect(latest_status(plugin)).toBe("online");
    expect(result.metrics.gpu0_clock_mhz).toBeCloseTo(300.0);
    expect("gpu0_util" in result.metrics).toBe(false);
    expect("gpu_util" in result.metrics).toBe(false);
    expect(result.logs[0][0]).toContain("utilization unknown for Intel GPU 0");
    expect(plugin.item_text(snapshot_of(result)[0]).startsWith("util ?")).toBe(true);
  });

  it("keeps an idle clock of zero", () => {
    expect(run_cycle(gpu(), ok(card("card0", intel, { gt_act_freq_mhz: 0 }))).metrics.gpu0_clock_mhz).toBe(0.0);
  });

  it("reads the xe frequency and temperatures", () => {
    const files = {
      "device/tile0/gt0/freqs/act_freq": 1650,
      "device/hwmon/hwmon5/temp2_input": 52000, "device/hwmon/hwmon5/temp2_label": "pkg",
      "device/hwmon/hwmon5/temp3_input": 58000, "device/hwmon/hwmon5/temp3_label": "vram",
    };
    const result = run_cycle(gpu(), ok(card("card0", intel, files)));
    expect(result.metrics.gpu0_clock_mhz).toBeCloseTo(1650.0);
    expect(result.metrics.gpu0_temp).toBeCloseTo(52.0);
    expect(result.metrics.gpu0_temp_mem).toBeCloseTo(58.0);
  });

  it("takes utilization from intel_gpu_top as the busiest engine", () => {
    const result = run_cycle(gpu(), ok(card("card0", intel, { gt_act_freq_mhz: 900 }, { igt: igt_json() })));
    expect(result.metrics.gpu0_util).toBeCloseTo(45.0);
    expect(result.metrics.gpu0_power_w).toBeCloseTo(6.5);
    expect(result.metrics.gpu0_clock_mhz).toBeCloseTo(900.0);
    expect(result.logs[0][0]).not.toContain("utilization unknown");
  });

  it("fills the clock from intel_gpu_top when sysfs has none", () => {
    expect(run_cycle(gpu(), ok(card("card0", intel, {}, { igt: igt_json({ actual: 1234.0 }) }))).metrics.gpu0_clock_mhz).toBeCloseTo(1234.0);
  });

  it("leaves utilization unknown when intel_gpu_top lacks permission", () => {
    const result = run_cycle(gpu(), ok(card("card0", intel, { gt_act_freq_mhz: 300 }, { igt: "" })));
    expect("gpu0_util" in result.metrics).toBe(false);
    expect(result.logs[0][0]).toContain("CAP_PERFMON");
  });

  it("bounds intel_gpu_top and lets it be turned off", () => {
    expect(gpu().commands()[0].text).toContain("timeout -s INT 2 intel_gpu_top -J");
    expect(gpu({ intel_gpu_top: false }).commands()[0].text).not.toContain("intel_gpu_top");
  });

  it("takes the last complete sample", () => {
    const sample = intel_gpu_top_sample('[{"engines": {"a": {"busy": 1}}}, {"engines": {"a": {"busy": 2}}}, {"eng');
    expect(((sample!.engines as Record<string, Record<string, number>>).a).busy).toBe(2);
    expect(intel_gpu_top_sample("")).toBeNull();
    expect(intel_gpu_top_sample("Failed to initialize PMU!")).toBeNull();
  });
});

describe("mixed vendors", () => {
  it("reports every card, numbered after the nvidia ones", () => {
    const result = run_cycle(gpu(), ok(pci(intel, nvidia) + card("card1", intel, { gt_act_freq_mhz: 300 }) + nvidia_section({ util: "20.0", temp: "50.0" })));
    expect(result.metrics.gpu0_util).toBeCloseTo(20.0);
    expect(result.metrics.gpu1_clock_mhz).toBeCloseTo(300.0);
    expect(snapshot_of(result).map((item) => item.label)).toEqual(["GPU 0 NVIDIA", "GPU 1 Intel"]);
  });

  it("keeps the numbering when nvidia-smi is missing", () => {
    const result = run_cycle(gpu(), ok(pci(nvidia, amd) + card("card1", amd, amd_files()) + "@@NVIDIA_MISSING\n"));
    expect("gpu1_util" in result.metrics).toBe(true);
    expect(result.logs[0][0]).toContain("nvidia-smi is not installed");
  });

  it("orders sysfs cards by DRM card number", () => {
    const result = run_cycle(gpu(), ok(card("card10", amd, amd_files({ busy: 10 })) + card("card2", amd, amd_files({ busy: 2 }))));
    expect(result.metrics.gpu0_util).toBeCloseTo(2.0);
    expect(result.metrics.gpu1_util).toBeCloseTo(10.0);
  });

  it("lets the worst card set the status", () => {
    const plugin = gpu();
    const result = run_cycle(plugin, ok(pci(nvidia, amd) + card("card1", amd, amd_files({ edge: 85000 })) + nvidia_section({ util: "5.0", temp: "40.0" })));
    expect(latest_status(plugin)).toBe("warning");
    expect(snapshot_of(result).map((item) => item.level)).toEqual(["online", "warning"]);
  });

  it("fails on an nvidia error while other cards still report", () => {
    const plugin = gpu();
    const result = run_cycle(plugin, ok(pci(nvidia, amd) + card("card1", amd, amd_files()) + nvidia_section({ rows: "Unknown Error\n", exit_code: 15 })));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.metrics.gpu1_util).toBeCloseTo(30.0);
  });
});

describe("vendor override", () => {
  it("probes every vendor on auto", () => {
    const text = gpu().commands()[0].text;
    expect(text).toContain("nvidia-smi");
    expect(text).toContain("0x1002|0x8086");
  });

  it("probes only the one vendor named", () => {
    const text = gpu({ vendor: "amd" }).commands()[0].text;
    expect(text).not.toContain("nvidia-smi");
    expect(text).toContain("0x1002)");
    expect(text).not.toContain("0x8086");
  });

  it("skips the sysfs scan for nvidia alone", () => {
    const text = gpu({ vendor: "nvidia" }).commands()[0].text;
    expect(text).not.toContain("/sys/class/drm");
    expect(text).toContain("nvidia-smi");
  });

  it("accepts a list of vendors", () => expect(gpu({ vendor: ["intel", "NVIDIA"] }).vendors).toEqual(["nvidia", "intel"]));

  it("ignores and names an unknown vendor", () => {
    const plugin = gpu({ vendor: "matrox" });
    expect(plugin.vendors).toEqual(["nvidia", "amd", "intel"]);
    const result = run_cycle(plugin, ok(pci(nvidia) + nvidia_section()));
    expect(result.logs[0][0]).toContain("ignored unknown vendor matrox");
  });

  it("calls no card of the chosen vendor unavailable", () => {
    const plugin = gpu({ vendor: "intel" });
    const result = run_cycle(plugin, ok(pci(nvidia)));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("no Intel GPU found");
  });
});

describe("timeout breaker", () => {
  it("suspends only nvidia-smi after repeated timeouts", () => {
    const plugin = gpu({ timeout_trip: 2, suspend_seconds: 600 });
    run_cycle(plugin, timed_out);
    expect(latest_status(plugin)).toBe("unavailable");
    run_cycle(plugin, timed_out);
    expect(latest_status(plugin)).toBe("unavailable");
    const text = plugin.commands()[0].text;
    expect(text).not.toContain("nvidia-smi");
    expect(text).toContain("/sys/class/drm");
  });

  it("keeps other cards reporting while suspended", () => {
    const plugin = gpu({ timeout_trip: 1, suspend_seconds: 600 });
    run_cycle(plugin, timed_out);
    const result = run_cycle(plugin, ok(pci(nvidia, amd) + card("card1", amd, amd_files())));
    expect(latest_status(plugin)).toBe("online");
    expect(result.metrics.gpu1_util).toBeCloseTo(30.0);
    expect(result.logs[0][0]).toContain("probe suspended");
  });

  it("calls a suspended nvidia-only host unavailable", () => {
    const plugin = gpu({ timeout_trip: 1, suspend_seconds: 600 });
    run_cycle(plugin, timed_out);
    const result = run_cycle(plugin, ok(pci(nvidia)));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("driver is wedged");
  });

  it("never trips the breaker on timeouts without nvidia", () => {
    const plugin = gpu({ vendor: "amd", timeout_trip: 1 });
    run_cycle(plugin, timed_out);
    expect(plugin.suspended()).toBe(false);
  });
});

describe("page", () => {
  it("gives the per-card repeat its own row", () => {
    const spec = gpu().UI_SPEC;
    expect(spec.layout![0]).not.toContain("gpus");
    expect(spec.layout).toContainEqual(["gpus"]);
  });

  it("reads every known value on a card chip", () => {
    expect(gpu().item_text({ util: 42.4, mem_pct: 25.0, temp: 61.2, power_w: 120.4, clock_mhz: 1800.0 })).toBe("42%  ·  VRAM 25%  ·  61°C  ·  120 W  ·  1800 MHz");
  });

  it("colors a card chip by its own level", () => expect(gpu().item_level({ level: "warning" })).toBe("warning"));

  it("draws utilization and VRAM as gauges banded by their thresholds", () => {
    const cards = gpu().UI_SPEC.cards!;
    expect(cards.gpu_util_card.kind).toBe("gauge");
    expect(cards.gpu_util_card.color).toEqual({ warning: 85, threshold: 95 });
    expect(cards.gpu_mem_card.kind).toBe("gauge");
    expect(cards.gpu_mem_card.color).toEqual({ warning: 85, threshold: 95 });
  });

  it("ticks each GPU meter at the utilization warning", () => {
    const plugin = gpu({ util_warning: 70 });
    const repeat = plugin.UI_SPEC.cards!.gpus.repeat!;
    expect(repeat.container).toBe("bars");
    expect(repeat.bar_marker).toBe(70.0);
    expect(repeat.item_color_by).toBe(plugin.item_level);
  });
});

describe("optional limits", () => {
  it("never fails with warnings only", () => {
    const plugin = gpu({ util_threshold: null, mem_threshold: null, temp_threshold: null });
    run_cycle(plugin, ok(pci(nvidia) + nvidia_section({ util: "100.0", mem_used: 8000, temp: "120.0" })));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with failures only", () => {
    const plugin = gpu({ util_warning: null, mem_warning: null, temp_warning: null });
    run_cycle(plugin, ok(pci(nvidia) + nvidia_section({ util: "94.0", mem_used: 7500, temp: "89.0" })));
    expect(latest_status(plugin)).toBe("online");
    run_cycle(plugin, ok(pci(nvidia) + nvidia_section({ temp: "95.0" })));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("ticks no meter without a utilization warning", () => {
    expect(gpu({ util_warning: null }).UI_SPEC.cards!.gpus.repeat!.bar_marker).toBeUndefined();
  });
});
