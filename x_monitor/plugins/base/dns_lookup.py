"""One DNS record lookup shared by dns_record (a declarative DnsQuery the
Connector Engine resolves) and ddns_updater (a blocking resolve inside its
io_call): the record-type reading, the query each builds, the text each
answer is compared as, and the message a failed lookup reports."""

from typing import Any, List, Optional

import dns.exception
import dns.resolver

from x_monitor.core.connectors.dns_connector import build_resolver, failure_result
from x_monitor.core.connectors.types import DnsQuery, DnsResult


def record_type(value: Any) -> str:
    """The record type named in config, upper-cased, defaulting to A."""
    return str(value or 'A').upper()


def answer_values(rtype: str, answer: Any) -> List[str]:
    """Each record in a dnspython answer as plain text: MX as 'preference host', TXT joined, names without the trailing dot."""
    return [_rdata_to_str(rtype, rdata) for rdata in answer]


def _rdata_to_str(rtype: str, rdata: Any) -> str:
    if rtype == 'MX':
        return f"{rdata.preference} {str(rdata.exchange).rstrip('.')}".strip()
    if rtype == 'TXT':
        return ''.join(part.decode('utf-8', 'replace') if isinstance(part, bytes) else part
                       for part in rdata.strings)
    return str(rdata).rstrip('.')


def failure_message(result: DnsResult, query: DnsQuery) -> Optional[str]:
    """What went wrong with a lookup, or None when it answered."""
    return {
        'nxdomain': f"{query.domain} does not exist (NXDOMAIN)",
        'no_answer': f"{query.domain} has no {query.record_type} record",
        'timeout': f"Query for {query.domain} ({query.record_type}) timed out after {query.timeout}s",
        'dns_error': f"DNS query failed: {result.error}",
    }.get(result.kind)


def resolve_now(query: DnsQuery) -> DnsResult:
    """Resolve a query on the calling thread, choosing the nameserver and naming errors exactly as the DnsConnector does."""
    resolver = build_resolver(query, dns.resolver.Resolver)
    try:
        answer = resolver.resolve(query.domain, query.record_type, lifetime=query.timeout)
        return DnsResult(kind='ok', answer=answer)
    except dns.exception.DNSException as e:
        return failure_result(e)
