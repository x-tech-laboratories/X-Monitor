"""Runtime log levels: config at startup, the REST API, the dashboard dialog and the signals."""

import asyncio
import logging
import os
import signal
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient
from nicegui import ui
from nicegui.testing import User

from vigil.core.coordination.engine import VigilEngine
from vigil.core.database.database import db
from vigil.core.settings.config_file import ConfigFileManager
from vigil.core.settings.log_levels import LogLevels, normalize_level
from vigil.core.ui.api import register_api
from vigil.core.ui.views.system import open_log_levels_dialog

pytest_plugins = ['nicegui.testing.user_plugin']

SSH = 'vigil.core.connectors.ssh_connector'


@pytest.fixture(autouse=True)
def restore_levels():
    """Put the root and every logger a test touches back the way they were."""
    root = logging.getLogger().level
    names = (SSH, 'vigil.plugins.cpu', 'vigil.test.other')
    before = {name: logging.getLogger(name).level for name in names}
    yield
    logging.getLogger().setLevel(root)
    for name, level in before.items():
        logging.getLogger(name).setLevel(level)
    if not db.is_closed():
        db.close()


@pytest.fixture
def levels():
    logging.getLogger().setLevel(logging.INFO)
    return LogLevels()


class TestNormalize:
    def test_any_case(self):
        assert normalize_level('debug') == 'DEBUG'

    def test_unknown_level_is_refused(self):
        with pytest.raises(ValueError, match='unknown log level'):
            normalize_level('LOUD')


class TestSetLevel:
    def test_root(self, levels):
        levels.set_level(None, 'DEBUG')
        assert logging.getLogger().level == logging.DEBUG

    def test_one_logger(self, levels):
        result = levels.set_level(SSH, 'debug')
        assert logging.getLogger(SSH).level == logging.DEBUG
        assert result == {'root': 'INFO', SSH: 'DEBUG'}

    def test_no_level_makes_a_logger_inherit_again(self, levels):
        levels.set_level(SSH, 'DEBUG')
        result = levels.set_level(SSH, None)
        assert logging.getLogger(SSH).level == logging.NOTSET
        assert SSH not in result

    def test_the_root_cannot_be_unset(self, levels):
        with pytest.raises(ValueError):
            levels.set_level('root', None)

    def test_a_bad_level_changes_nothing(self, levels):
        with pytest.raises(ValueError):
            levels.set_level(SSH, 'LOUD')
        assert logging.getLogger(SSH).level == logging.NOTSET

    def test_every_change_is_logged_as_a_warning_even_when_logging_is_quiet(self, levels, caplog):
        levels.set_level(None, 'ERROR')
        levels.set_level(SSH, 'DEBUG', source='dashboard')
        record = next(r for r in caplog.records if SSH in r.getMessage())
        assert record.levelno == logging.WARNING
        assert 'from inherited to DEBUG (dashboard)' in record.getMessage()


class TestStep:
    def test_more_verbose(self, levels):
        assert levels.step(more_verbose=True, source='SIGUSR1') == 'DEBUG'

    def test_quieter(self, levels):
        assert levels.step(more_verbose=False, source='SIGUSR2') == 'WARNING'

    def test_stops_at_either_end(self, levels):
        levels.set_level(None, 'DEBUG')
        assert levels.step(more_verbose=True, source='SIGUSR1') == 'DEBUG'
        levels.set_level(None, 'CRITICAL')
        assert levels.step(more_verbose=False, source='SIGUSR2') == 'CRITICAL'


class TestConfigure:
    def test_sets_root_and_named_levels(self, levels):
        levels.configure('WARNING', {SSH: 'DEBUG'})
        assert logging.getLogger().level == logging.WARNING
        assert logging.getLogger(SSH).level == logging.DEBUG

    def test_no_root_level_keeps_the_starting_one(self, levels):
        levels.configure('ERROR', {})
        levels.configure(None, {})
        assert logging.getLogger().level == logging.INFO

    def test_a_logger_dropped_from_config_inherits_again(self, levels):
        levels.configure(None, {SSH: 'DEBUG', 'vigil.plugins.cpu': 'ERROR'})
        levels.configure(None, {'vigil.plugins.cpu': 'ERROR'})
        assert logging.getLogger(SSH).level == logging.NOTSET
        assert logging.getLogger('vigil.plugins.cpu').level == logging.ERROR

    def test_a_logger_set_by_hand_survives_a_config_that_never_named_it(self, levels):
        levels.set_level('vigil.test.other', 'DEBUG')
        levels.configure(None, {SSH: 'DEBUG'})
        levels.configure(None, {})
        assert logging.getLogger('vigil.test.other').level == logging.DEBUG

    def test_a_bad_entry_is_reported_and_the_rest_apply(self, levels, caplog):
        with caplog.at_level(logging.WARNING):
            levels.configure(None, {'vigil.test.other': 'LOUD', SSH: 'DEBUG'})
        assert logging.getLogger(SSH).level == logging.DEBUG
        assert "unknown log level 'LOUD'" in caplog.text

    def test_known_loggers_are_vigils(self):
        known = LogLevels.known_loggers()
        assert SSH in known
        assert all(n == 'asyncssh' or n.startswith('vigil') for n in known)


class TestConfigFile:
    def _load(self, tmp_path, section):
        path = tmp_path / 'config.yaml'
        path.write_text(yaml.dump({'logging': section}))
        return ConfigFileManager(str(path))

    def test_level_and_levels(self, tmp_path):
        cfg = self._load(tmp_path, {'level': 'DEBUG', 'levels': {SSH: 'WARNING'}})
        assert cfg.log_level == 'DEBUG'
        assert cfg.log_levels == {SSH: 'WARNING'}

    def test_unset(self, tmp_path):
        cfg = self._load(tmp_path, {})
        assert cfg.log_level is None
        assert cfg.log_levels == {}

    def test_levels_that_are_not_a_mapping_are_ignored(self, tmp_path, caplog):
        cfg = self._load(tmp_path, {'levels': ['DEBUG']})
        with caplog.at_level(logging.WARNING):
            assert cfg.log_levels == {}
        assert 'logging.levels should be a mapping' in caplog.text


def _engine(tmp_path, logging_cfg=None, **kwargs):
    cfg = tmp_path / 'config.yaml'
    cfg.write_text(yaml.dump({'database': {'path': str(tmp_path / 't.db')}, 'plugins': [],
                              'logging': logging_cfg or {}}))
    with patch('vigil.core.connectors.engine.SSHConnection'):
        return VigilEngine(str(cfg), **kwargs)


class TestEngine:
    def test_config_levels_apply_at_startup(self, tmp_path):
        _engine(tmp_path, {'level': 'ERROR', 'levels': {SSH: 'DEBUG'}})
        assert logging.getLogger().level == logging.ERROR
        assert logging.getLogger(SSH).level == logging.DEBUG

    def test_set_log_level(self, tmp_path):
        engine = _engine(tmp_path)
        engine.set_log_level(SSH, 'DEBUG')
        assert engine.log_levels()[SSH] == 'DEBUG'
        assert SSH in engine.known_loggers()

    async def test_signals_step_the_root_level(self, tmp_path):
        engine = _engine(tmp_path, {'level': 'INFO'}, handle_signals=True)
        engine._install_signal_handlers()
        try:
            os.kill(os.getpid(), signal.SIGUSR1)
            await asyncio.sleep(0.05)
            assert logging.getLogger().level == logging.DEBUG
            os.kill(os.getpid(), signal.SIGUSR2)
            os.kill(os.getpid(), signal.SIGUSR2)
            await asyncio.sleep(0.05)
            assert logging.getLogger().level == logging.WARNING
        finally:
            engine._remove_signal_handlers()
        assert engine._signals_installed == []

    async def test_no_signals_unless_asked(self, tmp_path):
        engine = _engine(tmp_path)
        engine._start_exporters = lambda: None
        await engine.run()
        try:
            assert engine._signals_installed == []
        finally:
            engine.shutdown()


class _Engine:
    """The log-level slice of the engine, backed by a real LogLevels."""

    def __init__(self):
        self._levels = LogLevels()
        self.plugins = []
        self.db = SimpleNamespace()

    def log_levels(self):
        return self._levels.levels()

    def known_loggers(self):
        return self._levels.known_loggers()

    def set_log_level(self, logger, level, source='runtime'):
        return self._levels.set_level(logger, level, source=source)


@pytest.fixture
def api():
    logging.getLogger().setLevel(logging.INFO)
    app = FastAPI()
    register_api(app, _Engine())
    return TestClient(app)


class TestApi:
    def test_reads_the_levels(self, api):
        body = api.get('/api/log-levels').json()
        assert body['levels']['root'] == 'INFO'
        assert SSH in body['loggers']

    def test_sets_one_logger(self, api):
        response = api.post('/api/log-levels', json={'logger': SSH, 'level': 'DEBUG'})
        assert response.status_code == 200
        assert response.json()['levels'][SSH] == 'DEBUG'
        assert logging.getLogger(SSH).level == logging.DEBUG

    def test_no_logger_means_the_root(self, api):
        api.post('/api/log-levels', json={'level': 'WARNING'})
        assert logging.getLogger().level == logging.WARNING

    def test_null_level_resets(self, api):
        api.post('/api/log-levels', json={'logger': SSH, 'level': 'DEBUG'})
        body = api.post('/api/log-levels', json={'logger': SSH, 'level': None}).json()
        assert SSH not in body['levels']

    def test_a_bad_level_is_a_400(self, api):
        response = api.post('/api/log-levels', json={'logger': SSH, 'level': 'LOUD'})
        assert response.status_code == 400
        assert 'unknown log level' in response.json()['error']

    def test_a_body_that_is_not_an_object_is_a_400(self, api):
        assert api.post('/api/log-levels', content=b'nope').status_code == 400
        assert api.post('/api/log-levels', json=['DEBUG']).status_code == 400


@pytest.mark.nicegui_main_file(None)
class TestDialog:
    @pytest.fixture
    def page(self):
        logging.getLogger().setLevel(logging.INFO)
        engine = _Engine()

        @ui.page('/levels')
        def _levels():
            open_log_levels_dialog(engine)

        return engine

    async def test_lists_the_root_level(self, user: User, page):
        await user.open('/levels')
        await user.should_see('Log levels')
        await user.should_see('INFO')

    async def test_applies_a_level(self, user: User, page):
        await user.open('/levels')
        user.find(marker='logger').elements.pop().value = SSH
        user.find(marker='level').elements.pop().value = 'ERROR'
        user.find(marker='apply').click()
        await user.should_see(f'{SSH} is now ERROR')
        assert logging.getLogger(SSH).level == logging.ERROR

    async def test_resets_a_named_logger(self, user: User, page):
        page.set_log_level(SSH, 'DEBUG')
        await user.open('/levels')
        user.find(marker=f'reset-{SSH}').click()
        await user.should_see(f'{SSH} is now inherited')
        assert logging.getLogger(SSH).level == logging.NOTSET
