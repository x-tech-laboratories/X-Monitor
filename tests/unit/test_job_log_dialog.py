"""The job log dialog follows a running job by change event and polls it faster while open."""

from types import SimpleNamespace

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.coordination import jobs
from x_monitor.core.ui.components import show_job_log

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)


def _plugin(job, lines):
    async def log(job_id):
        return list(lines)

    return SimpleNamespace(
        id='p', name='P',
        data=SimpleNamespace(job=lambda job_id: job),
        jobs=SimpleNamespace(log=log, watch=lambda row: jobs.watch(row['id'], 'p')),
    )


async def test_a_running_job_is_watched_and_new_lines_show_on_the_next_change(user: User, monkeypatch):
    callbacks = []
    # Off the change-bus scheduler, whose per-client registry would outlive this test's client.
    monkeypatch.setattr('x_monitor.core.ui.model.schedule_callback',
                        lambda callback, run_now=True: callbacks.append(callback))
    job = {'id': 7, 'kind': 'gc', 'command': 'nix-collect-garbage', 'state': 'running',
           'started': '2026-10-23 10:00:00', 'duration': 5, 'exit_code': None, 'error': None}
    lines = [{'seq': 0, 'message': 'deleting /nix/store/a'}]
    plugin = _plugin(job, lines)

    @ui.page('/')
    async def _page():
        await show_job_log(plugin, 7)

    await user.open('/')
    assert jobs.is_watched(7)
    await callbacks[0]()
    output = user.find(ui.log).elements.pop()
    lines.append({'seq': 1, 'message': 'deleting /nix/store/b'})
    await callbacks[0]()
    assert [child.text for child in output.default_slot.children] == [
        'deleting /nix/store/a', 'deleting /nix/store/b']

    job['state'] = 'succeeded'
    await callbacks[0]()
    assert not jobs.is_watched(7)


async def test_closing_the_dialog_ends_the_watch(user: User, monkeypatch):
    monkeypatch.setattr('x_monitor.core.ui.model.schedule_callback', lambda callback, run_now=True: None)
    job = {'id': 8, 'kind': 'gc', 'command': 'true', 'state': 'running',
           'started': '2026-10-23 10:00:00', 'duration': 5, 'exit_code': None, 'error': None}
    plugin = _plugin(job, [])

    @ui.page('/')
    async def _page():
        await show_job_log(plugin, 8)

    await user.open('/')
    assert jobs.is_watched(8)
    user.find(ui.dialog).elements.pop().close()
    assert not jobs.is_watched(8)
