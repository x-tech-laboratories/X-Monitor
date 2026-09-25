"""DnsConnector — the DNS sub-engine of the Connector Engine.

Resolves declarative ``DnsQuery`` objects via dnspython's async resolver, on
the event loop. Plugins never touch ``dns.resolver`` — they declare a
``DnsQuery`` and receive a ``DnsResult`` whose ``answer`` (on success) is the
raw dnspython Answer, so a plugin's pure ``parse_results`` keeps full rdata
access (MX preference, TXT strings, rrset TTL). ``build_resolver`` and
``failure_result`` are also what ``plugins/base/dns_lookup.resolve_now`` uses,
so a blocking lookup picks its nameserver and names its errors the same way.
"""

from typing import Any, Dict, Optional, Tuple

import dns.asyncresolver
import dns.exception
import dns.resolver

from vigil.core.connectors.types import DnsQuery, DnsResult


def build_resolver(query: DnsQuery, resolver_cls: Any) -> Any:
    """A dnspython resolver aimed at the query's nameserver and port, or the system's nameservers when it names none."""
    resolver = resolver_cls(configure=query.resolver is None)
    if query.resolver:
        resolver.nameservers = [query.resolver]
    resolver.port = query.port
    return resolver


def failure_result(exc: dns.exception.DNSException) -> DnsResult:
    """The DnsResult a failed lookup maps to, keyed by what went wrong."""
    if isinstance(exc, dns.resolver.NXDOMAIN):
        return DnsResult(kind='nxdomain')
    if isinstance(exc, dns.resolver.NoAnswer):
        return DnsResult(kind='no_answer')
    if isinstance(exc, dns.exception.Timeout):
        return DnsResult(kind='timeout')
    return DnsResult(kind='dns_error', error=str(exc))


class DnsConnector:
    def __init__(self):
        # One resolver per (nameserver, port), so /etc/resolv.conf is not
        # re-read on every poll of every DNS monitor.
        self._resolvers: Dict[Tuple[Optional[str], int], dns.asyncresolver.Resolver] = {}

    def _resolver_for(self, query: DnsQuery) -> dns.asyncresolver.Resolver:
        key = (query.resolver, query.port)
        resolver = self._resolvers.get(key)
        if resolver is None:
            resolver = build_resolver(query, dns.asyncresolver.Resolver)
            self._resolvers[key] = resolver
        return resolver

    async def resolve(self, query: DnsQuery) -> DnsResult:
        resolver = self._resolver_for(query)
        try:
            answer = await resolver.resolve(query.domain, query.record_type,
                                            lifetime=query.timeout)
            return DnsResult(kind='ok', answer=answer)
        except dns.exception.DNSException as e:
            return failure_result(e)
