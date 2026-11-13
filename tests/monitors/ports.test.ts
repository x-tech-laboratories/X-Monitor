import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { build_probe_script, parse_results, Ports, safe_metric_name } from "../../src/monitors/ports.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

function base_config(): PluginConfig {
  return {
    name: "test-ports",
    id: "test-ports",
    ssh_config: { host: "test.host" },
    checks: [
      { name: "SSH", host: "10.0.0.1", port: 22 },
      { name: "API", url: "https://api.example.com/health" },
    ],
  };
}

const plugin = () => make_plugin(Ports, base_config());

const latest_status = (monitor: Ports) => store_of(monitor).store.statuses.get("test-ports")?.state ?? null;
const latest_metric = (monitor: Ports, name: string) => store_of(monitor).latest_metric("test-ports", name)?.value ?? null;

describe("helpers", () => {
  it("makes safe metric names", () => {
    expect(safe_metric_name("My Web!")).toBe("my_web");
    expect(safe_metric_name("https://a.b/c")).toBe("https___a_b_c");
  });

  it("parses ok and failed checks", () => {
    const results = parse_results("0 12\n1 FAIL\n", 2);
    expect(results.get(0)).toBeCloseTo(12.0);
    expect(results.get(1)).toBeNull();
  });

  it("leaves a missing index null", () => {
    const results = parse_results("0 5\n", 2);
    expect(results.get(0)).toBeCloseTo(5.0);
    expect(results.get(1)).toBeNull();
  });

  it("builds a script with a tcp and a url probe", () => {
    const script = build_probe_script(base_config().checks as never, 5);
    expect(script).toContain("/dev/tcp/10.0.0.1/22");
    expect(script).toContain("curl");
  });

  it("quotes the url as Python's repr did", () => {
    const script = build_probe_script([{ url: "https://api.example.com/health" }], 5);
    expect(script.split("\n")[1]).toBe(
      `code=$(curl -o /dev/null -s -m 5 -w "%{http_code}:%{time_total}" 'https://api.example.com/health' 2>/dev/null); ` +
        `case "$code" in 2*|3*) echo "0 $(echo "$code" | cut -d: -f2 | awk '{printf "%.0f", $1*1000}')";; *) echo "0 FAIL";; esac`,
    );
  });
});

describe("collection", () => {
  it("calls every check reachable online", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(0, "0 3\n1 45\n", ""));
    expect(latest_status(monitor)).toBe("online");
    expect(latest_metric(monitor, "ssh_up")).toBeCloseTo(1.0);
    expect(latest_metric(monitor, "ssh_latency_ms")).toBeCloseTo(3.0);
    expect(latest_metric(monitor, "api_latency_ms")).toBeCloseTo(45.0);
  });

  it("fails one check down", () => {
    const monitor = plugin();
    const result = run_cycle(monitor, () => cmd_result(0, "0 3\n1 FAIL\n", ""));
    expect(latest_status(monitor)).toBe("failed");
    expect(latest_metric(monitor, "api_up")).toBeCloseTo(0.0);
    expect(result.logs[0][0]).toBe("1 check(s) down: API");
  });

  it("calls no checks unavailable", () => {
    const monitor = make_plugin(Ports, { ...base_config(), checks: [] });
    run_cycle(monitor);
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a transport failure unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(-1, "", "err"));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a probe that never ran unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(127, "", "sh: curl: not found"));
    expect(latest_status(monitor)).toBe("unavailable");
    expect(latest_metric(monitor, "api_up")).toBeNull();
  });

  it("labels an unnamed check", () => {
    const monitor = make_plugin(Ports, { ...base_config(), checks: [{ host: "1.2.3.4", port: 80 }] });
    expect(monitor.checks[0].name).toBe("1.2.3.4:80");
    expect(monitor.checks[0].metric).toBe("1_2_3_4_80");
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(plugin().plan_action("anything")).toBeNull();
  });
});

describe("page", () => {
  it("gives every check a labeled uptime strip in one panel", () => {
    expect(plugin().UI_SPEC.cards!.strips).toEqual({
      kind: "strip",
      title: "AVAILABILITY",
      rows: [{ metric: "ssh_up", label: "SSH" }, { metric: "api_up", label: "API" }],
    });
  });

  it("puts the strips above the latency charts", () => {
    expect(plugin().UI_SPEC.layout).toEqual([
      ["host_card", "up_card", "down_card"],
      ["strips"],
      ["chart_ssh"], ["chart_api"],
      ["events"],
    ]);
  });

  it("draws no strip panel without checks", () => {
    expect(make_plugin(Ports, { checks: [] }).UI_SPEC.cards!.strips).toBeUndefined();
  });

  it("keeps the reachable and down counts", () => {
    const cards = plugin().UI_SPEC.cards!;
    expect(cards.up_card).toBeDefined();
    expect(cards.down_card).toBeDefined();
  });

  it("counts reachable and down checks from the latest metrics", () => {
    const monitor = plugin();
    expect(monitor.up_text).toBe("--");
    run_cycle(monitor, () => cmd_result(0, "0 3\n1 FAIL\n", ""));
    expect(monitor.up_text).toBe("1/2");
    expect(monitor.down_text).toBe("1");
    expect(monitor.down_color).toBe("failed");
  });
});
