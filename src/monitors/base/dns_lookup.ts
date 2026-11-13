// One DNS record lookup shared by dns_record (a declarative DnsQuery the Connector Engine resolves) and ddns_updater
// (a resolve inside its io_call): the record-type reading, the text each answer is compared as, the message a failed
// lookup reports, and the resolver and error mapping the DNS connector uses too.

import { python_float_repr } from "@x-tech-laboratories/x-libs/python_text";

import { build_resolver, resolve_with, type ResolverLike } from "../../core/connectors/dns_connector.ts";
import { type DnsAnswer, type DnsQuery, type DnsRecordValue, type DnsResult } from "../../core/connectors/types.ts";

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
      return `Query for ${query.domain} (${query.record_type}) timed out after ${python_float_repr(query.timeout)}s`;
    case "dns_error":
      return `DNS query failed: ${result.error}`;
    default:
      return null;
  }
}

// ── Resolving ────────────────────────────────────────────────────────────────

export { build_resolver, failure_result, resolve_with, type ResolverFactory, type ResolverLike } from "../../core/connectors/dns_connector.ts";

export type ResolverClass = new (options: { timeout: number; tries: number }) => ResolverLike;

// Resolves a query now, choosing the nameserver and naming errors exactly as the DNS connector does.
export function resolve_now(query: DnsQuery, resolver_cls: ResolverClass | null = null): Promise<DnsResult> {
  const resolver = resolver_cls === null ? build_resolver(query) : build_resolver(query, (options) => new resolver_cls(options));
  return resolve_with(resolver, query);
}
