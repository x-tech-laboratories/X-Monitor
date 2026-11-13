import { describe, expect, it } from "vitest";

import { dns_result, type DnsAnswer, type DnsResultKind } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { DnsRecord } from "../../src/monitors/dns_record.ts";
import { make_plugin, run_requests, store_of } from "../harness.ts";

const resolves = (answer: DnsAnswer) => () => dns_result("ok", answer);
const fails = (kind: DnsResultKind, error: string | null = null) => () => dns_result(kind, null, error);

const latest_status = (plugin: DnsRecord) => store_of(plugin).store.statuses.get("test-dns")?.state ?? null;
const latest_metric = (plugin: DnsRecord, name: string) => store_of(plugin).latest_metric("test-dns", name)?.value ?? null;

function config(extra: PluginConfig = {}): PluginConfig {
  return { name: "test-dns", id: "test-dns", domain: "example.com", ...extra };
}

function fake_answer(record_type: string, records: DnsAnswer["records"], ttl = 300): DnsAnswer {
  return { record_type, records, ttl };
}

describe("collection", () => {
  it("calls a resolving A record online", () => {
    const plugin = make_plugin(DnsRecord, config());
    run_requests(plugin, resolves(fake_answer("A", ["93.184.216.34"])));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "resolved")).toBeCloseTo(1.0);
  });

  it("records the ttl", () => {
    const plugin = make_plugin(DnsRecord, config());
    run_requests(plugin, resolves(fake_answer("A", ["93.184.216.34"], 600)));
    expect(latest_metric(plugin, "ttl")).toBeCloseTo(600.0);
  });

  it("fails on NXDOMAIN", () => {
    const plugin = make_plugin(DnsRecord, config());
    run_requests(plugin, fails("nxdomain"));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "resolved")).toBeCloseTo(0.0);
  });

  it("fails on no answer", () => {
    const plugin = make_plugin(DnsRecord, config({ record_type: "MX" }));
    run_requests(plugin, fails("no_answer"));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails on a timeout", () => {
    const plugin = make_plugin(DnsRecord, config());
    run_requests(plugin, fails("timeout"));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails on a query error", () => {
    const plugin = make_plugin(DnsRecord, config());
    run_requests(plugin, fails("dns_error", "bad"));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails without a domain", () => {
    const plugin = make_plugin(DnsRecord, config({ domain: null }));
    run_requests(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });
});

describe("expected values", () => {
  it("calls a matching value online", () => {
    const plugin = make_plugin(DnsRecord, config({ expected: ["93.184.216.34"] }));
    run_requests(plugin, resolves(fake_answer("A", ["93.184.216.34"])));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "matches_expected")).toBeCloseTo(1.0);
  });

  it("fails an unexpected value", () => {
    const plugin = make_plugin(DnsRecord, config({ expected: ["1.2.3.4"] }));
    const result = run_requests(plugin, resolves(fake_answer("A", ["93.184.216.34"])));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "matches_expected")).toBeCloseTo(0.0);
    expect(result.logs[0][0]).toBe("example.com (A) resolved to ['93.184.216.34'], expected one of ['1.2.3.4']");
  });

  it("skips matching without expected values", () => {
    const plugin = make_plugin(DnsRecord, config());
    run_requests(plugin, resolves(fake_answer("A", ["93.184.216.34"])));
    expect(latest_metric(plugin, "matches_expected")).toBeNull();
  });
});

describe("record type formatting", () => {
  it("matches an MX record", () => {
    const plugin = make_plugin(DnsRecord, config({ record_type: "MX", expected: ["10 mail.example.com"] }));
    run_requests(plugin, resolves(fake_answer("MX", [{ exchange: "mail.example.com", priority: 10 }])));
    expect(latest_status(plugin)).toBe("online");
  });

  it("matches a TXT record", () => {
    const plugin = make_plugin(DnsRecord, config({ record_type: "TXT", expected: ["v=spf1 -all"] }));
    run_requests(plugin, resolves(fake_answer("TXT", [["v=spf1 -all"]])));
    expect(latest_status(plugin)).toBe("online");
  });

  it("strips a CNAME's trailing dot", () => {
    const plugin = make_plugin(DnsRecord, config({ record_type: "CNAME", expected: ["target.example.net"] }));
    run_requests(plugin, resolves(fake_answer("CNAME", ["target.example.net."])));
    expect(latest_status(plugin)).toBe("online");
  });

  it("stores the answer values as a Python-style JSON setting", () => {
    const plugin = make_plugin(DnsRecord, config());
    const result = run_requests(plugin, resolves(fake_answer("A", ["1.1.1.1", "2.2.2.2"])));
    expect(result.settings["dns_record:test-dns"]).toBe('["1.1.1.1", "2.2.2.2"]');
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(make_plugin(DnsRecord, config()).plan_action("anything")).toBeNull();
  });
});

describe("query declaration", () => {
  it("carries a custom resolver", () => {
    const query = make_plugin(DnsRecord, config({ resolver: "1.1.1.1", port: 5353, timeout: 2 })).requests()[0];
    expect(query.kind).toBe("dns");
    expect(query).toMatchObject({ resolver: "1.1.1.1", port: 5353, timeout: 2 });
  });

  it("defaults to port 53 and the system resolver", () => {
    const query = make_plugin(DnsRecord, config()).requests()[0];
    expect(query).toMatchObject({ port: 53, resolver: null });
  });

  it("declares no query without a domain", () => {
    expect(make_plugin(DnsRecord, config({ domain: null })).requests()).toEqual([]);
  });
});

describe("page", () => {
  it("draws resolution as an uptime strip", () => {
    const spec = make_plugin(DnsRecord, config()).UI_SPEC;
    expect(spec.cards!.uptime_strip.kind).toBe("strip");
    expect(spec.cards!.uptime_strip.metric).toBe("resolved");
    expect(spec.layout).toContainEqual(["uptime_strip"]);
  });
});
