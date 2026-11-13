import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { python_dumps } from "@x-tech-laboratories/x-libs/python_text";

import { cmd_result, type ActionPlan, type CollectResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { build_blocking_script, build_fetch_script, build_gravity_script, format_age_compact, parse_response, Pihole, rate_is_checked, SCRIPT_SEP } from "../../src/monitors/pihole.ts";
import type { ColorRule } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-pihole",
  id: "test-pihole",
  api_url: "http://127.0.0.1:9018",
  block_rate_warning: 5,
  block_rate_threshold: 1,
  gravity_max_age: "8d",
  min_queries: 100,
  ssh_config: { host: "test.host" },
};

interface SummaryOptions {
  total?: number;
  blocked?: number;
  percent?: number;
  domains?: number;
  last_update?: number | null;
  active_clients?: number;
  forwarded?: number;
  cached?: number;
}

function summary({ total = 237819, blocked = 38288, percent = 16.1, domains = 347306, last_update = null, active_clients = 16, forwarded = 2344, cached = 196457 }: SummaryOptions = {}) {
  return {
    queries: { total, blocked, percent_blocked: percent as number | undefined, unique_domains: 1030, forwarded, cached },
    clients: { active: active_clients, total: 17 },
    gravity: { domains_being_blocked: domains, last_update: (last_update ?? Date.now() / 1000 - 3600) as number | undefined },
  };
}

function response(body: object | null = null, blocking = "enabled"): string {
  return `${python_dumps(body ?? summary())}\n${SCRIPT_SEP}\n${python_dumps({ blocking, timer: null })}`;
}

const plugin = (extra: PluginConfig = {}) => make_plugin(Pihole, { ...base_config, ...extra });

function respond(monitor: Pihole, body: object | null = null, blocking = "enabled") {
  return run_cycle(monitor, () => cmd_result(0, response(body, blocking), ""));
}

const latest_status = (monitor: Pihole) => store_of(monitor).store.statuses.get("test-pihole")?.state ?? null;
const latest_metric = (monitor: Pihole, name: string) => store_of(monitor).latest_metric("test-pihole", name)?.value ?? null;

describe("format age", () => {
  it("writes minutes", () => {
    expect(format_age_compact(1800)).toBe("30m");
  });

  it("writes hours and minutes", () => {
    expect(format_age_compact(5400)).toBe("1h 30m");
  });

  it("writes days and hours", () => {
    expect(format_age_compact(280800)).toBe("3d 6h");
  });
});

function fake_curl(log: string): string {
  return `#!/bin/sh
echo "argv: $*" >> ${log}
for a in "$@"; do
    case "$a" in
        @-) echo "stdin: $(cat)" >> ${log} ;;
        @/*) echo "file: $(cat "\${a#@}")" >> ${log} ;;
    esac
done
case "$*" in
    *"-X POST"*/api/auth*) echo '{"session": {"sid": "sid-value-123"}}' ;;
    *) echo '{}' ;;
esac
`;
}

describe.each([
  ["fetch", () => build_fetch_script("http://127.0.0.1:9018", 10, "echo hunter2pw", null)],
  ["blocking", () => build_blocking_script("http://127.0.0.1:9018", 10, "echo hunter2pw", null, true)],
  ["gravity", () => build_gravity_script("http://127.0.0.1:9018", 10, "echo hunter2pw", null)],
])("the %s script", (_name, build) => {
  it("keeps the password and session off every command line", () => {
    const folder = mkdtempSync(join(tmpdir(), "pihole-"));
    const log = join(folder, "curl.log");
    const curl = join(folder, "curl");
    writeFileSync(curl, fake_curl(log));
    chmodSync(curl, 0o755);
    spawnSync("sh", ["-c", build()], { env: { PATH: `${folder}:/usr/bin:/bin:/run/current-system/sw/bin` } });
    const lines = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
    const argv = lines.filter((line) => line.startsWith("argv:"));
    expect(argv.some((line) => line.includes("-X DELETE"))).toBe(true);
    expect(argv.filter((line) => line.includes("hunter2pw") || line.includes("sid-value-123"))).toEqual([]);
    expect(lines.some((line) => line.startsWith("stdin:") && line.includes("hunter2pw"))).toBe(true);
    expect(lines).toContain("file: X-FTL-SID: sid-value-123");
  });
});

describe("fetch script", () => {
  it("requests both endpoints", () => {
    const script = build_fetch_script("http://127.0.0.1:9018", 10, null, null);
    expect(script).toContain("/api/stats/summary");
    expect(script).toContain("/api/dns/blocking");
  });

  it("skips auth without a password", () => {
    const script = build_fetch_script("http://127.0.0.1:9018", 10, null, null);
    expect(script).not.toContain("X-FTL-SID");
    expect(script).not.toContain("/api/auth");
  });

  it("authenticates with a password", () => {
    const script = build_fetch_script("http://127.0.0.1:9018", 10, null, "hunter2");
    expect(script).toContain("/api/auth");
    expect(script).toContain("X-FTL-SID");
  });

  it("runs the password command on the remote host", () => {
    expect(build_fetch_script("http://127.0.0.1:9018", 10, "cat /run/secrets/pihole_api", null)).toContain("cat /run/secrets/pihole_api");
  });

  it("does not double a trailing slash", () => {
    expect(build_fetch_script("http://127.0.0.1:9018/", 10, null, null)).not.toContain("//api/stats");
  });
});

describe("parse response", () => {
  it("parses both payloads", () => {
    const [parsed_summary, blocking] = parse_response(response());
    expect((parsed_summary.queries as Record<string, unknown>).total).toBe(237819);
    expect(blocking.blocking).toBe("enabled");
  });

  it("throws without the separator", () => {
    expect(() => parse_response('{"queries": {}}')).toThrow("unexpected API response");
  });

  it("throws on a malformed summary", () => {
    expect(() => parse_response(`not json\n${SCRIPT_SEP}\n{"blocking": "enabled"}`)).toThrow("summary was not JSON");
  });

  it("names the cause of an auth error", () => {
    const body = python_dumps({ error: { message: "Unauthorized" } });
    expect(() => parse_response(`${body}\n${SCRIPT_SEP}\n{"blocking": "enabled"}`)).toThrow("api_password");
  });
});

describe("collection", () => {
  it("calls a healthy pihole online", () => {
    const monitor = plugin();
    respond(monitor);
    expect(latest_status(monitor)).toBe("online");
  });

  it("records the block rate", () => {
    const monitor = plugin();
    respond(monitor);
    expect(latest_metric(monitor, "block_rate_pct")).toBeCloseTo(16.1);
  });

  it("records the core metrics", () => {
    const monitor = plugin();
    respond(monitor);
    expect(latest_metric(monitor, "queries_total")).toBe(237819);
    expect(latest_metric(monitor, "gravity_domains")).toBe(347306);
    expect(latest_metric(monitor, "clients_active")).toBe(16);
    expect(latest_metric(monitor, "blocking_enabled")).toBe(1.0);
  });

  it("computes the block rate when the API omits it", () => {
    const monitor = plugin();
    const body = summary({ total: 1000, blocked: 250 });
    delete body.queries.percent_blocked;
    respond(monitor, body);
    expect(latest_metric(monitor, "block_rate_pct")).toBeCloseTo(25.0);
  });

  it("calls an API failure unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(1, "", "connection refused"));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a garbage response unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(0, "<html>404</html>", ""));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls an unreachable host unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(-1, "", "not connected"));
    expect(latest_status(monitor)).toBe("unavailable");
  });
});

describe("block rate limits", () => {
  it("warns on a low block rate", () => {
    const monitor = plugin();
    respond(monitor, summary({ total: 10000, blocked: 300, percent: 3.0 }));
    expect(latest_status(monitor)).toBe("warning");
  });

  it("fails a collapsed block rate", () => {
    const monitor = plugin();
    const result = respond(monitor, summary({ total: 10000, blocked: 20, percent: 0.2 }));
    expect(latest_status(monitor)).toBe("failed");
    expect(result.logs[0][0]).toContain("block rate 0.2% below 1%");
  });

  it("does not judge a low query volume", () => {
    const monitor = plugin();
    respond(monitor, summary({ total: 5, blocked: 0, percent: 0.0 }));
    expect(latest_status(monitor)).toBe("online");
  });

  it("does not fail at the threshold itself", () => {
    const monitor = plugin();
    respond(monitor, summary({ total: 10000, blocked: 100, percent: 1.0 }));
    expect(latest_status(monitor)).toBe("warning");
  });
});

describe("gravity health", () => {
  it("fails an empty gravity list", () => {
    const monitor = plugin();
    respond(monitor, summary({ domains: 0 }));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("warns on a stale gravity list", () => {
    const monitor = plugin();
    respond(monitor, summary({ last_update: Date.now() / 1000 - 86400 * 30 }));
    expect(latest_status(monitor)).toBe("warning");
  });

  it("keeps a fresh gravity list online", () => {
    const monitor = plugin();
    respond(monitor, summary({ last_update: Date.now() / 1000 - 3600 }));
    expect(latest_status(monitor)).toBe("online");
  });

  it("records the gravity age", () => {
    const monitor = plugin();
    respond(monitor, summary({ last_update: Date.now() / 1000 - 7200 }));
    expect(Math.abs(latest_metric(monitor, "gravity_age_seconds")! - 7200)).toBeLessThanOrEqual(60);
  });

  it("warns when gravity never ran", () => {
    const monitor = plugin();
    const body = summary();
    delete body.gravity.last_update;
    respond(monitor, body);
    expect(latest_status(monitor)).toBe("warning");
  });
});

describe("blocking disabled", () => {
  it("fails disabled blocking", () => {
    const monitor = plugin();
    respond(monitor, null, "disabled");
    expect(latest_status(monitor)).toBe("failed");
  });

  it("records disabled blocking", () => {
    const monitor = plugin();
    respond(monitor, null, "disabled");
    expect(latest_metric(monitor, "blocking_enabled")).toBe(0.0);
  });

  it("outranks a healthy block rate", () => {
    const monitor = plugin();
    respond(monitor, summary({ percent: 16.1 }), "disabled");
    expect(latest_status(monitor)).toBe("failed");
  });

  it("lets the worst condition win", () => {
    const monitor = plugin();
    respond(monitor, summary({ domains: 0, last_update: Date.now() / 1000 - 86400 * 30 }));
    expect(latest_status(monitor)).toBe("failed");
  });
});

describe("block rate turned off", () => {
  const off = () => plugin({ block_rate_warning: 0, block_rate_threshold: 0 });

  it("is off only when both limits are zero", () => {
    expect(rate_is_checked(5, 1)).toBe(true);
    expect(rate_is_checked(5, 0)).toBe(true);
    expect(rate_is_checked(0, 1)).toBe(true);
    expect(rate_is_checked(0, 0)).toBe(false);
  });

  it.each([0.0, 0.4, 2.0, 50.0])("leaves the card unstyled at %s%%", (rate) => {
    expect(off().block_rate_color(rate)).toBeNull();
  });

  it.each([[0.4, "failed"], [2.0, "warning"], [50.0, "online"]] as const)("still colours %s%% when limits are set", (rate, expected) => {
    expect(plugin().block_rate_color(rate)).toBe(expected);
  });

  it("keeps a zero block rate online", () => {
    const monitor = off();
    respond(monitor, summary({ percent: 0.0 }));
    expect(latest_status(monitor)).toBe("online");
  });

  it("still records the rate", () => {
    const monitor = off();
    respond(monitor, summary({ percent: 0.0 }));
    expect(latest_metric(monitor, "block_rate_pct")).toBeCloseTo(0.0);
  });

  it("still fails disabled blocking", () => {
    const monitor = off();
    respond(monitor, summary({ percent: 0.0 }), "disabled");
    expect(latest_status(monitor)).toBe("failed");
  });

  it("still fails an empty gravity list", () => {
    const monitor = off();
    respond(monitor, summary({ percent: 0.0, domains: 0 }));
    expect(latest_status(monitor)).toBe("failed");
  });
});

describe("optional block rate limits", () => {
  it("counts a null limit as off", () => {
    expect(rate_is_checked(5, null)).toBe(true);
    expect(rate_is_checked(null, 1)).toBe(true);
    expect(rate_is_checked(null, null)).toBe(false);
    expect(rate_is_checked(0, null)).toBe(false);
  });

  it("never fails with a warning only", () => {
    const monitor = plugin({ block_rate_threshold: null });
    respond(monitor, summary({ total: 10000, blocked: 0, percent: 0.0 }));
    expect(latest_status(monitor)).toBe("warning");
    expect(monitor.block_rate_color(0.0)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const monitor = plugin({ block_rate_warning: null });
    respond(monitor, summary({ total: 10000, blocked: 300, percent: 3.0 }));
    expect(latest_status(monitor)).toBe("online");
    respond(monitor, summary({ total: 10000, blocked: 20, percent: 0.2 }));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("stops judging the rate with both null", () => {
    const monitor = plugin({ block_rate_warning: null, block_rate_threshold: null });
    respond(monitor, summary({ total: 10000, blocked: 0, percent: 0.0 }));
    expect(latest_status(monitor)).toBe("online");
    expect(monitor.block_rate_color(0.0)).toBeNull();
  });
});

describe("blocking script", () => {
  it("posts to the blocking endpoint", () => {
    const script = build_blocking_script("http://127.0.0.1:9018", 10, null, null, true);
    expect(script).toContain("/api/dns/blocking");
    expect(script).toContain('"blocking": true');
  });

  it("sends a disabled body", () => {
    expect(build_blocking_script("http://127.0.0.1:9018", 10, null, null, false)).toContain('"blocking": false');
  });

  it("authenticates with a password", () => {
    const script = build_blocking_script("http://127.0.0.1:9018", 10, null, "hunter2", true);
    expect(script).toContain("/api/auth");
    expect(script).toContain("X-FTL-SID");
  });

  it("runs the password command on the remote host", () => {
    expect(build_blocking_script("http://127.0.0.1:9018", 10, "cat /run/secrets/pihole_api", null, true)).toContain("cat /run/secrets/pihole_api");
  });
});

describe("gravity script", () => {
  it("hits the gravity endpoint", () => {
    expect(build_gravity_script("http://127.0.0.1:9018", 120, null, null)).toContain("/api/action/gravity");
  });

  it("authenticates with a password", () => {
    const script = build_gravity_script("http://127.0.0.1:9018", 120, null, "hunter2");
    expect(script).toContain("/api/auth");
    expect(script).toContain("X-FTL-SID");
  });
});

describe("actions", () => {
  it("offers a blocking switch and a gravity update", () => {
    expect(plugin().get_actions()).toEqual([
      { name: "Blocking", kind: "toggle", metric: "blocking_enabled", icon: "shield", on_action_id: "enable_blocking", off_action_id: "disable_blocking" },
      { name: "Update Gravity", action_id: "update_gravity", variant: "secondary", icon: "refresh" },
    ]);
  });

  it("disables blocking", () => {
    const monitor = plugin();
    expect((monitor.plan_action("disable_blocking") as ActionPlan).command).toContain('"blocking": false');
    const outcome = monitor.interpret_action("disable_blocking", cmd_result(0, "", "")) as CollectResult;
    expect(outcome.success).toBe(true);
    expect(outcome.logs).toEqual([["Blocking disabled", "INFO"]]);
  });

  it("reports a failed disable", () => {
    const outcome = plugin().interpret_action("disable_blocking", cmd_result(1, "", "connection refused")) as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][0]).toContain("disable");
  });

  it("handles no other action", () => {
    expect(plugin().plan_action("anything")).toBeNull();
  });

  it("enables blocking", () => {
    const monitor = plugin();
    const plan = monitor.plan_action("enable_blocking") as ActionPlan;
    expect(plan.command).toContain("/api/dns/blocking");
    expect(plan.command).toContain('"blocking": true');
    expect((monitor.interpret_action("enable_blocking", cmd_result(0, "", "")) as CollectResult).success).toBe(true);
  });

  it("reports a failed enable", () => {
    expect((plugin().interpret_action("enable_blocking", cmd_result(1, "", "connection refused")) as CollectResult).success).toBe(false);
  });

  it("updates gravity", () => {
    const monitor = plugin();
    expect((monitor.plan_action("update_gravity") as ActionPlan).command).toContain("/api/action/gravity");
    expect((monitor.interpret_action("update_gravity", cmd_result(0, "", "")) as CollectResult).success).toBe(true);
  });

  it("reports a failed gravity update", () => {
    expect((plugin().interpret_action("update_gravity", cmd_result(1, "", "timed out")) as CollectResult).success).toBe(false);
  });

  it("gives the gravity update its own timeout", () => {
    const monitor = plugin();
    expect((monitor.plan_action("update_gravity") as ActionPlan).timeout).toBe(monitor.gravity_timeout);
  });
});

describe("page", () => {
  it("draws the block rate as a gauge keeping its threshold colour", () => {
    const card = plugin().UI_SPEC.cards!.block_rate_card;
    expect(card.kind).toBe("gauge");
    expect(card.metric).toBe("block_rate_pct");
    expect((card.color as ColorRule)(0.4)).toBe("failed");
  });

  it("draws queries as a share of blocked, forwarded and cached", () => {
    const card = plugin().UI_SPEC.cards!.queries_card;
    expect(card.kind).toBe("share");
    expect(card.parts!.map((part) => part.metric)).toEqual(["queries_blocked", "queries_forwarded", "queries_cached"]);
  });

  it("keeps the block rate history chart", () => {
    expect(plugin().UI_SPEC.chart!.metric).toBe("block_rate_pct");
  });
});
