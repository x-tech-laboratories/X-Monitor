"""The schedules view: its rows across monitors, and the table rendered inside a real NiceGUI client."""

import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.coordination.schedule import parse_schedule
from x_monitor.core.ui.views.schedules import render_schedules, schedule_rows

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)

NOW = datetime(2026, 10, 22, 18, 30)


def _monitor(monitor_id, name, schedule, actions=()):
    return SimpleNamespace(id=monitor_id, name=name, children=[], scheduled_actions=parse_schedule(schedule),
                           all_actions=lambda: list(actions))


BORG = _monitor('borg', 'On Disk', [
    {'action': 'run_backup', 'cron': '0 */3 * * *'},
    {'action': 'check_repo', 'cron': '0 4 15 * *', 'args': {'kind': 'data'}},
], actions=[{'name': 'Run Backup', 'action_id': 'run_backup'}])
FRIGATE = _monitor('frigate', 'Frigate', [{'action': 'sync_recordings', 'cron': '@weekly'}])
PLAIN = SimpleNamespace(id="cpu", name="CPU", children=[], scheduled_actions=[], all_actions=lambda: [])


def test_one_row_per_scheduled_action_soonest_first():
    host = SimpleNamespace(id='heimdall', name='Heimdall', children=[BORG], scheduled_actions=[], all_actions=lambda: [])
    rows = schedule_rows([PLAIN, FRIGATE, host], lambda key: None, NOW)
    assert [(r['monitor'], r['action'], r['next']) for r in rows] == [
        ('Heimdall › On Disk', 'Run Backup', 'Thu 22 Oct 21:00'),
        ('Frigate', 'Sync recordings', 'Sun 25 Oct 00:00'),
        ('Heimdall › On Disk', 'Check repo (kind: data)', 'Sun 15 Nov 04:00'),
    ]


def test_a_monitor_linked_into_two_groups_is_listed_once():
    first = SimpleNamespace(id='g1', name='G1', children=[BORG], scheduled_actions=[], all_actions=lambda: [])
    second = SimpleNamespace(id='g2', name='G2', children=[BORG], scheduled_actions=[], all_actions=lambda: [])
    assert len(schedule_rows([first, second], lambda key: None, NOW)) == 2


def test_a_schedule_that_has_not_run_says_so():
    row = schedule_rows([BORG], lambda key: None, NOW)[0]
    assert row['last'] == 'not yet' and row['outcome'] == ''


def test_the_last_run_and_its_outcome_come_from_the_stored_record():
    entry = BORG.scheduled_actions[0]
    stored = {entry.result_key('borg'): json.dumps({'at': datetime(2026, 10, 22, 18, 0).timestamp(), 'ok': False,
                                                    'message': 'Scheduled run_backup (0 */3 * * *) failed'})}
    row = schedule_rows([BORG], stored.get, NOW)[0]
    assert (row['last'], row['outcome'], row['outcome_badge']) == ('Thu 22 Oct 18:00', 'Failed', 'halon-badge-danger')


def test_an_unreadable_record_reads_as_not_run():
    entry = BORG.scheduled_actions[0]
    row = schedule_rows([BORG], {entry.result_key('borg'): 'garbage'}.get, NOW)[0]
    assert row['last'] == 'not yet'


async def test_the_table_lists_every_schedule_and_a_row_opens_its_monitor(user: User, monkeypatch):
    callbacks = []
    # Off the change-bus scheduler, whose per-client registry would outlive this test's client.
    monkeypatch.setattr('x_monitor.core.ui.model.schedule_callback',
                        lambda callback, run_now=True: callbacks.append(callback))
    engine = SimpleNamespace(plugins=[BORG, FRIGATE], db=SimpleNamespace(get_setting=lambda key: None))
    opened = []

    @ui.page('/')
    def _page():
        render_schedules(engine, switch_view=lambda view, plugin=None: opened.append((view, plugin.id)))

    await user.open('/')
    table = user.find(ui.table).elements.pop()
    await callbacks[0]()
    assert len(table.rows) == 3
    for listener in table._event_listeners.values():
        if listener.type == 'rowClick':
            listener.handler(SimpleNamespace(args=[{}, table.rows[0], 0]))
    assert opened == [('plugin', 'borg')]
