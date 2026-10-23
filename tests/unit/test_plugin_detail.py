"""The plugin detail view's Poll Now button, driven inside a real NiceGUI client.

A poll can outlast the page it was started from; these pin that its notice
reaches the viewer, and that nothing raises once the viewer's tab is gone.
"""

import asyncio
import gc
from types import SimpleNamespace

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.ui.views.plugin_detail import render_plugin_detail

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)


class _SlowPlugin:
    """A monitor whose poll waits until the test releases it."""

    name = 'Vault'
    id = 'vault'

    def __init__(self):
        self.release = asyncio.Event()
        self.polled = False

    async def run_cycle(self):
        await self.release.wait()
        self.polled = True
        return True

    async def present(self):
        return {'actions': []}

    def render_ui(self, context='page'):
        ui.label('plugin body')


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


@pytest.fixture
def plugin():
    return _SlowPlugin()


@pytest.fixture
def page(plugin):
    engine = SimpleNamespace(notifications=SimpleNamespace(channels=[]))

    @ui.page('/')
    def _page():
        render_plugin_detail(engine, lambda *_: None, plugin)


async def _poll_and_wait(user: User, plugin):
    await user.should_see('Poll Now')
    user.find('Poll Now').click()
    await asyncio.sleep(0.01)
    return plugin


class TestPollNow:
    async def test_notifies_when_the_poll_finishes(self, user: User, page, plugin):
        await user.open('/')
        await _poll_and_wait(user, plugin)
        plugin.release.set()
        await user.should_see('Vault polled')

    async def test_is_a_regular_button_until_clicked(self, user: User, page, plugin):
        await user.open('/')
        await user.should_see('Poll Now')
        button = _button(user, 'Poll Now')
        assert 'halon-button' in button.classes
        assert 'halon-button-filled' not in button.classes

    async def test_takes_the_accent_and_says_polling_while_the_poll_runs(self, user: User, page, plugin):
        await user.open('/')
        await _poll_and_wait(user, plugin)
        await user.should_see('Polling...')
        button = _button(user, 'Polling...')
        assert 'halon-button-filled' in button.classes
        plugin.release.set()
        await user.should_see('Vault polled')
        assert button.text == 'Poll Now'
        assert 'halon-button-filled' not in button.classes
        assert 'halon-button' in button.classes


def _orphaned_slot(client):
    """A slot whose element has been deleted and collected: where a handler stands once its page is gone."""
    with client:
        element = ui.row()
    slot = element.default_slot
    element.delete()
    del element
    gc.collect()
    return slot


class TestNotifyClient:
    async def test_a_plain_notify_from_a_dead_slot_raises(self, user: User, page):
        await user.open('/')
        with _orphaned_slot(user.client), pytest.raises(RuntimeError, match='has been deleted'):
            ui.notify('lost')

    async def test_reaches_the_viewer_from_a_dead_slot(self, user: User, page):
        from x_monitor.core.ui.components import notify_client
        await user.open('/')
        with _orphaned_slot(user.client):
            notify_client(user.client, 'still delivered')
        await user.should_see('still delivered')

    async def test_a_deleted_client_gets_nothing(self, user: User, page):
        from x_monitor.core.ui.components import notify_client
        await user.open('/')
        client = user.client
        client.delete()
        notify_client(client, 'nobody is listening')


class _TogglePlugin:
    """A monitor with one toggle whose state lives in its 'enabled' metric."""

    name = 'nginx'
    id = 'nginx'
    actions = [{'name': 'Start on Boot', 'kind': 'toggle', 'metric': 'enabled',
                'on_action_id': 'enable_service', 'off_action_id': 'disable_service'}]

    def __init__(self, enabled, succeeds=True):
        self.enabled = enabled
        self.succeeds = succeeds
        self.ran = []
        self.data = SimpleNamespace(latest_metric=self._latest_metric)

    def _latest_metric(self, name):
        return None if self.enabled is None else SimpleNamespace(value=self.enabled)

    async def run_action(self, action_id):
        self.ran.append(action_id)
        return self.succeeds, ''

    async def run_cycle(self):
        # The poll reads back what the action did to the target.
        self.enabled = 1.0 if self.ran[-1] == 'enable_service' else 0.0
        return True

    async def present(self):
        return {'actions': self.actions}

    def get_actions(self):
        return self.actions

    def render_ui(self, context='page'):
        ui.label('plugin body')


def _toggle_page(plugin):
    engine = SimpleNamespace(notifications=SimpleNamespace(channels=[]))

    @ui.page('/')
    def _page():
        render_plugin_detail(engine, lambda *_: None, plugin)


def _button(user: User, label='Start on Boot'):
    return next(iter(user.find(kind=ui.button, content=label).elements))


def _pressed(button) -> bool:
    return 'halon-button-active' in button.classes and button.props.get('aria-pressed') == 'true'


class TestToggle:
    async def test_is_pressed_while_the_state_is_on(self, user: User):
        _toggle_page(_TogglePlugin(enabled=1.0))
        await user.open('/')
        await user.should_see('Start on Boot')
        assert _pressed(_button(user))

    async def test_is_released_while_the_state_is_off(self, user: User):
        _toggle_page(_TogglePlugin(enabled=0.0))
        await user.open('/')
        await user.should_see('Start on Boot')
        assert not _pressed(_button(user))
        assert _button(user).props.get('aria-pressed') == 'false'

    async def test_clicking_a_released_button_runs_the_on_action_and_reads_the_state_back(self, user: User):
        plugin = _TogglePlugin(enabled=0.0)
        _toggle_page(plugin)
        await user.open('/')
        await user.should_see('Start on Boot')
        user.find(kind=ui.button, content='Start on Boot').click()
        await user.should_see('Start on Boot: on')
        assert plugin.ran == ['enable_service']
        assert _pressed(_button(user))

    async def test_clicking_a_pressed_button_runs_the_off_action(self, user: User):
        plugin = _TogglePlugin(enabled=1.0)
        _toggle_page(plugin)
        await user.open('/')
        await user.should_see('Start on Boot')
        user.find(kind=ui.button, content='Start on Boot').click()
        await user.should_see('Start on Boot: off')
        assert plugin.ran == ['disable_service']
        assert not _pressed(_button(user))

    async def test_a_failed_action_leaves_it_released(self, user: User):
        plugin = _TogglePlugin(enabled=0.0, succeeds=False)
        _toggle_page(plugin)
        await user.open('/')
        await user.should_see('Start on Boot')
        user.find(kind=ui.button, content='Start on Boot').click()
        await user.should_see('Start on Boot could not be turned on')
        assert not _pressed(_button(user))

    async def test_an_unknown_state_disables_it(self, user: User):
        _toggle_page(_TogglePlugin(enabled=None))
        await user.open('/')
        await user.should_see('Start on Boot')
        assert not _button(user).enabled


class TestActionNames:
    def test_a_toggle_names_both_of_its_actions(self):
        from x_monitor.core.ui.views.plugin_detail import action_names
        assert action_names(_TogglePlugin.actions + [{'name': 'Restart', 'action_id': 'restart'}]) == {
            'enable_service': 'Start on Boot: on',
            'disable_service': 'Start on Boot: off',
            'restart': 'Restart',
        }
