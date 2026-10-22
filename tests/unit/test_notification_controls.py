"""The dashboard's notification controls, rendered in a real NiceGUI client."""

import asyncio
from types import SimpleNamespace

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.connectors.agent_connector import AgentRegistry
from x_monitor.core.notifications import NotificationEngine
from x_monitor.core.ui.views.notifications import open_notifications_dialog, render_mute_button

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)


def _plugin(plugin_id, children=(), type_='cpu'):
    return SimpleNamespace(id=plugin_id, name=plugin_id.title(), target='host.lan',
                           config={'type': type_}, children=list(children))


class Channel:
    TYPE = 'desktop'

    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def send(self, message):
        if self.fail:
            raise ConnectionError('agent is not connected')
        self.sent.append(message)


@pytest.fixture
def notifications(db_manager):
    engine = NotificationEngine(db_manager, {}, AgentRegistry())
    engine.channels = {'desk': Channel(), 'broken': Channel(fail=True)}
    nas = _plugin('nas')
    engine.nas = nas
    engine.group = _plugin('storage', [nas], type_='group')
    yield engine
    engine.stop()


@pytest.fixture
def pages(notifications):
    """A monitor page's mute button at /nas and /storage, and the dialog at /dialog."""
    dashboard = SimpleNamespace(notifications=notifications)

    @ui.page('/nas')
    def _nas():
        render_mute_button(dashboard, notifications.nas)

    @ui.page('/storage')
    def _storage():
        render_mute_button(dashboard, notifications.group)

    @ui.page('/dialog')
    def _dialog():
        open_notifications_dialog(dashboard)


async def _started(notifications):
    notifications.start([notifications.group])


def _button(user: User, label='Notifications'):
    return next(iter(user.find(kind=ui.button, content=label).elements))


def _pressed(button) -> bool:
    return 'halon-button-active' in button.classes and button.props.get('aria-pressed') == 'true'


async def _shows_pressed(user: User, pressed: bool) -> None:
    """Waits for the re-rendered button to show the state, which lands a moment after the click."""
    for _ in range(50):
        if _pressed(_button(user)) == pressed:
            return
        await asyncio.sleep(0.01)
    assert _pressed(_button(user)) == pressed


class TestNotificationsToggle:
    async def test_releasing_and_pressing_mutes_and_unmutes(self, user: User, notifications, pages):
        await _started(notifications)
        await user.open('/nas')
        await user.should_see('Notifications')
        assert _pressed(_button(user))
        user.find(kind=ui.button, content='Notifications').click()
        await user.should_see('Nas muted')
        assert notifications.muted_by('nas') == 'nas'
        await _shows_pressed(user, False)
        user.find(kind=ui.button, content='Notifications').click()
        await user.should_see('Nas unmuted')
        assert notifications.muted_by('nas') is None
        await _shows_pressed(user, True)

    async def test_a_muted_monitor_shows_it_released(self, user: User, notifications, pages):
        await _started(notifications)
        notifications.set_muted('nas', True)
        await user.open('/nas')
        await user.should_see('Notifications')
        assert not _pressed(_button(user))

    async def test_a_monitor_muted_by_its_group_says_so_and_cannot_be_pressed(self, user: User, notifications, pages):
        await _started(notifications)
        notifications.set_muted('storage', True)
        await user.open('/nas')
        await user.should_see('Muted by Storage')
        assert not _button(user, 'Muted by Storage').enabled

    async def test_no_channels_means_no_button(self, user: User, notifications, pages):
        notifications.channels = {}
        await user.open('/nas')
        await user.should_not_see('Notifications')


class TestMaintenance:
    def _window(self, notifications, **extra):
        from datetime import datetime, timedelta
        from x_monitor.core.notifications.maintenance import window
        now = datetime.now()
        notifications.windows = [window({'name': 'Upgrades', 'start': (now - timedelta(hours=1)).isoformat(),
                                         'end': (now + timedelta(hours=1)).isoformat(), **extra}),
                                 window({'name': 'Nightly', 'from': '03:00', 'to': '03:01',
                                         'days': ['mon'], 'monitors': ['nobody']})]

    async def test_a_monitor_page_says_it_is_in_maintenance(self, user: User, notifications, pages):
        await _started(notifications)
        self._window(notifications)
        await user.open('/nas')
        await user.should_see('In maintenance: Upgrades')
        await user.should_see('Notifications')

    async def test_the_dialog_lists_windows_and_which_are_active(self, user: User, notifications, pages):
        await _started(notifications)
        self._window(notifications)
        await user.open('/dialog')
        await user.should_see('Upgrades')
        await user.should_see('Mon 03:00-03:01')
        assert len(user.find('Active now').elements) == 1


class TestDialog:
    async def test_lists_channels_and_sends_a_test(self, user: User, notifications, pages):
        await _started(notifications)
        await user.open('/dialog')
        await user.should_see('desk')
        await user.should_see('broken')
        user.find(marker='test-desk').click()
        await user.should_see('Test sent to desk')
        assert len(notifications.channels['desk'].sent) == 1
        user.find(marker='test-broken').click()
        await user.should_see('Test to broken failed: agent is not connected')

    async def test_unmutes_from_the_list(self, user: User, notifications, pages):
        await _started(notifications)
        notifications.set_muted('storage', True)
        await user.open('/dialog')
        await user.should_see('Storage')
        user.find('Unmute').click()
        await user.should_see('No monitors are muted.')
        assert notifications.muted_by('nas') is None

    async def test_says_when_nothing_is_muted(self, user: User, notifications, pages):
        await _started(notifications)
        await user.open('/dialog')
        await user.should_see('No monitors are muted.')
