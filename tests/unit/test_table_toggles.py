"""A spec table column shown as toggle buttons, rendered inside a real NiceGUI client."""

import asyncio
from types import SimpleNamespace

import pytest
from nicegui import json, ui
from nicegui.testing import User

from x_monitor.core.ui.components import render_table_with_actions, toggle_position

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


_TOGGLE = {'on': ['enabled'], 'off': ['disabled'],
           'on_action_id': 'enable_service', 'off_action_id': 'disable_service',
           'params': {'service_name': 'unit'}}

_SPEC = {'row_key': 'unit', 'rows_attr': 'rows',
         'columns': [{'name': 'unit', 'label': 'Unit', 'field': 'unit'},
                     {'name': 'enabled', 'label': 'Enabled', 'field': 'enabled', 'toggle': _TOGGLE}]}


class _Plugin:
    """Holds the table rows; an action changes the target and the poll copies it into the rows."""

    def __init__(self, succeeds=True):
        self.rows = [{'unit': 'nginx.service', 'enabled': 'disabled'},
                     {'unit': 'tmp.mount', 'enabled': 'static'}]
        self.target = {row['unit']: row['enabled'] for row in self.rows}
        self.succeeds = succeeds
        self.ran = []

    async def run_action(self, action_id, **params):
        self.ran.append((action_id, params))
        if self.succeeds:
            self.target[params['service_name']] = 'enabled' if action_id == 'enable_service' else 'disabled'
        return self.succeeds, ''

    async def run_cycle(self):
        for row in self.rows:
            row['enabled'] = self.target[row['unit']]
        return True


async def _render(user: User, plugin):
    tables = []

    @ui.page('/')
    def _page():
        tables.append(render_table_with_actions(plugin, SimpleNamespace(on_refresh=lambda fn: None), _SPEC))

    await user.open('/')
    return tables[0]


def _flip(table, unit, value):
    listener = next(l for l in table._event_listeners.values() if l.type == 'toggle_enabled')
    row = next(r for r in table.props['rows'] if r['unit'] == unit)
    table._handle_event({'listener_id': listener.id, 'args': {'row': row, 'value': value}})


def _row(table, unit):
    return next(r for r in table.props['rows'] if r['unit'] == unit)


class TestTogglePosition:
    def test_on_off_and_neither(self):
        assert toggle_position(_TOGGLE, 'enabled') is True
        assert toggle_position(_TOGGLE, 'disabled') is False
        assert toggle_position(_TOGGLE, 'static') is None


class TestToggleColumn:
    async def test_rows_carry_the_switch_position(self, user: User):
        table = await _render(user, _Plugin())
        json.dumps(table.props)
        assert 'toggle' not in table.props['columns'][1]
        assert 'q-btn' in table.slots['body-cell-enabled'].template
        assert 'aria-pressed' in table.slots['body-cell-enabled'].template
        # Doubled braces in a bound attribute stop Vue compiling the page, which then renders blank.
        assert "{{ 'halon-button-active'" not in table.slots['body-cell-enabled'].template
        assert _row(table, 'nginx.service')['_toggle_enabled'] is False
        assert _row(table, 'tmp.mount')['_toggle_enabled'] is None

    async def test_flipping_runs_the_action_for_that_row_and_reads_it_back(self, user: User):
        plugin = _Plugin()
        table = await _render(user, plugin)
        _flip(table, 'nginx.service', True)
        await user.should_see('Enabled on: nginx.service succeeded')
        assert plugin.ran == [('enable_service', {'service_name': 'nginx.service'})]
        assert _row(table, 'nginx.service')['_toggle_enabled'] is True
        assert _row(table, 'nginx.service')['_toggle_busy_enabled'] is False

    async def test_a_failed_action_leaves_the_switch_where_it_was(self, user: User):
        plugin = _Plugin(succeeds=False)
        table = await _render(user, plugin)
        _flip(table, 'nginx.service', True)
        await user.should_see('Enabled on: nginx.service failed')
        assert _row(table, 'nginx.service')['_toggle_enabled'] is False

    async def test_a_second_flip_while_busy_is_ignored(self, user: User):
        plugin = _Plugin()
        release = asyncio.Event()
        run_action = plugin.run_action

        async def slow(action_id, **params):
            await release.wait()
            return await run_action(action_id, **params)

        plugin.run_action = slow
        table = await _render(user, plugin)
        _flip(table, 'nginx.service', True)
        await asyncio.sleep(0.01)
        assert _row(table, 'nginx.service')['_toggle_busy_enabled'] is True
        _flip(table, 'nginx.service', True)
        release.set()
        await user.should_see('Enabled on: nginx.service succeeded')
        assert len(plugin.ran) == 1
