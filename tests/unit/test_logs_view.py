"""The logs view: rows merged from every host's search, grouping, and the search run inside a real NiceGUI client."""

import json
from types import SimpleNamespace

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.ui.views.logs import (
    entry_rows, grouped_rows, journal_monitors, render_logs, run_search, search_kwargs, summary_text,
)
from x_monitor.plugins.journal import Journal

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)


def _journal(monitor_id, host):
    return Journal(monitor_id, {'name': monitor_id, 'id': monitor_id, 'ssh_config': {'host': host}})


def _entry(message, epoch, priority=6, unit='nginx.service', cursor=None):
    return {'epoch': epoch, 'cursor': cursor or message, 'priority': priority, 'unit': unit,
            'identifier': '', 'pid': '1', 'message': message}


HEIMDALL = _journal('heimdall-journal', 'heimdall')
RAGNAROK = _journal('ragnarok-journal', 'ragnarok')


class _Engine:
    """Answers each monitor's search with canned entries, or fails it."""

    def __init__(self, answers, plugins=()):
        self.answers = answers
        self.plugins = list(plugins)
        self.calls = []

    async def dispatch_action(self, plugin, action_id, **kwargs):
        self.calls.append((plugin.id, action_id, kwargs))
        answer = self.answers[plugin.id]
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, str):
            return False, {'content': answer}
        return True, {'entries': json.dumps(answer)}


def test_rows_from_every_host_are_merged_newest_first():
    rows = entry_rows([(HEIMDALL, [_entry('a', 10), _entry('c', 30)]), (RAGNAROK, [_entry('b', 20, priority=3)])])

    assert [(row['host'], row['message']) for row in rows] == [('heimdall', 'c'), ('ragnarok', 'b'), ('heimdall', 'a')]
    assert rows[1]['priority_name'] == 'err'
    assert rows[1]['priority_badge'] == 'halon-badge-danger'


def test_an_entry_without_a_unit_shows_its_identifier():
    entry = {**_entry('a', 1, unit=''), 'identifier': 'kernel'}

    assert entry_rows([(HEIMDALL, [entry])])[0]['unit'] == 'kernel'


def test_grouping_puts_each_entry_under_one_row_per_value():
    rows = entry_rows([(HEIMDALL, [_entry('a', 30), _entry('b', 20, unit='sshd.service'), _entry('c', 10)])])

    grouped = grouped_rows(rows, 'unit')

    assert [(row['group'], row['parent']) for row in grouped] == [
        ('nginx.service (2)', None), ('', 'group:nginx.service'), ('', 'group:nginx.service'),
        ('sshd.service (1)', None), ('', 'group:sshd.service'),
    ]


def test_priority_groups_run_from_the_most_severe():
    rows = entry_rows([(HEIMDALL, [_entry('a', 30, priority=6), _entry('b', 20, priority=3)])])

    assert [row['group'] for row in grouped_rows(rows, 'priority') if row['parent'] is None] == ['err (1)', 'info (1)']


def test_no_grouping_leaves_the_rows_as_they_are():
    rows = entry_rows([(HEIMDALL, [_entry('a', 1)])])

    assert grouped_rows(rows, '') is rows


def test_only_journal_monitors_are_searched():
    group = SimpleNamespace(id='host', children=[HEIMDALL, SimpleNamespace(id='cpu', children=[])])

    assert journal_monitors([group, RAGNAROK, HEIMDALL]) == [HEIMDALL, RAGNAROK]


def test_the_summary_names_hosts_that_could_not_be_searched():
    assert summary_text(1, 1, []) == '1 entry from 1 host'
    assert summary_text(5, 2, [('odin', 'timed out')]) == '5 entries from 2 hosts. Not searched: odin (timed out)'


def test_search_arguments_default_to_every_priority():
    assert search_kwargs('1h', None, ' nginx ', '', '100') == {
        'since': '1h', 'priority': 7, 'unit': 'nginx', 'text': '', 'limit': 100}


async def test_a_search_runs_on_every_host_and_reports_the_ones_that_failed():
    engine = _Engine({HEIMDALL.id: [_entry('a', 1)], RAGNAROK.id: 'Permission denied'})

    found, failures = await run_search(engine, [HEIMDALL, RAGNAROK], search_kwargs('1h', 6, '', '', 500))

    assert found == [(HEIMDALL, [_entry('a', 1)])]
    assert failures == [('ragnarok', 'Permission denied')]
    assert [call[0] for call in engine.calls] == [HEIMDALL.id, RAGNAROK.id]


async def test_a_host_whose_search_raises_is_reported_not_raised():
    engine = _Engine({HEIMDALL.id: ConnectionError('refused')})

    found, failures = await run_search(engine, [HEIMDALL], search_kwargs('1h', 6, '', '', 500))

    assert found == []
    assert failures == [('heimdall', 'refused')]


async def test_the_logs_page_searches_every_host_and_lists_the_entries(user: User):
    engine = _Engine({HEIMDALL.id: [_entry('disk full', 20, priority=3)], RAGNAROK.id: [_entry('started', 10)]},
                     plugins=[HEIMDALL, RAGNAROK])

    @ui.page('/')
    def _page():
        render_logs(engine, switch_view=lambda *args: None)

    await user.open('/')
    user.find(kind=ui.button, content='Search').click()
    await user.should_see('2 entries from 2 hosts')

    table = user.find(ui.table).elements.pop()
    assert [row['message'] for row in table.rows] == ['disk full', 'started']
    assert {call[0] for call in engine.calls} == {HEIMDALL.id, RAGNAROK.id}


async def test_the_logs_page_says_when_there_is_nothing_to_search(user: User):
    @ui.page('/')
    def _page():
        render_logs(_Engine({}), switch_view=lambda *args: None)

    await user.open('/')
    await user.should_see('No journal monitors are configured')
