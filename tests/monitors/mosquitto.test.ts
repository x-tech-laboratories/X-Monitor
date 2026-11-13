import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { auth_flags, build_probe_script, MISMATCH, Mosquitto, TIMED_OUT } from "../../src/monitors/mosquitto.ts";
import { FORMATTERS } from "../../src/shared/ui_registry.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-mosquitto",
  id: "test-mosquitto",
  host: "127.0.0.1",
  port: 1883,
  username: "x-monitor",
  password: "hunter2",
  probe_topic: "x_monitor/probe/test-mosquitto",
  probe_timeout: 5,
  ssh_config: { host: "test.host" },
};

const plugin = () => make_plugin(Mosquitto, base_config);
const ok = (nonce = "x-monitor-probe-abc123") => () => cmd_result(0, nonce, "");
const failure = (stderr: string) => () => cmd_result(1, "", stderr);

const latest_status = (monitor: Mosquitto) => store_of(monitor).store.statuses.get("test-mosquitto")?.state ?? null;
const latest_metric = (monitor: Mosquitto, name: string) => store_of(monitor).latest_metric("test-mosquitto", name)?.value ?? null;

describe("auth flags", () => {
  it("has no auth without a username", () => {
    expect(auth_flags(null, null, null)).toBe("");
  });

  it("passes a username with a password", () => {
    const flags = auth_flags("x-monitor", null, "hunter2");
    expect(flags).toContain("-u x-monitor");
    expect(flags).toContain("-P hunter2");
  });

  it("reads a password command's output from a shell variable", () => {
    const flags = auth_flags("x-monitor", "cat /run/secrets/mosquitto_x_monitor", null);
    expect(flags).toContain("-u x-monitor");
    expect(flags).toContain('-P "$__pw"');
  });

  it("passes a username alone", () => {
    expect(auth_flags("x-monitor", null, null)).toBe("-u x-monitor");
  });
});

describe("probe script", () => {
  it("includes the topic", () => {
    expect(build_probe_script("127.0.0.1", 1883, "x_monitor/probe/x", 5, "x-monitor", null, "hunter2")).toContain("x_monitor/probe/x");
  });

  it("runs the password command on the remote host", () => {
    const script = build_probe_script("127.0.0.1", 1883, "x_monitor/probe/x", 5, "x-monitor", "cat /run/secrets/mosquitto_x_monitor", null);
    expect(script).toContain("cat /run/secrets/mosquitto_x_monitor");
  });

  it("uses pub and sub", () => {
    const script = build_probe_script("127.0.0.1", 1883, "x_monitor/probe/x", 5, null, null, null);
    expect(script).toContain("mosquitto_pub");
    expect(script).toContain("mosquitto_sub");
  });
});

describe("collection", () => {
  it("calls a round trip online", () => {
    const monitor = plugin();
    run_cycle(monitor, ok());
    expect(latest_status(monitor)).toBe("online");
  });

  it("records the round trip metrics", () => {
    const monitor = plugin();
    run_cycle(monitor, ok());
    expect(latest_metric(monitor, "roundtrip_ok")).toBe(1.0);
    expect(latest_metric(monitor, "roundtrip_ms")).not.toBeNull();
  });

  it("fails a timeout", () => {
    const monitor = plugin();
    run_cycle(monitor, failure(TIMED_OUT));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("records a timeout as a failed round trip", () => {
    const monitor = plugin();
    const result = run_cycle(monitor, failure(TIMED_OUT));
    expect(latest_metric(monitor, "roundtrip_ok")).toBe(0.0);
    expect(result.logs[0][0]).toContain("on 'x_monitor/probe/test-mosquitto' timed out after 5s");
  });

  it("fails a mismatch", () => {
    const monitor = plugin();
    run_cycle(monitor, failure(`${MISMATCH}: expected a, got b`));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("fails a script failure", () => {
    const monitor = plugin();
    run_cycle(monitor, failure("connection refused"));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("calls missing clients unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, failure("sh: mosquitto_sub: not found"));
    expect(latest_status(monitor)).toBe("unavailable");
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(plugin().plan_action("anything")).toBeNull();
  });
});

describe("page", () => {
  it("draws the round trip as an uptime strip", () => {
    const spec = plugin().UI_SPEC;
    expect(spec.cards!.uptime_strip.kind).toBe("strip");
    expect(spec.cards!.uptime_strip.metric).toBe("roundtrip_ok");
    expect(spec.layout).toContainEqual(["uptime_strip"]);
    expect(spec.chart!.metric).toBe("roundtrip_ms");
  });

  it("registers the round trip text", () => {
    expect(FORMATTERS.mosquitto_ok_text(1)).toBe("OK");
    expect(FORMATTERS.mosquitto_ok_text(null)).toBe("--");
  });
});
