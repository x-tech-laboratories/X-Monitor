import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { http_result, type CollectResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { DdnsUpdater } from "../../src/monitors/ddns_updater.ts";
import { make_test_plugin, run_io_cycle, store_of } from "../harness.ts";

const update_url = "https://freedns.example/update?h=home";

const latest_status = (plugin: DdnsUpdater) => store_of(plugin).store.statuses.get("test-ddns")?.state ?? null;
const latest_metric = (plugin: DdnsUpdater, name: string) => store_of(plugin).latest_metric("test-ddns", name)?.value ?? null;

function config(extra: PluginConfig = {}): PluginConfig {
  return { name: "test-ddns", id: "test-ddns", domain: "home.example.com", update_url, ...extra };
}

function ddns(extra: PluginConfig = {}) {
  return make_test_plugin(DdnsUpdater, config(extra));
}

function temp_path(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "ddns-")), name);
}

// Fixes what the public-IP fetch and the record lookup see, and spies on the update push.
function stub(plugin: DdnsUpdater, public_ip: string | null, dns_ip: string | null = null, push: [boolean, string] = [true, "Update accepted: good"]) {
  vi.spyOn(plugin, "fetch_public_ip").mockResolvedValue(public_ip);
  vi.spyOn(plugin, "resolve_public_record").mockResolvedValue(dns_ip);
  return vi.spyOn(plugin, "push_update").mockResolvedValue(push);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("in sync", () => {
  it("calls a matching ip online", async () => {
    const { plugin } = ddns();
    const push = stub(plugin, "1.2.3.4", "1.2.3.4");
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "in_sync")).toBeCloseTo(1.0);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("drift and update", () => {
  it("updates on drift", async () => {
    const { plugin } = ddns();
    const push = stub(plugin, "5.6.7.8", "1.2.3.4");
    await run_io_cycle(plugin);
    expect(push).toHaveBeenCalledExactlyOnceWith(update_url);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "in_sync")).toBeCloseTo(0.0);
  });

  it("updates the first drift soon after boot", async () => {
    const { plugin } = ddns();
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    const push = stub(plugin, "5.6.7.8", "1.2.3.4");
    await run_io_cycle(plugin);
    expect(push).toHaveBeenCalledOnce();
  });

  it("fails a failed update", async () => {
    const { plugin } = ddns();
    stub(plugin, "5.6.7.8", "1.2.3.4", [false, "Update rejected"]);
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("warns, not fails, on a throttled update", async () => {
    const { plugin } = ddns({ min_interval: 99999 });
    const push = stub(plugin, "5.6.7.8", "1.2.3.4");
    plugin.last_update_attempt = performance.now() / 1000;
    await run_io_cycle(plugin);
    expect(push).not.toHaveBeenCalled();
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails without an update url", async () => {
    const { plugin } = ddns({ update_url: null });
    vi.spyOn(plugin, "fetch_public_ip").mockResolvedValue("5.6.7.8");
    vi.spyOn(plugin, "resolve_public_record").mockResolvedValue("1.2.3.4");
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });
});

describe("failure modes", () => {
  it("calls a failed public-ip lookup unavailable", async () => {
    const { plugin } = ddns();
    vi.spyOn(plugin, "fetch_public_ip").mockResolvedValue(null);
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("fails without a domain", async () => {
    const { plugin } = ddns({ domain: null });
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("still updates when the record lookup fails", async () => {
    const { plugin } = ddns();
    const push = stub(plugin, "5.6.7.8", null);
    await run_io_cycle(plugin);
    expect(push).toHaveBeenCalledOnce();
  });

  it("tries each echo service until one answers", async () => {
    const { plugin, engine } = ddns();
    const asked: string[] = [];
    engine.http_fetch_handler = (request) => {
      asked.push(request.url);
      return asked.length === 1 ? http_result(null, "", { error: "refused" }) : http_result(200, "5.6.7.8\n");
    };
    expect(await plugin.fetch_public_ip()).toBe("5.6.7.8");
    expect(asked).toEqual(["https://api.ipify.org", "https://icanhazip.com"]);
  });
});

describe("update url resolution", () => {
  it("reads update_url_file", () => {
    const file = temp_path("url.txt");
    writeFileSync(file, "https://freedns.example/update?h=fromfile\n");
    const { plugin } = ddns({ update_url: null, update_url_file: file });
    expect(plugin.resolve_update_url()).toEqual(["https://freedns.example/update?h=fromfile", null]);
  });

  it("runs update_url_command", () => {
    const { plugin } = ddns({ update_url: null, update_url_command: "echo https://freedns.example/update?h=fromcmd" });
    expect(plugin.resolve_update_url()).toEqual(["https://freedns.example/update?h=fromcmd", null]);
  });

  it("prefers a direct update_url", () => {
    const file = temp_path("url.txt");
    writeFileSync(file, "https://freedns.example/update?h=fromfile");
    const { plugin } = ddns({ update_url_file: file });
    expect(plugin.resolve_update_url()).toEqual([update_url, null]);
  });

  it("returns nothing without a source", () => {
    const { plugin } = ddns({ update_url: null });
    expect(plugin.resolve_update_url()).toEqual([null, null]);
  });
});

describe("domain resolution", () => {
  it("reads domain_file", () => {
    const file = temp_path("domain.txt");
    writeFileSync(file, "fromfile.example.com\n");
    expect(ddns({ domain: null, domain_file: file }).plugin.domain).toBe("fromfile.example.com");
  });

  it("runs domain_command", () => {
    expect(ddns({ domain: null, domain_command: "echo fromcmd.example.com" }).plugin.domain).toBe("fromcmd.example.com");
  });

  it("prefers a direct domain", () => {
    const file = temp_path("domain.txt");
    writeFileSync(file, "fromfile.example.com");
    expect(ddns({ domain_file: file }).plugin.domain).toBe("home.example.com");
  });

  it("retries an unreadable domain_file", () => {
    const file = temp_path("domain.txt");
    const { plugin } = ddns({ domain: null, domain_file: file });
    expect(plugin.domain).toBeNull();
    writeFileSync(file, "late.example.com");
    expect(plugin.domain).toBe("late.example.com");
  });

  it("fails a missing domain_file", async () => {
    const { plugin } = ddns({ domain: null, domain_file: temp_path("absent") });
    await run_io_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
    expect(plugin.domain_error).toContain("Could not read domain_file");
  });
});

describe("push update", () => {
  async function push(status: number | null, text: string, error: string | null = null): Promise<boolean> {
    const { plugin, engine } = ddns();
    engine.http_fetch_handler = () => http_result(status, text, { error });
    const [ok] = await plugin.push_update(update_url);
    return ok;
  }

  it("accepts good", async () => {
    expect(await push(200, "good 5.6.7.8")).toBe(true);
  });

  it("accepts nochg", async () => {
    expect(await push(200, "nochg 5.6.7.8")).toBe(true);
  });

  it("rejects an error body", async () => {
    expect(await push(200, "ERROR: bad token")).toBe(false);
  });

  it("rejects a non-200 status", async () => {
    expect(await push(500, "good 5.6.7.8")).toBe(false);
  });

  it("rejects a request error", async () => {
    expect(await push(null, "", "boom")).toBe(false);
  });
});

describe("force update action", () => {
  it("pushes the update", async () => {
    const { plugin } = ddns();
    const push = vi.spyOn(plugin, "push_update").mockResolvedValue([true, "Update accepted: good"]);
    const plan = plugin.plan_action("force_update");
    expect((plan as { kind: string }).kind).toBe("io_action");
    const local_result = await (plan as { call: () => Promise<unknown> }).call();
    const outcome = plugin.interpret_action("force_update", local_result) as CollectResult;
    expect(outcome.success).toBe(true);
    expect(push).toHaveBeenCalledExactlyOnceWith(update_url);
  });

  it("fails without an update url", async () => {
    const { plugin } = ddns({ update_url: null });
    const plan = plugin.plan_action("force_update") as { call: () => Promise<unknown> };
    const outcome = plugin.interpret_action("force_update", await plan.call()) as CollectResult;
    expect(outcome.success).toBe(false);
  });

  it("handles no other action", () => {
    expect(ddns().plugin.plan_action("anything")).toBeNull();
  });

  it("lists force update", () => {
    expect(ddns().plugin.get_actions().map((action) => action.action_id)).toContain("force_update");
  });
});

describe("page", () => {
  it("draws the sync state as an uptime strip", () => {
    const spec = ddns().plugin.UI_SPEC;
    expect(spec.cards!.sync_strip.kind).toBe("strip");
    expect(spec.cards!.sync_strip.metric).toBe("in_sync");
    expect(spec.layout).toContainEqual(["sync_strip"]);
  });
});
