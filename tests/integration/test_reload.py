"""Config hot-reload: monitors diffed by id and applied in place, or the running config kept whole."""

import asyncio
import logging
import os
import signal
import sys
import textwrap
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from vigil.core.connectors.engine import ConnectorEngine
from vigil.core.connectors.ssh_connector import resolve_host
from vigil.core.coordination import engine as engine_module
from vigil.core.coordination.engine import VigilEngine
from vigil.core.coordination.reload import ReloadResult, restart_required
from vigil.core.database.database import db
from vigil.core.settings.config_file import ConfigError, ConfigFileManager
from vigil.core.state import changes
from vigil.core.state.changes import CHANGES
from vigil.core.ui.api import register_api
from vigil.core.ui.main_dashboard import DashboardState, after_reload

PROBE = textwrap.dedent('''
    from vigil.plugins.base.plugin_base import Plugin
    from vigil.core.connectors.types import CollectResult
    from vigil_agent.protocol import StreamSpec


    class Probe(Plugin):
        def parse(self, results):
            return CollectResult(status='online')

        def subscriptions(self):
            if not self.config.get('stream'):
                return []
            return [StreamSpec(id=f'{self.id}:watch', kind='journal', params={'unit': self.config['stream']})]
''')


def _probe(monitor_id, **extra):
    return {'name': monitor_id, 'id': monitor_id, 'type': 'probe', 'interval': 60, **extra}


def _ssh(monitor_id, host, **extra):
    return _probe(monitor_id, ssh_config={'host': host}, **extra)


@pytest.fixture(autouse=True)
def cleanup():
    root = logging.getLogger().level
    yield
    logging.getLogger().setLevel(root)
    for name in [m for m in sys.modules if m.startswith('vigil_external')]:
        del sys.modules[name]
    if not db.is_closed():
        db.close()


@pytest.fixture(autouse=True)
def no_cycles(monkeypatch):
    """Hold every monitor loop in its startup stagger, so no cycle writes while a test looks."""
    monkeypatch.setattr(engine_module, 'STARTUP_JITTER_SECONDS', 1000.0)
    monkeypatch.setattr(engine_module.random, 'uniform', lambda a, b: b)


@pytest.fixture(autouse=True)
def fake_ssh():
    """Every SSH connection is a distinct mock that remembers whether it was closed."""
    def build(cfg):
        return MagicMock(host=resolve_host(cfg))
    with patch('vigil.core.connectors.engine.SSHConnection') as ssh:
        ssh.from_config.side_effect = build
        yield ssh


class Setup:
    def __init__(self, tmp_path):
        self.tmp_path = tmp_path
        self.path = tmp_path / 'config.yaml'
        (tmp_path / 'plugins').mkdir()
        (tmp_path / 'plugins' / 'probe.py').write_text(PROBE)
        self.engine = None

    def write(self, plugins, **sections):
        config = {'database': {'path': str(self.tmp_path / 't.db')}, 'plugin_paths': ['plugins'],
                  'plugins': plugins, **sections}
        self.path.write_text(yaml.dump(config))

    async def start(self, plugins, **sections):
        self.write(plugins, **sections)
        self.engine = VigilEngine(str(self.path))
        self.engine.setup_modules()
        self.engine._start_exporters = MagicMock()
        await self.engine.run()
        return self.engine

    async def reload(self, plugins, **sections):
        self.write(plugins, **sections)
        return await self.engine.reload_config('test')

    def monitor(self, monitor_id):
        return next(p for p in self.engine._flatten(self.engine.plugins) if p.id == monitor_id)


@pytest.fixture
async def vigil(tmp_path):
    setup = Setup(tmp_path)
    yield setup
    if setup.engine is not None:
        setup.engine.shutdown()


class TestMonitorDiff:
    async def test_an_unchanged_monitor_keeps_running_untouched(self, vigil):
        engine = await vigil.start([_probe('a'), _probe('b')])
        a, task = vigil.monitor('a'), engine._monitor_tasks['a']
        result = await vigil.reload([_probe('a'), _probe('b', interval=30)])
        assert result.ok and result.changed == ['b'] and result.added == [] and result.removed == []
        assert vigil.monitor('a') is a
        assert engine._monitor_tasks['a'] is task and not task.cancelled()

    async def test_a_removed_monitor_stops(self, vigil):
        engine = await vigil.start([_probe('a'), _probe('b')])
        task = engine._monitor_tasks['b']
        result = await vigil.reload([_probe('a')])
        assert result.removed == ['b']
        assert [p.id for p in engine.plugins] == ['a']
        assert task.cancelled()
        assert 'b' not in engine._monitor_tasks and 'b' not in engine._exec_contexts

    async def test_an_added_monitor_is_wired_and_started(self, vigil):
        engine = await vigil.start([_probe('a')])
        result = await vigil.reload([_probe('a'), _probe('new')])
        assert result.added == ['new']
        added = vigil.monitor('new')
        assert added.engine is engine and added.data is not None and added.jobs is not None
        assert not engine._monitor_tasks['new'].done()

    async def test_a_changed_monitor_is_replaced_and_keeps_its_history(self, vigil):
        engine = await vigil.start([_probe('a')])
        old, task = vigil.monitor('a'), engine._monitor_tasks['a']
        engine.db.insert_status('a', 'failed')
        result = await vigil.reload([_probe('a', interval=10)])
        assert result.changed == ['a']
        new = vigil.monitor('a')
        assert new is not old and new.interval == 10
        assert task.cancelled() and not engine._monitor_tasks['a'].done()
        assert engine.db.latest_status('a') == 'failed'

    async def test_a_group_re_resolves_its_children(self, vigil):
        group = {'name': 'g', 'id': 'g', 'type': 'group', 'children': [_probe('a')]}
        engine = await vigil.start([group])
        kept_group = vigil.monitor('g')
        group['children'] = [_probe('a'), _probe('b')]
        result = await vigil.reload([group])
        assert result.added == ['b'] and result.changed == []
        assert vigil.monitor('g') is kept_group
        assert [c.id for c in kept_group.children] == ['a', 'b']
        assert engine.plugins == [kept_group]

    async def test_a_monitor_moved_between_groups_keeps_its_instance(self, vigil):
        one = {'name': 'one', 'id': 'one', 'type': 'group', 'children': [_probe('a')]}
        two = {'name': 'two', 'id': 'two', 'type': 'group', 'children': []}
        engine = await vigil.start([one, two])
        a, version = vigil.monitor('a'), engine.monitors_version
        one['children'], two['children'] = [], [_probe('a')]
        result = await vigil.reload([one, two])
        assert (result.added, result.removed, result.changed) == ([], [], [])
        assert vigil.monitor('two').children == [a]
        assert engine.monitors_version == version + 1

    async def test_ssh_defaults_decide_what_changed(self, vigil):
        engine = await vigil.start([_ssh('a', 'h1'), _probe('b')], ssh_defaults={'username': 'one'})
        result = await vigil.reload([_ssh('a', 'h1'), _probe('b')], ssh_defaults={'username': 'two'})
        assert result.changed == ['a']
        assert vigil.monitor('a').config['ssh_config']['username'] == 'two'
        assert engine._exec_contexts['a'].conn is not None

    async def test_an_in_flight_cycle_of_a_replaced_monitor_writes_nothing(self, vigil):
        engine = await vigil.start([_probe('a')])
        old = vigil.monitor('a')
        await vigil.reload([_probe('a', interval=10)])
        engine._apply = MagicMock()
        assert await engine._run_cycle(old) is False
        engine._apply.assert_not_called()


class TestRefusedReload:
    @pytest.mark.parametrize('content, error', [
        ('plugins: [unclosed', 'Failed to parse YAML'),
        ('', 'empty or not a mapping'),
    ])
    async def test_an_unreadable_file_keeps_the_running_config(self, vigil, content, error):
        engine = await vigil.start([_probe('a')])
        before = list(engine.plugins)
        vigil.path.write_text(content)
        result = await engine.reload_config('test')
        assert not result.ok and error in result.error
        assert engine.plugins == before

    async def test_an_unknown_type_applies_nothing(self, vigil):
        engine = await vigil.start([_probe('a')])
        a = vigil.monitor('a')
        result = await vigil.reload([_probe('a', interval=5), {'name': 'x', 'id': 'x', 'type': 'nope'}])
        assert not result.ok and "no plugin type 'nope'" in result.error
        assert vigil.monitor('a') is a and a.interval == 60

    async def test_duplicate_ids_apply_nothing(self, vigil):
        engine = await vigil.start([_probe('a')])
        result = await vigil.reload([_probe('a'), _probe('b'), {**_probe('b'), 'name': 'other'}])
        assert not result.ok and 'duplicate monitor id(s) b' in result.error
        assert [p.id for p in engine.plugins] == ['a']

    async def test_a_missing_file_applies_nothing(self, vigil):
        engine = await vigil.start([_probe('a')])
        vigil.path.unlink()
        result = await engine.reload_config('test')
        assert not result.ok and 'not found' in result.error

    async def test_the_failure_is_recorded_as_an_event(self, vigil):
        engine = await vigil.start([_probe('a')])
        vigil.path.write_text('plugins: [unclosed')
        await engine.reload_config('SIGHUP')
        event = engine.db.recent_events(limit=1)[0]
        assert event['level'] == 'ERROR'
        assert 'Config reload (SIGHUP) failed, still running the previous config' in event['message']

    async def test_nothing_reloads_before_the_engine_is_ready(self, tmp_path):
        setup = Setup(tmp_path)
        setup.write([_probe('a')])
        engine = VigilEngine(str(setup.path))
        result = await engine.reload_config('test')
        assert not result.ok and result.error == 'Vigil is still starting'


class TestConnections:
    async def test_an_ssh_connection_nobody_uses_is_closed(self, vigil):
        engine = await vigil.start([_ssh('a', 'h1'), _ssh('b', 'h2'), _ssh('c', 'h2')])
        h1, h2 = engine._exec_contexts['a'].conn, engine._exec_contexts['b'].conn
        await vigil.reload([_ssh('b', 'h2')])
        h1.close.assert_called_once()
        h2.close.assert_not_called()
        assert engine._exec_contexts['b'].conn is h2

    async def test_a_changed_monitor_on_the_same_host_reuses_the_connection(self, vigil):
        engine = await vigil.start([_ssh('a', 'h1')])
        conn = engine._exec_contexts['a'].conn
        await vigil.reload([_ssh('a', 'h1', interval=5)])
        assert engine._exec_contexts['a'].conn is conn
        conn.close.assert_not_called()

    async def test_agent_streams_follow_the_monitors(self, vigil):
        agents = [{'id': 'node', 'token': 't'}]
        engine = await vigil.start([_probe('a', agent='node', stream='one'),
                                    _probe('b', agent='node', stream='b')], agents=agents)
        conn = engine.connectors.agents.get('node')
        sent = []
        conn.push_subscriptions = AsyncMock(side_effect=lambda: sent.append(sorted(
            (s.id, s.params['unit']) for s in conn.streams)))
        await vigil.reload([_probe('a', agent='node', stream='two')], agents=agents)
        assert sent == [[], [('a:watch', 'two')]]
        assert set(engine._event_targets) == {'a:watch'}
        assert engine._event_targets['a:watch'] is vigil.monitor('a')

    async def test_an_agent_keeps_its_connection_and_a_dropped_one_loses_its_token(self, vigil):
        agents = [{'id': 'node', 'token': 't'}, {'id': 'old', 'token': 'x'}]
        engine = await vigil.start([_probe('a', agent='node')], agents=agents)
        conn = engine.connectors.agents.get('node')
        await vigil.reload([_probe('a', agent='node')], agents=[{'id': 'node', 'token': 'new'}])
        assert engine.connectors.agents.get('node') is conn
        assert engine._exec_contexts['a'].conn is conn
        assert engine.connectors.agents.token_for('node') == 'new'
        assert engine.connectors.agents.token_for('old') is None


class TestGlobalSettings:
    async def test_notifications_follow_a_changed_tree(self, vigil):
        engine = await vigil.start([_probe('a')])
        before = engine.notifications
        await vigil.reload([_probe('a')])
        assert engine.notifications is before
        await vigil.reload([_probe('a'), _probe('b')])
        assert engine.notifications is not before

    async def test_notifications_follow_their_section(self, vigil):
        engine = await vigil.start([_probe('a')])
        before = engine.notifications
        await vigil.reload([_probe('a')], notifications={'base_url': 'https://vigil.lan'})
        assert engine.notifications is not before
        assert engine.notifications.base_url == 'https://vigil.lan'

    async def test_exporters_restart_when_their_section_changes(self, vigil):
        engine = await vigil.start([_probe('a')])
        old = engine.exporters
        old.stop = MagicMock()
        await vigil.reload([_probe('a')], exporters={'influxdb': {'url': ''}})
        old.stop.assert_called_once()
        assert engine.exporters is not old

    async def test_retention_and_log_levels_apply(self, vigil):
        engine = await vigil.start([_probe('a')])
        await vigil.reload([_probe('a')], logging={'retention_days': 3, 'level': 'ERROR'})
        assert engine.log_retention_days == 3
        assert logging.getLogger().level == logging.ERROR

    async def test_startup_only_settings_are_reported(self, vigil):
        await vigil.start([_probe('a')])
        result = await vigil.reload([_probe('a')], memory={'metric_history': 10}, theme={'scheme': 'dark'},
                                    auth={'username': 'u', 'password': 'p'})
        assert result.ok
        assert result.restart_required == ['memory', 'auth', 'theme']
        assert 'restart required for: memory, auth, theme' in result.summary()

    async def test_plugin_paths_reload_an_edited_plugin(self, vigil):
        engine = await vigil.start([_probe('a')])
        (vigil.tmp_path / 'plugins' / 'probe.py').write_text(PROBE + '\nMARK = 2\n')
        await vigil.reload([_probe('a'), _probe('b')])
        assert sys.modules['vigil_external.probe'].MARK == 2
        assert type(vigil.monitor('b')).__module__ == 'vigil_external.probe'
        assert engine._plugin_loader is not None


class TestReporting:
    async def test_a_summary_event_is_recorded(self, vigil):
        engine = await vigil.start([_probe('a'), _probe('b')])
        await vigil.reload([_probe('a', interval=5), _probe('c')])
        event = engine.db.recent_events(limit=1)[0]
        assert event['level'] == 'INFO'
        assert 'Config reloaded (test): 1 added, 1 removed, 1 changed' in event['message']

    async def test_the_ui_is_told_the_monitors_changed(self, vigil):
        engine = await vigil.start([_probe('a')])
        seen = []
        unsubscribe = CHANGES.subscribe(lambda kind, _: seen.append(kind))
        try:
            version = engine.monitors_version
            await vigil.reload([_probe('a')])
            assert engine.monitors_version == version and changes.MONITORS not in seen
            await vigil.reload([_probe('a'), _probe('b')])
            assert engine.monitors_version == version + 1 and changes.MONITORS in seen
        finally:
            unsubscribe()

    async def test_reloads_run_one_at_a_time(self, vigil):
        engine = await vigil.start([_probe('a')])
        inside, overlapped = [], []
        real = engine._apply_reload

        async def slow(plan, result):
            if inside:
                overlapped.append(True)
            inside.append(True)
            await asyncio.sleep(0.05)
            await real(plan, result)
            inside.pop()

        engine._apply_reload = slow
        vigil.write([_probe('a'), _probe('b')])
        results = await asyncio.gather(engine.reload_config('one'), engine.reload_config('two'))
        assert overlapped == []
        assert [r.added for r in results] == [['b'], []]


class TestTriggers:
    async def _wait_for(self, predicate, seconds=3.0):
        for _ in range(int(seconds / 0.02)):
            if predicate():
                return True
            await asyncio.sleep(0.02)
        return False

    async def test_a_changed_file_is_reloaded(self, vigil, monkeypatch):
        monkeypatch.setattr(engine_module, 'CONFIG_POLL_SECONDS', 0.02)
        engine = await vigil.start([_probe('a')])
        vigil.write([_probe('a'), _probe('b')])
        assert await self._wait_for(lambda: 'b' in engine._monitor_tasks)

    async def test_a_re_pointed_symlink_is_reloaded(self, tmp_path, monkeypatch):
        monkeypatch.setattr(engine_module, 'CONFIG_POLL_SECONDS', 0.02)
        setup = Setup(tmp_path)
        setup.write([_probe('a')])
        store_one = tmp_path / 'one.yaml'
        os.rename(setup.path, store_one)
        os.symlink(store_one, setup.path)
        setup.engine = engine = VigilEngine(str(setup.path))
        engine.setup_modules()
        engine._start_exporters = MagicMock()
        await engine.run()
        try:
            store_two = tmp_path / 'two.yaml'
            store_two.write_text(store_one.read_text().replace('plugins:\n', 'plugins:\n- {id: b, name: b, type: probe}\n'))
            os.unlink(setup.path)
            os.symlink(store_two, setup.path)
            assert await self._wait_for(lambda: 'b' in engine._monitor_tasks)
        finally:
            engine.shutdown()

    async def test_a_touch_without_an_edit_reloads_nothing(self, vigil, monkeypatch):
        monkeypatch.setattr(engine_module, 'CONFIG_POLL_SECONDS', 0.02)
        engine = await vigil.start([_probe('a')])
        engine.reload_config = AsyncMock()
        os.utime(vigil.path, ns=(1, 1))
        await asyncio.sleep(0.2)
        engine.reload_config.assert_not_called()

    async def test_sighup_reloads(self, vigil):
        engine = await vigil.start([_probe('a')])
        engine._install_signal_handlers()
        vigil.write([_probe('a'), _probe('b')])
        os.kill(os.getpid(), signal.SIGHUP)
        assert await self._wait_for(lambda: 'b' in engine._monitor_tasks)


class TestApi:
    def _client(self, result):
        engine = SimpleNamespace(plugins=[], db=SimpleNamespace(), reload_config=AsyncMock(return_value=result))
        app = FastAPI()
        register_api(app, engine)
        return TestClient(app), engine

    def test_a_reload_answers_with_its_summary(self):
        client, engine = self._client(ReloadResult('REST API', added=['b'], restart_required=['theme']))
        response = client.post('/api/config/reload')
        assert response.status_code == 200
        body = response.json()
        assert body['added'] == ['b'] and body['restart_required'] == ['theme'] and body['ok'] is True
        engine.reload_config.assert_awaited_once_with('REST API')

    def test_a_refused_reload_is_a_422(self):
        client, _ = self._client(ReloadResult('REST API', ok=False, error='bad yaml'))
        response = client.post('/api/config/reload')
        assert response.status_code == 422
        assert response.json()['error'] == 'bad yaml'


class TestDashboard:
    def _engine(self, *ids):
        return SimpleNamespace(plugins=[SimpleNamespace(id=i, children=[]) for i in ids])

    def test_a_monitor_page_follows_its_replacement(self):
        engine = self._engine('a')
        state = DashboardState(current_view='plugin', selected_plugin=SimpleNamespace(id='a'))
        assert after_reload(engine, state) == 'redraw'
        assert state.selected_plugin is engine.plugins[0]

    def test_a_removed_monitors_page_goes_to_the_overview(self):
        state = DashboardState(current_view='plugin', selected_plugin=SimpleNamespace(id='gone'))
        assert after_reload(self._engine('a'), state) == 'overview'

    def test_the_overview_redraws_and_the_events_page_does_not(self):
        assert after_reload(self._engine(), DashboardState(current_view='overview')) == 'redraw'
        assert after_reload(self._engine(), DashboardState(current_view='events')) is None


class TestPureParts:
    def test_restart_required_ignores_an_overridden_database_path(self):
        old, new = {'database': {'path': 'a.db'}}, {'database': {'path': 'b.db'}}
        assert restart_required(old, new) == ['database.path']
        assert restart_required(old, new, db_path_overridden=True) == []

    def test_a_failed_result_says_so(self):
        result = ReloadResult('SIGHUP', ok=False, error='boom')
        assert result.summary() == 'Config reload (SIGHUP) failed, still running the previous config: boom'

    def test_strict_config_raises(self, tmp_path):
        path = tmp_path / 'c.yaml'
        path.write_text('- a list')
        with pytest.raises(ConfigError):
            ConfigFileManager(str(path), strict=True)
        assert ConfigFileManager(str(path)).data == {}

    def test_the_digest_tracks_the_bytes(self, tmp_path):
        path = tmp_path / 'c.yaml'
        path.write_text('plugins: []\n')
        first = ConfigFileManager(str(path)).digest
        path.write_text('plugins: []\n# edited\n')
        assert ConfigFileManager(str(path)).digest != first

    def test_close_unused(self):
        engine = ConnectorEngine()
        kept, dropped = MagicMock(), MagicMock()
        engine._ssh_conns = {('a', 22, None, None): kept, ('b', 22, None, None): dropped}
        assert engine.close_unused([kept]) == 1
        dropped.close.assert_called_once()
        assert list(engine._ssh_conns.values()) == [kept]
