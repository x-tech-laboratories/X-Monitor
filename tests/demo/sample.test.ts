import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parse_yaml } from "yaml";

import { PARSED_SAMPLES, READINGS, SAMPLE_TYPES, thresholds, type SampleMonitor } from "../../dev/demo/sample.ts";
import { builtin_monitor_types } from "../../src/monitors/index.ts";
import { make_plugin } from "../harness.ts";

const demo_folder = join(import.meta.dirname, "../../dev/demo");

// A stand-in carrying every field a sample reads.
function stand_in(kind: string): SampleMonitor {
  return {
    config: { type: kind }, warning: 70, threshold: 90, max_age: 86400, cpu_warning: 50, cpu_threshold: 80, max_processes: 20,
    checks: [{ metric: "web" }, { metric: "ssh" }],
  } as unknown as SampleMonitor;
}

describe("samples", () => {
  it("yields metrics and a status for every sampled type", () => {
    for (const [kind, reading] of Object.entries(READINGS)) {
      for (let tick = 0; tick < 80; tick += 7) {
        const [metrics, status] = reading(stand_in(kind), tick, 101);
        expect(Object.keys(metrics).length, kind).toBeGreaterThan(0);
        expect(Object.values(metrics).every((value) => typeof value === "number" && Number.isFinite(value)), kind).toBe(true);
        expect(["online", "info", "warning", "failed"], kind).toContain(status);
      }
    }
  });

  it("parses every parsed sample cleanly in its real monitor", async () => {
    for (const [kind, reading] of Object.entries(PARSED_SAMPLES)) {
      const cls = await builtin_monitor_types[kind]();
      const plugin = make_plugin(cls, { name: kind, id: kind, type: kind, ssh_config: { host: "demo.host" } });
      const result = reading(plugin, 0, 101);
      expect(Object.keys(result.metrics).length, kind).toBeGreaterThan(0);
      expect(["online", "info", "warning", "failed"], kind).toContain(result.status);
    }
  });

  it("gives the pool and disk tiles their snapshot lists", () => {
    const pools = READINGS.zfs(stand_in("zfs"), 0, 1)[2] as { label: string }[];
    const disks = READINGS.smart(stand_in("smart"), 0, 1)[2] as Record<string, unknown>[];
    expect(new Set(pools.map((pool) => pool.label))).toEqual(new Set(["storage", "backup"]));
    for (const disk of disks) for (const key of ["label", "health", "temperature", "power_on_hours"]) expect(disk).toHaveProperty(key);
  });

  it("syncs a syncthing folder now and then as info", () => {
    const states = new Set(Array.from({ length: 40 }, (_, tick) => READINGS.syncthing(stand_in("syncthing"), tick, 3)[1]));
    expect(states).toEqual(new Set(["online", "info"]));
  });

  it("takes a flaky monitor down now and then", () => {
    const states = new Set(Array.from({ length: 40 }, (_, tick) => READINGS.uptime(stand_in("uptime"), tick, 3)[1]));
    expect(states).toEqual(new Set(["online", "failed"]));
  });

  it("fails a reading past the threshold", () => {
    expect(thresholds(stand_in("cpu"), 95)).toBe("failed");
  });

  it("covers every check in a ports reading", () => {
    const [metrics] = READINGS.ports(stand_in("ports"), 0, 1);
    for (const key of ["web_up", "ssh_up", "web_latency_ms", "ssh_latency_ms"]) expect(metrics).toHaveProperty(key);
  });
});

describe("sample fleet", () => {
  it("has a sample for every monitor in the sample fleet that is not a group", () => {
    const config = parse_yaml(readFileSync(join(demo_folder, "sample.yaml"), "utf8")) as { plugins: { type: string; children?: unknown[] }[] };
    const kinds = (nodes: { type: string; children?: unknown[] }[]): string[] =>
      nodes.flatMap((node) => [node.type, ...kinds((node.children ?? []) as { type: string; children?: unknown[] }[])]);
    const missing = kinds(config.plugins).filter((kind) => kind !== "group" && !SAMPLE_TYPES.has(kind));
    expect(missing).toEqual([]);
  });
});
