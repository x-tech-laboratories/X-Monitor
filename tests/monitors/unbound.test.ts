import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { build_probe_script, parse_stats, resolved_ok, SCRIPT_SEP, split_response, Unbound } from "../../src/monitors/unbound.ts";
import { FORMATTERS } from "../../src/shared/ui_registry.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-unbound",
  id: "test-unbound",
  query_domain: "cloudflare.com",
  servfail_warning: 5,
  servfail_threshold: 20,
  min_queries: 20,
  ssh_config: { host: "test.host" },
};

function stats({ total = 5000, hits = 4200, miss = 800, servfail = 0, uptime = 86400 } = {}): string {
  return `total.num.queries=${total}\ntotal.num.cachehits=${hits}\ntotal.num.cachemiss=${miss}\ntotal.num.servfail=${servfail}\ntotal.num.uptime=${uptime}\n`;
}

const query_ok = () => ";; ->>HEADER<<- opcode: QUERY, rcode: NOERROR, id: 1";
const query_fail = () => ";; ->>HEADER<<- opcode: QUERY, rcode: SERVFAIL, id: 1";

function response(stats_raw: string | null = null, query_raw: string | null = null): string {
  return `${stats_raw ?? stats()}\n${SCRIPT_SEP}\n${query_raw ?? query_ok()}`;
}

const plugin = (extra: PluginConfig = {}) => make_plugin(Unbound, { ...base_config, ...extra });

function respond(monitor: Unbound, stats_raw: string | null = null, query_raw: string | null = null) {
  return run_cycle(monitor, () => cmd_result(0, response(stats_raw, query_raw), ""));
}

const latest_status = (monitor: Unbound) => store_of(monitor).store.statuses.get("test-unbound")?.state ?? null;
const latest_metric = (monitor: Unbound, name: string) => store_of(monitor).latest_metric("test-unbound", name)?.value ?? null;

describe("probe script", () => {
  const script = build_probe_script("unbound-control stats_noreset", "127.0.0.1", 53, "cloudflare.com", 5);

  it("includes the control command", () => {
    expect(script).toContain("unbound-control stats_noreset");
  });

  it("includes the query domain", () => {
    expect(script).toContain("cloudflare.com");
  });

  it("uses dig", () => {
    expect(script).toContain("dig");
  });
});

describe("parse stats", () => {
  it("parses key=value lines", () => {
    const parsed = parse_stats(stats({ total: 1000, servfail: 5 }));
    expect(parsed["total.num.queries"]).toBe(1000);
    expect(parsed["total.num.servfail"]).toBe(5);
  });

  it("skips lines without an equals sign", () => {
    expect(parse_stats("garbage line\ntotal.num.queries=10\n")["total.num.queries"]).toBe(10);
  });

  it("skips non-numeric values", () => {
    const parsed = parse_stats("some.key=notanumber\ntotal.num.queries=10\n");
    expect(parsed).not.toHaveProperty("some.key");
    expect(parsed["total.num.queries"]).toBe(10);
  });
});

describe("resolved ok", () => {
  it("accepts NOERROR", () => {
    expect(resolved_ok(query_ok())).toBe(true);
  });

  it("rejects SERVFAIL", () => {
    expect(resolved_ok(query_fail())).toBe(false);
  });

  it("rejects empty output", () => {
    expect(resolved_ok("")).toBe(false);
  });
});

describe("split response", () => {
  it("splits on the separator", () => {
    const [stats_raw, query_raw] = split_response(response());
    expect(stats_raw).toContain("total.num.queries");
    expect(query_raw).toContain("NOERROR");
  });

  it("throws without the separator", () => {
    expect(() => split_response("no separator here")).toThrow("unexpected control output");
  });
});

describe("collection", () => {
  it("calls a healthy resolver online", () => {
    const monitor = plugin();
    respond(monitor);
    expect(latest_status(monitor)).toBe("online");
  });

  it("records the metrics", () => {
    const monitor = plugin();
    const result = respond(monitor, stats({ total: 5000, hits: 4200, miss: 800, servfail: 0 }));
    expect(latest_metric(monitor, "queries_total")).toBe(5000);
    expect(latest_metric(monitor, "resolved_ok")).toBe(1.0);
    expect(latest_metric(monitor, "cache_hit_rate_pct")).toBeCloseTo(84.0);
    expect(result.logs[0][0]).toBe("resolved OK | 0.0% SERVFAIL | 5,000 queries | 84.0% cache hit");
  });

  it("calls a failed script unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(1, "", "connection refused"));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a missing control tool unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(127, "", "unbound-control: command not found"));
    expect(latest_status(monitor)).toBe("unavailable");
    expect(latest_metric(monitor, "queries_total")).toBeNull();
  });

  it("calls garbage output unavailable", () => {
    const monitor = plugin();
    run_cycle(monitor, () => cmd_result(0, "no separator", ""));
    expect(latest_status(monitor)).toBe("unavailable");
  });
});

describe("resolution failure", () => {
  it("fails a failed resolution", () => {
    const monitor = plugin();
    respond(monitor, null, query_fail());
    expect(latest_status(monitor)).toBe("failed");
  });

  it("records the failed resolution", () => {
    const monitor = plugin();
    respond(monitor, null, query_fail());
    expect(latest_metric(monitor, "resolved_ok")).toBe(0.0);
  });
});

describe("servfail limits", () => {
  it("fails a high SERVFAIL rate", () => {
    const monitor = plugin();
    const result = respond(monitor, stats({ total: 1000, servfail: 250 }));
    expect(latest_status(monitor)).toBe("failed");
    expect(result.logs[0][0]).toContain("SERVFAIL rate 25.0% >= 20.0%");
  });

  it("warns on a moderate SERVFAIL rate", () => {
    const monitor = plugin();
    respond(monitor, stats({ total: 1000, servfail: 80 }));
    expect(latest_status(monitor)).toBe("warning");
  });

  it("does not judge a low query volume", () => {
    const monitor = plugin();
    respond(monitor, stats({ total: 5, servfail: 5 }));
    expect(latest_status(monitor)).toBe("online");
  });

  it("lets the worst condition win", () => {
    const monitor = plugin();
    respond(monitor, stats({ total: 1000, servfail: 250 }), query_fail());
    expect(latest_status(monitor)).toBe("failed");
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(plugin().plan_action("anything")).toBeNull();
  });
});

describe("page", () => {
  it("draws the cache hit rate as a gauge", () => {
    const card = plugin().UI_SPEC.cards!.cache_card;
    expect(card.kind).toBe("gauge");
    expect(card.metric).toBe("cache_hit_rate_pct");
  });

  it("keeps the servfail chart", () => {
    expect(plugin().UI_SPEC.chart!.metric).toBe("servfail_rate_pct");
  });

  it("writes the uptime as days and hours", () => {
    expect(FORMATTERS.unbound_uptime(90000)).toBe("1d 1h");
    expect(FORMATTERS.unbound_uptime(7200)).toBe("2h");
  });
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const monitor = plugin({ servfail_threshold: null });
    respond(monitor, stats({ total: 1000, servfail: 900 }));
    expect(latest_status(monitor)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const monitor = plugin({ servfail_warning: null });
    respond(monitor, stats({ total: 1000, servfail: 80 }));
    expect(latest_status(monitor)).toBe("online");
    respond(monitor, stats({ total: 1000, servfail: 250 }));
    expect(latest_status(monitor)).toBe("failed");
  });
});
