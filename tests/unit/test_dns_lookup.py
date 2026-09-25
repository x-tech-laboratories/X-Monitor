from unittest.mock import patch

import dns.exception
import dns.resolver
import dns.rrset
import pytest

from vigil.core.connectors.types import DnsQuery, DnsResult
from vigil.plugins.base.dns_lookup import (
    answer_values, failure_message, record_type, resolve_now,
)
from vigil.plugins.ddns_updater import DdnsUpdater


def _rrset(rtype, *values):
    return dns.rrset.from_text('example.com.', 300, 'IN', rtype, *values)


class TestRecordType:
    def test_upper_cased(self):
        assert record_type('aaaa') == 'AAAA'

    def test_defaults_to_a(self):
        assert record_type(None) == 'A'


class TestAnswerValues:
    def test_a(self):
        assert answer_values('A', _rrset('A', '1.2.3.4')) == ['1.2.3.4']

    def test_cname_drops_trailing_dot(self):
        assert answer_values('CNAME', _rrset('CNAME', 'target.example.net.')) == ['target.example.net']

    def test_mx_has_preference_and_host(self):
        assert answer_values('MX', _rrset('MX', '10 mail.example.com.')) == ['10 mail.example.com']

    def test_txt_is_unquoted_and_joined(self):
        assert answer_values('TXT', _rrset('TXT', '"v=spf1 " "-all"')) == ['v=spf1 -all']


class TestFailureMessage:
    _QUERY = DnsQuery('example.com', 'MX', timeout=2.0)

    def test_ok_has_no_message(self):
        assert failure_message(DnsResult(kind='ok'), self._QUERY) is None

    @pytest.mark.parametrize('kind,text', [
        ('nxdomain', 'example.com does not exist (NXDOMAIN)'),
        ('no_answer', 'example.com has no MX record'),
        ('timeout', 'Query for example.com (MX) timed out after 2.0s'),
    ])
    def test_kinds(self, kind, text):
        assert failure_message(DnsResult(kind=kind), self._QUERY) == text

    def test_error_carries_its_message(self):
        assert failure_message(DnsResult(kind='dns_error', error='boom'), self._QUERY) == 'DNS query failed: boom'


def _fake_resolver(captured, outcome):
    class FakeResolver:
        def __init__(self, configure=True):
            captured['configure'] = configure
            self.nameservers = []
            self.port = 53

        def resolve(self, domain, rtype, lifetime=None):
            captured.update(nameservers=self.nameservers, port=self.port, lifetime=lifetime)
            if isinstance(outcome, type) and issubclass(outcome, Exception):
                raise outcome()
            return outcome
    return FakeResolver


class TestResolveNow:
    def test_named_resolver_is_used_alone(self):
        captured = {}
        with patch('dns.resolver.Resolver', _fake_resolver(captured, 'answer')):
            result = resolve_now(DnsQuery('example.com', 'A', resolver='8.8.8.8', port=5353, timeout=3))
        assert result == DnsResult(kind='ok', answer='answer')
        assert captured == {'configure': False, 'nameservers': ['8.8.8.8'], 'port': 5353, 'lifetime': 3}

    def test_no_resolver_uses_the_system_one(self):
        captured = {}
        with patch('dns.resolver.Resolver', _fake_resolver(captured, 'answer')):
            resolve_now(DnsQuery('example.com'))
        assert captured['configure'] is True

    @pytest.mark.parametrize('exc,kind', [
        (dns.resolver.NXDOMAIN, 'nxdomain'),
        (dns.resolver.NoAnswer, 'no_answer'),
        (dns.exception.Timeout, 'timeout'),
        (dns.exception.DNSException, 'dns_error'),
    ])
    def test_errors_map_like_the_connector(self, exc, kind):
        with patch('dns.resolver.Resolver', _fake_resolver({}, exc)):
            assert resolve_now(DnsQuery('example.com')).kind == kind


class TestDdnsReadsTheRecordLikeDnsRecord:
    def _plugin(self, rtype):
        return DdnsUpdater('ddns', {'domain': 'example.com', 'record_type': rtype})

    def test_txt_value_matches(self):
        answer = _rrset('TXT', '"v=spf1 " "-all"')
        with patch('vigil.plugins.ddns_updater.resolve_now', return_value=DnsResult(kind='ok', answer=answer)):
            assert self._plugin('TXT')._resolve_public_record() == answer_values('TXT', answer)[0]

    def test_failed_lookup_is_none(self):
        with patch('vigil.plugins.ddns_updater.resolve_now', return_value=DnsResult(kind='nxdomain')):
            assert self._plugin('A')._resolve_public_record() is None

    def test_query_uses_the_configured_resolver(self):
        with patch('vigil.plugins.ddns_updater.resolve_now', return_value=DnsResult(kind='nxdomain')) as resolve:
            self._plugin('aaaa')._resolve_public_record()
        assert resolve.call_args.args[0] == DnsQuery('example.com', 'AAAA', resolver='8.8.8.8', timeout=10.0)
