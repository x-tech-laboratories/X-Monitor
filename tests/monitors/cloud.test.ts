import { describe, expect, it } from "vitest";

import { cmd_result, type CmdResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Cloud, parse_kv } from "../../src/monitors/cloud.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const latest_status = (plugin: Cloud) => store_of(plugin).store.statuses.get("test-cloud")?.state ?? null;
const latest_metric = (plugin: Cloud, name: string) => store_of(plugin).latest_metric("test-cloud", name)?.value ?? null;

function config(extra: PluginConfig = {}): PluginConfig {
  return { name: "test-cloud", id: "test-cloud", ssh_config: { host: "test.host" }, ...extra };
}

const aws_out = "provider=aws\ninstance_id=i-0abc123\ninstance_type=t3.micro\nregion=us-east-1\naz=us-east-1a\n";

describe("parse kv", () => {
  it("reads key=value lines", () => {
    expect(parse_kv("a=1\nb=two")).toEqual({ a: "1", b: "two" });
  });

  it("keeps an equals sign in the value", () => {
    expect(parse_kv("url=http://x?a=b").url).toBe("http://x?a=b");
  });
});

describe("collection", () => {
  it("calls a detected AWS instance online", () => {
    const plugin = make_plugin(Cloud, config({ provider: "aws" }));
    const result = run_cycle(plugin, () => cmd_result(0, aws_out, ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "on_cloud")).toBeCloseTo(1.0);
    expect(result.logs.at(-1)![0]).toBe("Detected aws instance i-0abc123 (t3.micro)");
    expect(result.snapshot).toEqual([
      { label: "INSTANCE ID", value: "i-0abc123" },
      { label: "REGION", value: "us-east-1" },
      { label: "AZ", value: "us-east-1a" },
    ]);
    expect(plugin.provider_text).toBe("AWS");
    expect(plugin.instance_type_text).toBe("t3.micro");
  });

  it("calls a host off the cloud unavailable", () => {
    const plugin = make_plugin(Cloud, config({ provider: "aws" }));
    run_cycle(plugin, () => cmd_result(7, "", ""));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "on_cloud")).toBeCloseTo(0.0);
    expect(plugin.provider_text).toBe("NONE");
  });

  it("falls through the providers on auto", () => {
    const plugin = make_plugin(Cloud, config({ provider: "auto" }));
    const outputs: CmdResult[] = [cmd_result(7, "", ""), cmd_result(7, "", ""), cmd_result(0, "provider=azure\nraw={}\n", "")];
    run_cycle(plugin, () => outputs.shift()!);
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls auto with no answer unavailable", () => {
    const plugin = make_plugin(Cloud, config({ provider: "auto" }));
    run_cycle(plugin, () => cmd_result(7, "", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = make_plugin(Cloud, config({ provider: "aws" }));
    run_cycle(plugin, () => cmd_result(-1, "", "Agent 'h' is not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("probes one provider when named and all three on auto", () => {
    expect(make_plugin(Cloud, config({ provider: "GCP" })).commands()).toHaveLength(1);
    expect(make_plugin(Cloud, config()).commands()).toHaveLength(3);
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(make_plugin(Cloud, config()).plan_action("anything")).toBeNull();
  });
});
