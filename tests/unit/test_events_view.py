"""The events view, rendered inside a real NiceGUI client over a stub database."""

from types import SimpleNamespace

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.ui.views.events import render_events

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)

EVENTS = [
    {'timestamp': '2026-10-21 10:00:00', 'level': 'ERROR', 'target': 'odin', 'message': 'disk full'},
    {'timestamp': '2026-10-21 10:01:00', 'level': 'INFO', 'target': 'thor', 'message': 'backup done'},
]


async def test_the_events_table_has_its_own_filter_box_across_every_column(user: User, monkeypatch):
    callbacks = []
    # Off the change-bus scheduler, whose per-client registry would outlive this test's client.
    monkeypatch.setattr('x_monitor.core.ui.model.schedule_callback',
                        lambda callback, run_now=True: callbacks.append(callback))
    engine = SimpleNamespace(db=SimpleNamespace(recent_events=lambda **kwargs: list(EVENTS)))
    tables = []

    @ui.page('/')
    def _page():
        render_events(engine, switch_view=lambda *args: None)

    await user.open('/')
    tables.extend(user.find(ui.table).elements)
    await callbacks[0]()
    assert len(tables[0].rows) == 2

    filter_box = next(e for e in user.find(ui.input).elements if e.props.get('placeholder') == 'Filter')
    filter_box.set_value('thor')
    assert [r['target'] for r in tables[0].rows] == ['thor']
