// The DNS connector: resolves a monitor's DnsQuery with node's resolver and hands back a DnsResult, so no monitor
// touches the network itself. build_resolver and failure_result are also what a monitor's blocking lookup uses, so
// both aim at the same nameserver and name their errors the same way.

import { Resolver } from "node:dns/promises";

import { dns_result, type DnsAnswer, type DnsQuery, type DnsRecordValue, type DnsResult } from "./types.ts";

// ── Resolver ─────────────────────────────────────────────────────────────────

// What the connector needs of a resolver, so a test fakes it.
export interface ResolverLike {
  setServers(servers: string[]): void;
  resolve4(hostname: string, options: { ttl: true }): Promise<{ address: string; ttl: number }[]>;
  resolve6(hostname: string, options: { ttl: true }): Promise<{ address: string; ttl: number }[]>;
  resolve(hostname: string, record_type: string): Promise<unknown>;
}

export type ResolverFactory = (options: { timeout: number; tries: number }) => ResolverLike;

const node_resolver: ResolverFactory = (options) => new Resolver(options) as unknown as ResolverLike;

// A nameserver and port as setServers takes them, bracketing an IPv6 address.
function server_address(nameserver: string, port: number): string {
  const host = nameserver.includes(":") && !nameserver.startsWith("[") ? `[${nameserver}]` : nameserver;
  return `${host}:${port}`;
}

// A resolver aimed at the query's nameserver and port, or the system's nameservers when it names none.
export function build_resolver(query: DnsQuery, factory: ResolverFactory = node_resolver): ResolverLike {
  const resolver = factory({ timeout: Math.max(1, Math.round(query.timeout * 1000)), tries: 1 });
  if (query.resolver) resolver.setServers([server_address(query.resolver, query.port)]);
  return resolver;
}

// ── Results ──────────────────────────────────────────────────────────────────

// The DnsResult a failed lookup maps to, by what went wrong.
export function failure_result(error: unknown): DnsResult {
  const code = (error as { code?: string }).code;
  if (code === "ENOTFOUND") return dns_result("nxdomain");
  if (code === "ENODATA") return dns_result("no_answer");
  if (code === "ETIMEOUT") return dns_result("timeout");
  return dns_result("dns_error", null, (error as Error).message || String(error));
}

// Looks one query up through a resolver, keeping TTLs for addresses, which are the records node reports them for.
export async function resolve_with(resolver: ResolverLike, query: DnsQuery): Promise<DnsResult> {
  const record_type = query.record_type.toUpperCase();
  try {
    let answer: DnsAnswer;
    if (record_type === "A" || record_type === "AAAA") {
      const found = record_type === "A" ? await resolver.resolve4(query.domain, { ttl: true }) : await resolver.resolve6(query.domain, { ttl: true });
      const ttl = found.length > 0 ? Math.min(...found.map((record) => record.ttl)) : null;
      answer = { record_type, records: found.map((record) => record.address), ttl };
    } else {
      const found = await resolver.resolve(query.domain, record_type);
      const records = (Array.isArray(found) ? found : [found]) as DnsRecordValue[];
      answer = { record_type, records, ttl: null };
    }
    if (answer.records.length === 0) return dns_result("no_answer");
    return dns_result("ok", answer);
  } catch (error) {
    return failure_result(error);
  }
}

// ── Connector ────────────────────────────────────────────────────────────────

export class DnsConnector {
  // One resolver per nameserver, port and timeout, so the system's resolver config is not read again on every poll.
  private readonly resolvers = new Map<string, ResolverLike>();
  private readonly factory: ResolverFactory;

  constructor(factory: ResolverFactory = node_resolver) {
    this.factory = factory;
  }

  private resolver_for(query: DnsQuery): ResolverLike {
    const key = `${query.resolver ?? ""}\u001f${query.port}\u001f${query.timeout}`;
    let resolver = this.resolvers.get(key);
    if (resolver === undefined) {
      resolver = build_resolver(query, this.factory);
      this.resolvers.set(key, resolver);
    }
    return resolver;
  }

  resolve(query: DnsQuery): Promise<DnsResult> {
    let resolver: ResolverLike;
    try {
      resolver = this.resolver_for(query);
    } catch (error) {
      return Promise.resolve(failure_result(error));
    }
    return resolve_with(resolver, query);
  }
}
