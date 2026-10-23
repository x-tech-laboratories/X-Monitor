"""Existence and correctness of one DNS record, resolved through a DnsQuery
request issued from the X-Monitor host. Config: domain, record_type, resolver,
port, timeout, expected (list of acceptable answer values). NXDOMAIN, no
answer, a query timeout or error, or any answer outside the expected list is
failed; a resolving record, matching expected when that is set, is online.
This monitor has no warning tier."""

import json
from typing import Any, Dict, List, Optional

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import (
    CollectResult, DnsQuery, DnsResult, Request, Result,
)
from x_monitor.plugins.base.dns_lookup import answer_values, failure_message, record_type

_DEFAULT_LAYOUT = [
    ['status_card', 'type_card', 'ttl_card'],
    ['uptime_strip'],
    ['answer'],
    ['events'],
]


class DnsRecord(Plugin):
    RUNS_ON_AGENT = False
    AVAILABILITY = True

    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.domain = config.get('domain')
        self.record_type = record_type(config.get('record_type'))
        self.resolver_addr = config.get('resolver')
        self.port = int(config.get('port', 53))
        self.dns_timeout = float(config.get('timeout', 5))
        expected = config.get('expected')
        self.expected: Optional[List[str]] = (
            [str(v).rstrip('.') for v in expected] if expected else None
        )
        self.target = self.domain or self.name

    def _query(self) -> DnsQuery:
        return DnsQuery(
            domain=self.domain,
            record_type=self.record_type,
            resolver=self.resolver_addr,
            port=self.port,
            timeout=self.dns_timeout,
        )

    def requests(self) -> List[Request]:
        if not self.domain:
            return []
        return [self._query()]

    def parse_results(self, results: List[Result]) -> CollectResult:
        """Turns the single DnsResult into a CollectResult with resolved/ttl/match
        metrics, the answer values stored as a setting, and a status that is
        failed for NXDOMAIN, no answer, timeout, query error, or any answer
        outside the expected list."""
        if not results:
            return CollectResult.failed("No 'domain' configured")

        result: DnsResult = results[0]
        failure = failure_message(result, self._query())
        if failure is not None:
            return CollectResult(
                metrics={'resolved': 0.0},
                logs=[(failure, "ERROR")],
                status='failed',
            )

        answers = result.answer
        values = answer_values(self.record_type, answers)
        ttl = answers.rrset.ttl if answers.rrset is not None else None

        metrics = {'resolved': 1.0}
        if ttl is not None:
            metrics['ttl'] = float(ttl)
        settings = {f"dns_record:{self.id}": json.dumps(values)}

        if self.expected is not None:
            unexpected = [v for v in values if v not in self.expected]
            if unexpected:
                metrics['matches_expected'] = 0.0
                return CollectResult(
                    metrics=metrics,
                    logs=[(
                        f"{self.domain} ({self.record_type}) resolved to {values}, "
                        f"expected one of {self.expected}",
                        "ERROR",
                    )],
                    status='failed',
                    settings=settings,
                )
            metrics['matches_expected'] = 1.0

        return CollectResult(
            metrics=metrics,
            logs=[(f"{self.domain} ({self.record_type}) -> {values} (TTL {ttl})", "INFO")],
            status='online',
            settings=settings,
        )

    def _item_color(self, item: Dict[str, Any]) -> str:
        value = item.get('value')
        return 'online' if self.expected is None or value in self.expected else 'failed'

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'status_card': {'metric': 'resolved', 'title': 'RESOLUTION',
                                'on_text': 'OK', 'off_text': 'FAILED'},
                'type_card': {'title': 'RECORD TYPE', 'value': self.record_type},
                'ttl_card': {'metric': 'ttl', 'title': 'TTL', 'format': 'ttl_seconds'},
                'uptime_strip': {'kind': 'strip', 'metric': 'resolved', 'title': 'RESOLUTION HISTORY'},
                'answer': {
                    'repeat': {
                        'source': 'setting',
                        'setting_key': 'dns_record:{plugin_id}',
                        'item_label': '_none',
                        'item_value': 'value',
                        'item_color_by': self._item_color,
                        'container': 'chips',
                        'empty_text': 'No answer yet',
                    },
                },
            },
            'events': True,
        }

