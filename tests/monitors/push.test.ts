import { describe, expect, it } from "vitest";

import { CollectResult } from "../../src/core/connectors/types.ts";
import { is_pushable } from "../../src/core/contracts.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Push } from "../../src/monitors/push.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const push = (extra: PluginConfig = {}): Push => make_plugin(Push, { name: "test-push", id: "test-push", interval: 60, token: "secret", ...extra });
const latest_status = (plugin: Push) => store_of(plugin).latest_status("test-push");
const latest_metric = (plugin: Push, name: string) => store_of(plugin).latest_metric("test-push", name)?.value ?? null;

describe("collection", () => {
  it("fails a monitor never pushed", () => {
    const plugin = push();
    run_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a recent push online", () => {
    const plugin = push({ max_age: 120 });
    plugin.record_push("up");
    run_cycle(plugin);
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a stale push", () => {
    const plugin = push({ max_age: 60 });
    plugin.record_push("up");
    store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, new CollectResult({ metrics: { last_push_epoch: Date.now() / 1000 - 120 } }));
    run_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("defaults max_age to twice the interval", () => expect(push({ interval: 30 }).max_age).toBe(60));

  it("fails a down report within max_age", () => {
    const plugin = push({ max_age: 120 });
    plugin.record_push("down", "disk full");
    run_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });
});

describe("record push", () => {
  it("calls an up push online", () => {
    const plugin = push();
    expect(plugin.record_push("up")).toBe(true);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "reported_up")).toBeCloseTo(1.0);
  });

  it("fails a down push", () => {
    const plugin = push();
    expect(plugin.record_push("down")).toBe(true);
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "reported_up")).toBeCloseTo(0.0);
  });

  it("refuses an invalid status", () => expect(push().record_push("sideways")).toBe(false));

  it("stores a value", () => {
    const plugin = push();
    plugin.record_push("up", null, 42.5);
    expect(latest_metric(plugin, "value")).toBeCloseTo(42.5);
  });

  it("stores no value without one", () => {
    const plugin = push();
    plugin.record_push("up");
    expect(latest_metric(plugin, "value")).toBeNull();
  });

  it("is pushable", () => expect(is_pushable(push())).toBe(true));
});

describe("actions", () => {
  it("plans no action", () => expect(push().plan_action("anything")).toBeNull());

  it("names the token that sent a push", () => {
    const plugin = push();
    plugin.record_push("up", "nightly ok", null, "token 'ci'");
    const messages = store_of(plugin).recent_events(50).map((event) => event.message);
    expect(messages.some((message) => message.includes("Heartbeat received (status=up) via token 'ci': nightly ok"))).toBe(true);
  });
});

describe("page", () => {
  it("draws the reported status as an uptime strip", () => {
    const spec = push().UI_SPEC;
    expect(spec.cards!.uptime_strip.kind).toBe("strip");
    expect(spec.cards!.uptime_strip.metric).toBe("reported_up");
    expect(spec.layout).toContainEqual(["uptime_strip"]);
  });

  it("names the last heartbeat", () => {
    const plugin = push();
    expect(plugin.last_heartbeat_text).toBe("Never");
    plugin.record_push("up");
    expect(plugin.last_heartbeat_text).toMatch(/ago$/);
  });
});
