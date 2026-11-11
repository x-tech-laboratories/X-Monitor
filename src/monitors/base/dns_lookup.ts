// One DNS record lookup shared by dns_record (a declarative DnsQuery the Connector Engine resolves) and ddns_updater
// (a resolve inside its io_call): the record-type reading, the text each answer is compared as, the message a failed
// lookup reports, and the resolver and error mapping the DNS connector uses too.

import { getServers } from "node:dns";
import { Resolver } from "node:dns/promises";

import { dns_result, type DnsAnswer, type DnsQuery, type DnsRecordValue, type DnsResult } from "../../core/connectors/types.ts";
import { py_float } from "./python_text.ts";

// ── Config ───────────────────────────────────────────────────────────────────

// The record type named in config, upper-cased, defaulting to A.
export function record_type(value: unknown): string {
  return String(value || "A").toUpperCase();
}

// ── Answers ──────────────────────────────────────────────────────────────────

function without_dot(name: string): string {
  return name.replace(/\.+$/, "");
}

function field(record: Record<string, unknown>, key: string): string {
  return String(record[key] ?? "");
}

// One record as dnspython's text: MX as "preference host", TXT joined, names without the trailing dot.
function record_text(rtype: string, record: DnsRecordValue): string {
  if (Array.isArray(record)) return record.join("");
  if (typeof record === "string") return without_dot(record);
  if (rtype === "MX" || ("exchange" in record && "priority" in record)) return `${field(record, "priority")} ${without_dot(field(record, "exchange"))}`.trim();
  if ("address" in record) return without_dot(field(record, "address"));
  if (rtype === "SOA" || "nsname" in record) {
    return without_dot([field(record, "nsname") + ".", field(record, "hostmaster") + ".", field(record, "serial"), field(record, "refresh"), field(record, "retry"), field(record, "expire"), field(record, "minttl")].join(" "));
  }
  if (rtype === "SRV" || ("weight" in record && "port" in record)) {
    return `${field(record, "priority")} ${field(record, "weight")} ${field(record, "port")} ${without_dot(field(record, "name"))}`;
  }
  if (rtype === "CAA" || "critical" in record) {
    const tag = Object.keys(record).find((key) => key !== "critical") ?? "";
    return `${field(record, "critical")} ${tag} "${field(record, tag)}"`;
  }
  if (rtype === "NAPTR" || "regexp" in record) {
    return `${field(record, "order")} ${field(record, "preference")} "${field(record, "flags")}" "${field(record, "service")}" "${field(record, "regexp")}" ${without_dot(field(record, "replacement")) || "."}`;
  }
  return without_dot(JSON.stringify(record));
}

// Each record in an answer as plain text: MX as "preference host", TXT unquoted and joined, names without the dot.
export function answer_values(rtype: string, answer: DnsAnswer | null): string[] {
  if (answer === null) return [];
  return answer.records.map((record) => record_text(rtype, record));
}

// ── Failures ─────────────────────────────────────────────────────────────────

// What went wrong with a lookup, or null when it answered.
export function failure_message(result: DnsResult, query: DnsQuery): string | null {
  switch (result.outcome) {
    case "nxdomain":
      return `${query.domain} does not exist (NXDOMAIN)`;
    case "no_answer":
      return `${query.domain} has no ${query.record_type} record`;
    case "timeout":
      return `Query for ${query.domain} (${query.record_type}) timed out after ${py_float(query.timeout)}s`;
    case "dns_error":
      return `DNS query failed: ${result.error}`;
    default:
      return null;
  }
}

// The DnsResult a failed node:dns lookup maps to, keyed by its error code.
export function failure_result(error: unknown): DnsResult {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOTFOUND") return dns_result("nxdomain");
  if (code === "ENODATA") return dns_result("no_answer");
  if (code === "ETIMEOUT") return dns_result("timeout");
  return dns_result("dns_error", null, error instanceof Error ? error.message : String(error));
}

// ── Resolving ────────────────────────────────────────────────────────────────

// The part of node:dns/promises' Resolver a lookup uses, so a test can stand in for it.
export interface ResolverLike {
  setServers(servers: string[]): void;
  resolve(hostname: string, rrtype: string): Promise<unknown>;
  resolve4(hostname: string, options: { ttl: true }): Promise<{ address: string; ttl: number }[]>;
  resolve6(hostname: string, options: { ttl: true }): Promise<{ address: string; ttl: number }[]>;
}

export type ResolverClass = new (options: { timeout: number; tries: number }) => ResolverLike;

// A server address with its port, bracketing an IPv6 address.
function server_with_port(server: string, port: number): string {
  const host = server.startsWith("[") ? server.slice(1, server.indexOf("]")) : server.includes(".") && server.includes(":") ? server.split(":")[0] : server;
  if (port === 53) return host;
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

// A resolver aimed at the query's nameserver and port, or the system's nameservers when it names none; the whole
// query gets one try within its timeout, as dnspython's lifetime bounds it.
export function build_resolver(query: DnsQuery, resolver_cls: ResolverClass = Resolver as unknown as ResolverClass): ResolverLike {
  const resolver = new resolver_cls({ timeout: Math.max(1, Math.round(query.timeout * 1000)), tries: 1 });
  if (query.resolver) resolver.setServers([server_with_port(query.resolver, query.port)]);
  else if (query.port !== 53) resolver.setServers(getServers().map((server) => server_with_port(server, query.port)));
  return resolver;
}

// Resolves one query with a resolver built for it; A and AAAA carry their TTLs.
export async function resolve_with(resolver: ResolverLike, query: DnsQuery): Promise<DnsResult> {
  try {
    let answer: DnsAnswer;
    if (query.record_type === "A" || query.record_type === "AAAA") {
      const records = query.record_type === "A" ? await resolver.resolve4(query.domain, { ttl: true }) : await resolver.resolve6(query.domain, { ttl: true });
      const ttls = records.map((record) => record.ttl);
      answer = { record_type: query.record_type, records: records.map((record) => record.address), ttl: ttls.length > 0 ? Math.min(...ttls) : null };
    } else {
      const records = (await resolver.resolve(query.domain, query.record_type)) as DnsRecordValue[] | Record<string, unknown>;
      answer = { record_type: query.record_type, records: Array.isArray(records) ? records : [records], ttl: null };
    }
    if (answer.records.length === 0) return dns_result("no_answer");
    return dns_result("ok", answer);
  } catch (error) {
    return failure_result(error);
  }
}

// Resolves a query now, choosing the nameserver and naming errors exactly as the DNS connector does.
export function resolve_now(query: DnsQuery, resolver_cls: ResolverClass = Resolver as unknown as ResolverClass): Promise<DnsResult> {
  return resolve_with(build_resolver(query, resolver_cls), query);
}
