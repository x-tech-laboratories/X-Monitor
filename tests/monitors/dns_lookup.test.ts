import { describe, expect, it } from "vitest";

import { dns_query, dns_result, type DnsAnswer } from "../../src/core/connectors/types.ts";
import { answer_values, failure_message, record_type, resolve_now, type ResolverLike } from "../../src/monitors/base/dns_lookup.ts";
import { DdnsUpdater } from "../../src/monitors/ddns_updater.ts";

function answer(rtype: string, ...records: DnsAnswer["records"]): DnsAnswer {
  return { record_type: rtype, records, ttl: 300 };
}

describe("record type", () => {
  it("is upper-cased", () => {
    expect(record_type("aaaa")).toBe("AAAA");
  });

  it("defaults to A", () => {
    expect(record_type(null)).toBe("A");
  });
});

describe("answer values", () => {
  it("reads an A record", () => {
    expect(answer_values("A", answer("A", "1.2.3.4"))).toEqual(["1.2.3.4"]);
  });

  it("drops a CNAME's trailing dot", () => {
    expect(answer_values("CNAME", answer("CNAME", "target.example.net."))).toEqual(["target.example.net"]);
  });

  it("writes MX as preference and host", () => {
    expect(answer_values("MX", answer("MX", { exchange: "mail.example.com", priority: 10 }))).toEqual(["10 mail.example.com"]);
  });

  it("joins TXT chunks unquoted", () => {
    expect(answer_values("TXT", answer("TXT", ["v=spf1 ", "-all"]))).toEqual(["v=spf1 -all"]);
  });
});

describe("failure message", () => {
  const query = dns_query("example.com", { record_type: "MX", timeout: 2.0 });

  it("has none for an answer", () => {
    expect(failure_message(dns_result("ok"), query)).toBeNull();
  });

  it.each([
    ["nxdomain", "example.com does not exist (NXDOMAIN)"],
    ["no_answer", "example.com has no MX record"],
    ["timeout", "Query for example.com (MX) timed out after 2.0s"],
  ] as const)("names a %s failure", (kind, text) => {
    expect(failure_message(dns_result(kind), query)).toBe(text);
  });

  it("carries an error's message", () => {
    expect(failure_message(dns_result("dns_error", null, "boom"), query)).toBe("DNS query failed: boom");
  });
});

// A resolver class that records how it was built and asked, then answers with `outcome` or throws it.
function fake_resolver(captured: Record<string, unknown>, outcome: unknown) {
  return class implements ResolverLike {
    servers: string[] | null = null;
    constructor(options: { timeout: number; tries: number }) {
      captured.options = options;
    }
    setServers(servers: string[]): void {
      captured.servers = servers;
    }
    private answer(): Promise<never> | Promise<unknown> {
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    }
    resolve(hostname: string, rrtype: string): Promise<unknown> {
      captured.query = [hostname, rrtype];
      return this.answer();
    }
    resolve4(hostname: string): Promise<{ address: string; ttl: number }[]> {
      captured.query = [hostname, "A"];
      return this.answer() as Promise<{ address: string; ttl: number }[]>;
    }
    resolve6(hostname: string): Promise<{ address: string; ttl: number }[]> {
      captured.query = [hostname, "AAAA"];
      return this.answer() as Promise<{ address: string; ttl: number }[]>;
    }
  };
}

function coded(code: string): Error {
  return Object.assign(new Error(`query ${code} example.com`), { code });
}

describe("resolve now", () => {
  it("uses a named resolver alone", async () => {
    const captured: Record<string, unknown> = {};
    const result = await resolve_now(dns_query("example.com", { resolver: "8.8.8.8", port: 5353, timeout: 3 }), fake_resolver(captured, [{ address: "1.2.3.4", ttl: 60 }]));
    expect(result).toEqual(dns_result("ok", { record_type: "A", records: ["1.2.3.4"], ttl: 60 }));
    expect(captured).toEqual({ options: { timeout: 3000, tries: 1 }, servers: ["8.8.8.8:5353"], query: ["example.com", "A"] });
  });

  it("uses the system resolver when none is named", async () => {
    const captured: Record<string, unknown> = {};
    await resolve_now(dns_query("example.com"), fake_resolver(captured, [{ address: "1.2.3.4", ttl: 60 }]));
    expect(captured.servers).toBeUndefined();
  });

  it.each([
    ["ENOTFOUND", "nxdomain"],
    ["ENODATA", "no_answer"],
    ["ETIMEOUT", "timeout"],
    ["ESERVFAIL", "dns_error"],
  ] as const)("maps %s like the connector", async (code, kind) => {
    expect((await resolve_now(dns_query("example.com"), fake_resolver({}, coded(code)))).outcome).toBe(kind);
  });
});

describe("ddns reads the record like dns_record", () => {
  function plugin(rtype: string): DdnsUpdater {
    return new DdnsUpdater("ddns", { domain: "example.com", record_type: rtype });
  }

  it("matches a TXT value", async () => {
    const txt = answer("TXT", ["v=spf1 ", "-all"]);
    const ddns = plugin("TXT");
    ddns.resolve_dns = async () => dns_result("ok", txt);
    expect(await ddns.resolve_public_record()).toBe(answer_values("TXT", txt)[0]);
  });

  it("is null for a failed lookup", async () => {
    const ddns = plugin("A");
    ddns.resolve_dns = async () => dns_result("nxdomain");
    expect(await ddns.resolve_public_record()).toBeNull();
  });

  it("queries the configured resolver", async () => {
    const ddns = plugin("aaaa");
    const asked: unknown[] = [];
    ddns.resolve_dns = async (query) => {
      asked.push(query);
      return dns_result("nxdomain");
    };
    await ddns.resolve_public_record();
    expect(asked[0]).toEqual(dns_query("example.com", { record_type: "AAAA", resolver: "8.8.8.8", timeout: 10.0 }));
  });
});
