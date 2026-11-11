import { describe, expect, it } from "vitest";

import { cmd_result, ping_result, type ActionPlan, type CollectResult, type IoActionPlan } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { magic_packet } from "@x-tech-laboratories/x-libs/agent/wake";
import { python_format, Uptime } from "../../src/monitors/uptime.ts";
import { make_plugin, run_requests, store_of } from "../harness.ts";

const uptime_config: PluginConfig = { name: "test-uptime", id: "test-uptime", target_host: "example.host", interval: 30 };

const plugin = () => make_plugin(Uptime, uptime_config);

function ping(returncode: number | null, stdout = "", stderr = "", exception: string | null = null) {
  return () => ping_result(exception, returncode, stdout, stderr);
}

const latest_status = (monitor: Uptime) => store_of(monitor).store.statuses.get("test-uptime")?.state ?? null;
const latest_metric = (monitor: Uptime, name: string) => store_of(monitor).latest_metric("test-uptime", name)?.value ?? null;

describe("collection", () => {
  it("calls a reply online", () => {
    const monitor = plugin();
    run_requests(monitor, ping(0, "64 bytes from example.host: icmp_seq=1 ttl=64 time=5.2 ms\n"));
    expect(latest_status(monitor)).toBe("online");
  });

  it("records latency", () => {
    const monitor = plugin();
    run_requests(monitor, ping(0, "64 bytes from 1.2.3.4: icmp_seq=1 ttl=64 time=12.5 ms\n"));
    expect(latest_metric(monitor, "latency_ms")).toBeCloseTo(12.5);
  });

  it("records the up metric", () => {
    const monitor = plugin();
    run_requests(monitor, ping(0, "1 packets transmitted, 1 received, time=1.0 ms\n"));
    expect(latest_metric(monitor, "up")).toBeCloseTo(1.0);
  });

  it("fails no reply", () => {
    const monitor = plugin();
    run_requests(monitor, ping(1, "", "Request timed out"));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("records up as zero on no reply", () => {
    const monitor = plugin();
    run_requests(monitor, ping(1, "", "Network unreachable"));
    expect(latest_metric(monitor, "up")).toBeCloseTo(0.0);
  });

  it("fails a ping that could not run", () => {
    const monitor = plugin();
    run_requests(monitor, ping(null, "", "", "ping not found"));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("records no latency on failure", () => {
    const monitor = plugin();
    run_requests(monitor, ping(1));
    expect(latest_metric(monitor, "latency_ms")).toBeNull();
  });

  it("records no latency missing from the output", () => {
    const monitor = plugin();
    run_requests(monitor, ping(0, "1 packets transmitted, 1 received\n"));
    expect(latest_status(monitor)).toBe("online");
    expect(latest_metric(monitor, "latency_ms")).toBeNull();
  });
});

describe("actions", () => {
  it("handles no other action", () => {
    const monitor = plugin();
    expect(monitor.plan_action("restart")).toBeNull();
    expect(monitor.plan_action("anything")).toBeNull();
  });

  it("offers no wake without a mac", () => {
    const monitor = plugin();
    expect(monitor.plan_action("wake")).toBeNull();
    expect(monitor.UI_SPEC.buttons).toBeUndefined();
    expect(monitor.on_status("failed", 0.0)).toBeNull();
  });
});

const mac = "00:11:22:33:44:55";

function waker(extra: PluginConfig = {}): Uptime {
  return make_plugin(Uptime, { ...uptime_config, mac, ...extra });
}

// Swaps the local send for one that records each call, or fails with `error`.
function record_sends(monitor: Uptime, error: Error | null = null): [Buffer, string, number][] {
  const sent: [Buffer, string, number][] = [];
  monitor.send_packet = async (packet, address, port) => {
    sent.push([packet, address, port]);
    if (error) throw error;
  };
  return sent;
}

describe("wake", () => {
  it("sends from the X-Monitor server by default", async () => {
    const monitor = waker();
    const sent = record_sends(monitor);
    const plan = monitor.plan_action("wake") as IoActionPlan;
    expect(plan.kind).toBe("io_action");
    expect(await plan.call()).toBeNull();
    expect(sent).toEqual([[magic_packet(mac), "255.255.255.255", 9]]);
  });

  it("takes a configured broadcast, port and password", async () => {
    const monitor = waker({ wol_broadcast: "192.168.1.255", wol_port: 7, wol_password: "01:02:03:04:05:06" });
    const sent = record_sends(monitor);
    await (monitor.plan_action("wake") as IoActionPlan).call();
    expect(sent).toEqual([[magic_packet(mac, "01:02:03:04:05:06"), "192.168.1.255", 7]]);
  });

  it("reports a refused send", async () => {
    const monitor = waker();
    record_sends(monitor, new Error("Network is unreachable"));
    const error = await (monitor.plan_action("wake") as IoActionPlan).call();
    const outcome = monitor.interpret_action("wake", error) as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.logs[0][0]).toContain("Network is unreachable");
  });

  it("logs a success", () => {
    const outcome = waker().interpret_action("wake", null) as CollectResult;
    expect(outcome.success).toBe(true);
    expect(outcome.logs).toEqual([[`Wake-on-LAN packet for ${mac} sent to 255.255.255.255:9`, "INFO"]]);
  });

  it("reports a bad mac rather than throwing", () => {
    const outcome = make_plugin(Uptime, { ...uptime_config, mac: "not-a-mac" }).plan_action("wake") as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][0]).toContain("not a MAC address");
  });

  it("wakes through another monitor", () => {
    const plan = waker({ wake_via: "host1-ssh", wol_broadcast: "10.0.2.255" }).plan_action("wake") as ActionPlan;
    expect(plan.kind).toBe("action_plan");
    expect(plan.via).toBe("host1-ssh");
    expect(plan.timeout).toBe(30);
    expect(plan.command).toContain("python3 -c");
    expect(plan.command).toContain("10.0.2.255");
  });

  it("formats a wake_command override", () => {
    const plan = waker({ wake_via: "host1-ssh", wake_command: "wakeonlan -i {broadcast} -p {port} {mac}" }).plan_action("wake") as ActionPlan;
    expect(plan.command).toBe(`wakeonlan -i 255.255.255.255 -p 9 ${mac}`);
  });

  it("reports a bad wake_command", () => {
    const outcome = waker({ wake_via: "host1-ssh", wake_command: "etherwake {iface}" }).plan_action("wake") as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][0]).toContain("bad wake_command");
    expect(outcome.logs[0][0]).toContain("bad wake_command (KeyError('iface'))");
  });

  it("reads remote outcomes", () => {
    const monitor = waker({ wake_via: "host1-ssh" });
    const ok = monitor.interpret_action("wake", cmd_result(0, "", "")) as CollectResult;
    expect(ok.success).toBe(true);
    expect(ok.logs[0][0]).toContain("from monitor host1-ssh");
    const failed = monitor.interpret_action("wake", cmd_result(127, "", "needs python3 or socat")) as CollectResult;
    expect(failed.success).toBe(false);
    expect(failed.logs[0][0]).toContain("needs python3 or socat");
  });

  it("confirms the button with the host", () => {
    const spec = waker().UI_SPEC;
    expect(spec.layout).toContainEqual(["wake"]);
    expect(spec.buttons!.wake[0].confirm).toBe("Send a Wake-on-LAN packet to {plugin.target} ({plugin.mac})?");
  });
});

describe("python format", () => {
  it("fills named fields and literal braces", () => {
    expect(python_format("{{x}} {a}-{b}", { a: "1", b: 2 })).toBe("{x} 1-2");
  });

  it("names an unknown field, a positional field and a stray brace as Python does", () => {
    expect(() => python_format("{nope}", {})).toThrow("KeyError('nope')");
    expect(() => python_format("{}", {})).toThrow("IndexError('Replacement index 0 out of range for positional args tuple')");
    expect(() => python_format("a } b", {})).toThrow(`ValueError("Single '}' encountered in format string")`);
  });
});

describe("wake on down", () => {
  it("is off by default", () => {
    expect(waker().on_status("failed", 0.0)).toBeNull();
  });

  it("wakes when down then waits for the retry", () => {
    const monitor = waker({ wake_on_down: true, wake_retry: "10m" });
    expect(monitor.on_status("failed", 1000.0)).toEqual(["wake", { automatic: true, attempt: 1 }]);
    expect(monitor.on_status("failed", 1000.0 + 599)).toBeNull();
    expect(monitor.on_status("failed", 1000.0 + 600)).toEqual(["wake", { automatic: true, attempt: 2 }]);
  });

  it("gives up after the max until seen up", () => {
    const monitor = waker({ wake_on_down: true, wake_retry: 60, wake_max_attempts: 2 });
    expect(monitor.on_status("failed", 0.0)![1].attempt).toBe(1);
    expect(monitor.on_status("failed", 60.0)![1].attempt).toBe(2);
    expect(monitor.on_status("failed", 120.0)).toBeNull();
    expect(monitor.on_status("failed", 10_000.0)).toBeNull();
    expect(monitor.on_status("online", 10_060.0)).toBeNull();
    expect(monitor.on_status("failed", 10_120.0)).toEqual(["wake", { automatic: true, attempt: 1 }]);
  });

  it("wakes only on failed", () => {
    const monitor = waker({ wake_on_down: true });
    expect(monitor.on_status("online", 0.0)).toBeNull();
    expect(monitor.on_status("unavailable", 0.0)).toBeNull();
  });

  it("logs automatic attempts and says so on the last", () => {
    const monitor = waker({ wake_on_down: true, wake_max_attempts: 2 });
    const first = monitor.interpret_action("wake", null, { automatic: true, attempt: 1 }) as CollectResult;
    expect(first.logs[0][0].startsWith("Automatic wake 1 of 2: Wake-on-LAN packet")).toBe(true);
    const last = monitor.interpret_action("wake", null, { automatic: true, attempt: 2 }) as CollectResult;
    expect(last.logs[0][0].endsWith("no more automatic wakes until test-uptime is seen up again")).toBe(true);
  });

  it("mentions the automatic wake in the confirm", () => {
    expect(waker({ wake_on_down: true }).UI_SPEC.buttons!.wake[0].confirm).toContain("every 10 Minutes, up to 3 times");
  });
});

describe("page", () => {
  it("draws the up metric as an uptime strip", () => {
    const spec = plugin().UI_SPEC;
    expect(spec.cards!.uptime_strip).toEqual({ kind: "strip", metric: "up", title: "AVAILABILITY" });
    expect(spec.layout).toContainEqual(["uptime_strip"]);
  });

  it("keeps the status card and latency chart", () => {
    const spec = plugin().UI_SPEC;
    expect(spec.cards!.status_card.metric).toBe("up");
    expect(spec.chart!.metric).toBe("latency_ms");
  });
});
