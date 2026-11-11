import { describe, expect, it } from "vitest";

import { DnsConnector, type ResolverLike } from "../../../src/core/connectors/dns_connector.ts";
import { HttpConnector } from "../../../src/core/connectors/http_connector.ts";
import { IcmpConnector } from "../../../src/core/connectors/icmp_connector.ts";
import { dns_query, http_request, ping_request } from "../../../src/core/connectors/types.ts";

// ── DNS ──────────────────────────────────────────────────────────────────────

class FakeResolver implements ResolverLike {
  servers: string[] = [];
  readonly options: { timeout: number; tries: number };
  failure: Error | null = null;
  asked: [string, string][] = [];

  constructor(options: { timeout: number; tries: number }) {
    this.options = options;
  }

  setServers(servers: string[]): void {
    this.servers = servers;
  }

  async resolve4(hostname: string) {
    this.asked.push([hostname, "A"]);
    if (this.failure) throw this.failure;
    return [{ address: "1.2.3.4", ttl: 300 }, { address: "1.2.3.5", ttl: 60 }];
  }

  async resolve6(hostname: string) {
    this.asked.push([hostname, "AAAA"]);
    return [];
  }

  async resolve(hostname: string, record_type: string) {
    this.asked.push([hostname, record_type]);
    if (this.failure) throw this.failure;
    return [{ exchange: "mx.example.com", priority: 10 }];
  }
}

function dns_with(failure: Error | null = null): [DnsConnector, FakeResolver[]] {
  const made: FakeResolver[] = [];
  const connector = new DnsConnector((options) => {
    const resolver = new FakeResolver(options);
    resolver.failure = failure;
    made.push(resolver);
    return resolver;
  });
  return [connector, made];
}

function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe("dns connector", () => {
  it("applies a custom resolver's address, port and timeout", async () => {
    const [connector, made] = dns_with();
    const result = await connector.resolve(dns_query("example.com", { resolver: "1.1.1.1", port: 5353, timeout: 2 }));
    expect(result.outcome).toBe("ok");
    expect(made[0].servers).toEqual(["1.1.1.1:5353"]);
    expect(made[0].options).toEqual({ timeout: 2000, tries: 1 });
    expect(made[0].asked).toEqual([["example.com", "A"]]);
  });

  it("brackets an IPv6 nameserver", async () => {
    const [connector, made] = dns_with();
    await connector.resolve(dns_query("example.com", { resolver: "::1" }));
    expect(made[0].servers).toEqual(["::1"]);
  });

  it("uses the system's nameservers when the query names none", async () => {
    const [connector, made] = dns_with();
    await connector.resolve(dns_query("example.com"));
    expect(made[0].servers).toEqual([]);
  });

  it("keeps one resolver per nameserver and port", async () => {
    const [connector, made] = dns_with();
    await connector.resolve(dns_query("a.example.com"));
    await connector.resolve(dns_query("b.example.com"));
    await connector.resolve(dns_query("c.example.com", { resolver: "9.9.9.9" }));
    expect(made).toHaveLength(2);
  });

  it("returns addresses with their smallest ttl", async () => {
    const [connector] = dns_with();
    const result = await connector.resolve(dns_query("example.com"));
    expect(result.answer).toEqual({ record_type: "A", records: ["1.2.3.4", "1.2.3.5"], ttl: 60 });
  });

  it("returns other records as node resolves them", async () => {
    const [connector] = dns_with();
    const result = await connector.resolve(dns_query("example.com", { record_type: "mx" }));
    expect(result.answer).toEqual({ record_type: "MX", records: [{ exchange: "mx.example.com", priority: 10 }], ttl: null });
  });

  it("reads an empty answer as no answer", async () => {
    const [connector] = dns_with();
    expect((await connector.resolve(dns_query("example.com", { record_type: "AAAA" }))).outcome).toBe("no_answer");
  });

  it.each([["ENOTFOUND", "nxdomain"], ["ENODATA", "no_answer"], ["ETIMEOUT", "timeout"]])("maps %s to %s", async (code, outcome) => {
    const [connector] = dns_with(coded(code));
    expect((await connector.resolve(dns_query("example.com"))).outcome).toBe(outcome);
  });

  it("carries the message of any other error", async () => {
    const [connector] = dns_with(coded("ESERVFAIL", "boom"));
    const result = await connector.resolve(dns_query("example.com"));
    expect(result.outcome).toBe("dns_error");
    expect(result.error).toContain("boom");
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

describe("http connector", () => {
  it("returns the status and text", async () => {
    const calls: [string, RequestInit][] = [];
    const connector = new HttpConnector(async (url, init) => {
      calls.push([url, init]);
      return new Response("hello", { status: 200 });
    });
    const result = await connector.fetch(http_request("https://x/", { timeout: 3 }));
    expect(result.status_code).toBe(200);
    expect(result.text).toBe("hello");
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("turns a request failure into an error", async () => {
    const connector = new HttpConnector(async () => {
      throw new TypeError("fetch failed", { cause: new Error("no route") });
    });
    const result = await connector.fetch(http_request("https://x/"));
    expect(result.status_code).toBeNull();
    expect(result.error).toContain("no route");
    expect(result.elapsed_ms).toBe(0);
    expect(result.headers).toEqual({});
  });

  it("names a timeout", async () => {
    const connector = new HttpConnector(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect((await connector.fetch(http_request("https://x/"))).error).toBe("timed out");
  });

  it("forwards basic auth, the method, the body and headers", async () => {
    let seen: RequestInit | null = null;
    const connector = new HttpConnector(async (_url, init) => {
      seen = init;
      return new Response("<multistatus/>", { status: 207 });
    });
    await connector.fetch(http_request("https://dav/", { method: "PROPFIND", headers: { Depth: "0" }, body: "<propfind/>", auth: ["user", "pw"], timeout: 4 }));
    const init = seen! as RequestInit;
    expect(init.method).toBe("PROPFIND");
    expect(init.body).toBe("<propfind/>");
    expect(init.headers).toEqual({ Depth: "0", authorization: `Basic ${Buffer.from("user:pw").toString("base64")}` });
  });

  it("measures the elapsed time on success", async () => {
    const connector = new HttpConnector(async () => new Response("ok"));
    expect((await connector.fetch(http_request("https://x/"))).elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns response headers in lower case", async () => {
    const connector = new HttpConnector(async () => new Response(null, { status: 200, headers: { "Docker-Content-Digest": "sha256:abc" } }));
    const result = await connector.fetch(http_request("https://x/", { method: "HEAD" }));
    expect(result.headers["docker-content-digest"]).toBe("sha256:abc");
  });
});

// ── ICMP ─────────────────────────────────────────────────────────────────────

describe("icmp connector", () => {
  it("returns a successful ping", async () => {
    let argv: readonly string[] = [];
    const connector = new IcmpConnector(async (given) => {
      argv = given;
      return { exit_code: 0, stdout: "time=5.2 ms", stderr: "" };
    });
    const result = await connector.ping(ping_request("host", { count: 3, timeout: 2.5 }));
    expect(result.exception).toBeNull();
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("time=5.2 ms");
    expect(argv).toEqual(["ping", "-c", "3", "-W", "2", "host"]);
  });

  it("captures a ping that could not start", async () => {
    const connector = new IcmpConnector(async () => ({ exit_code: 127, stdout: "", stderr: "ping is not installed on this host" }));
    const result = await connector.ping(ping_request("host"));
    expect(result.returncode).toBeNull();
    expect(result.exception).toContain("ping is not installed");
  });

  it("captures a thrown failure", async () => {
    const connector = new IcmpConnector(async () => {
      throw new Error("ping missing");
    });
    const result = await connector.ping(ping_request("host"));
    expect(result.returncode).toBeNull();
    expect(result.exception).toContain("ping missing");
  });
});
