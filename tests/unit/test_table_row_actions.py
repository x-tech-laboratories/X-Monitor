"""A spec table's per-row action buttons, rendered inside a real NiceGUI client."""

import asyncio
from types import SimpleNamespace

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.ui.components import render_table_with_actions

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)


@pytest.fixture(autouse=True)
def notify_finds_its_client(monkeypatch):
    """The test harness records notifications without looking up a client, so this restores the lookup the real ui.notify starts with."""
    from nicegui import context
    from nicegui.testing.user_notify import UserNotify
    record = UserNotify.__call__

    def notify(self, *args, **kwargs):
        context.client
        return record(self, *args, **kwargs)

    monkeypatch.setattr(UserNotify, '__call__', notify)


_SPEC = {'row_key': 'name', 'rows_attr': 'rows',
         'columns': [{'name': 'name', 'label': 'Target', 'field': 'name'}],
         'row_actions': [{'id': 'build', 'icon': 'build', 'tooltip': 'Build', 'kind': 'dispatch',
                          'action_id': 'build', 'params': {'target': 'name'},
                          'confirm': 'Build {row[name]} now?'}]}


class _Plugin:
    """Holds the table rows and records the actions run."""

    def __init__(self):
        self.rows = [{'name': 'Alpha'}]
        self.ran = []

    async def run_action(self, action_id, **params):
        self.ran.append((action_id, params))
        return True, ''


async def _render(user: User, plugin):
    tables = []

    @ui.page('/')
    def _page():
        tables.append(render_table_with_actions(plugin, SimpleNamespace(on_refresh=lambda fn: None), _SPEC))

    await user.open('/')
    return tables[0]


def _click(table, action_id, name):
    listener = next(l for l in table._event_listeners.values() if l.type == action_id)
    row = next(r for r in table.props['rows'] if r['name'] == name)
    table._handle_event({'listener_id': listener.id, 'args': row})


class TestRowActions:
    async def test_a_confirmed_action_asks_first_then_runs_for_that_row(self, user: User):
        plugin = _Plugin()
        table = await _render(user, plugin)
        _click(table, 'build', 'Alpha')
        await user.should_see('Build Alpha now?')
        assert plugin.ran == []
        user.find('Confirm').click()
        await user.should_see('Build succeeded')
        assert plugin.ran == [('build', {'target': 'Alpha'})]

    async def test_cancelling_runs_nothing(self, user: User):
        plugin = _Plugin()
        table = await _render(user, plugin)
        _click(table, 'build', 'Alpha')
        await user.should_see('Build Alpha now?')
        user.find('Cancel').click()
        await asyncio.sleep(0.05)
        assert plugin.ran == []
