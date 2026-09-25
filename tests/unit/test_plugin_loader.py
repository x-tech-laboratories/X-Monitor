"""Resolving a monitor's type to its Plugin class, from Vigil's own plugins or from plugin_paths."""

import logging
import sys
import textwrap
from unittest.mock import patch

import pytest
import yaml

from vigil.core.coordination.plugin_loader import PluginLoader, PluginPath, parse_plugin_paths
from vigil.core.database.database import db

PLUGIN = textwrap.dedent('''
    from vigil.plugins.base.plugin_base import Plugin
    from vigil.core.connectors.types import CollectResult

    class {cls}(Plugin):
        MARK = {mark!r}

        def parse(self, results):
            return CollectResult(status='online')
''')


@pytest.fixture(autouse=True)
def forget_external_modules():
    yield
    for name in [m for m in sys.modules if m == 'vigil_external' or m.startswith('vigil_external.')]:
        del sys.modules[name]
    if not db.is_closed():
        db.close()


def _write(directory, name, cls='Hello', mark='external', body=None):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.py").write_text(body if body is not None else PLUGIN.format(cls=cls, mark=mark))


def _loader(*directories, override=False):
    return PluginLoader([PluginPath(d, override) for d in directories])


class TestBuiltin:
    def test_a_built_in_type_resolves(self):
        assert PluginLoader().resolve('cpu').__name__ == 'Cpu'

    def test_the_class_is_imported_once(self):
        loader = PluginLoader()
        assert loader.resolve('cpu') is loader.resolve('cpu')


class TestExternal:
    def test_a_module_file(self, tmp_path):
        _write(tmp_path, 'hello')
        cls = _loader(tmp_path).resolve('hello')
        assert cls.__name__ == 'Hello'
        assert cls.__module__ == 'vigil_external.hello'

    def test_a_package_whose_class_lives_in_a_submodule(self, tmp_path):
        package = tmp_path / 'weather'
        package.mkdir()
        (package / '__init__.py').write_text('from .monitor import Weather\n')
        (package / 'monitor.py').write_text(PLUGIN.format(cls='Weather', mark='pkg'))
        cls = _loader(tmp_path).resolve('weather')
        assert cls.__name__ == 'Weather'
        assert cls.__module__ == 'vigil_external.weather.monitor'

    def test_the_first_directory_that_has_it_wins(self, tmp_path):
        _write(tmp_path / 'a', 'hello', mark='a')
        _write(tmp_path / 'b', 'hello', mark='b')
        assert _loader(tmp_path / 'a', tmp_path / 'b').resolve('hello').MARK == 'a'

    def test_a_new_loader_reads_an_edited_file(self, tmp_path):
        _write(tmp_path, 'hello', mark='first')
        assert _loader(tmp_path).resolve('hello').MARK == 'first'
        _write(tmp_path, 'hello', mark='second')
        assert _loader(tmp_path).resolve('hello').MARK == 'second'


class TestShadowing:
    def test_a_built_in_wins_and_the_shadowed_file_is_named(self, tmp_path, caplog):
        _write(tmp_path, 'cpu', cls='MyCpu')
        with caplog.at_level(logging.WARNING):
            cls = _loader(tmp_path).resolve('cpu')
        assert cls.__name__ == 'Cpu'
        assert 'shadowed by Vigil\'s built-in plugin' in caplog.text
        assert 'override: true' in caplog.text

    def test_override_lets_the_external_one_win(self, tmp_path, caplog):
        _write(tmp_path, 'cpu', cls='MyCpu')
        with caplog.at_level(logging.WARNING):
            cls = _loader(tmp_path, override=True).resolve('cpu')
        assert cls.__name__ == 'MyCpu'
        assert "overrides Vigil's built-in plugin" in caplog.text


class TestErrors:
    def test_an_unknown_type_names_where_it_looked(self, tmp_path):
        with pytest.raises(ValueError, match=r"no plugin type 'nope'.*" + str(tmp_path)):
            _loader(tmp_path).resolve('nope')

    def test_an_unknown_type_with_no_paths(self):
        with pytest.raises(ValueError, match='none configured'):
            PluginLoader().resolve('nope')

    @pytest.mark.parametrize('name', ['../escape', 'a.b', '', 'has space'])
    def test_a_name_that_is_not_a_module_name_is_refused(self, name):
        with pytest.raises(ValueError, match='not a valid module name'):
            PluginLoader().resolve(name)

    def test_a_module_with_no_plugin_class(self, tmp_path):
        _write(tmp_path, 'empty', body='X = 1\n')
        with pytest.raises(ValueError, match='defines no concrete Plugin subclass'):
            _loader(tmp_path).resolve('empty')

    def test_a_module_with_two_plugin_classes(self, tmp_path):
        body = PLUGIN.format(cls='One', mark='1') + PLUGIN.format(cls='Two', mark='2').split('\n\n', 1)[1]
        _write(tmp_path, 'double', body=body)
        with pytest.raises(ValueError, match='more than one Plugin subclass'):
            _loader(tmp_path).resolve('double')

    def test_a_module_that_fails_to_import(self, tmp_path):
        _write(tmp_path, 'broken', body='import no_such_module_anywhere\n')
        with pytest.raises(ValueError, match="failed to import: ModuleNotFoundError"):
            _loader(tmp_path).resolve('broken')
        assert 'vigil_external.broken' not in sys.modules


class TestParsePaths:
    def test_relative_paths_are_under_the_config_directory(self, tmp_path):
        (tmp_path / 'plugins').mkdir()
        assert parse_plugin_paths(['plugins'], tmp_path) == [PluginPath(tmp_path / 'plugins')]

    def test_a_mapping_can_override(self, tmp_path):
        paths = parse_plugin_paths([{'path': str(tmp_path), 'override': True}], tmp_path)
        assert paths == [PluginPath(tmp_path, True)]

    def test_a_missing_directory_is_reported_and_skipped(self, tmp_path, caplog):
        with caplog.at_level(logging.WARNING):
            assert parse_plugin_paths(['nowhere'], tmp_path) == []
        assert 'is not a directory' in caplog.text

    def test_an_entry_with_no_path_is_reported(self, tmp_path, caplog):
        with caplog.at_level(logging.WARNING):
            assert parse_plugin_paths([{'override': True}], tmp_path) == []
        assert 'names no directory' in caplog.text


class TestEngine:
    def test_a_monitor_of_an_external_type_loads(self, tmp_path):
        from vigil.core.coordination.engine import VigilEngine
        _write(tmp_path / 'my-plugins', 'hello')
        cfg = tmp_path / 'config.yaml'
        cfg.write_text(yaml.dump({
            'database': {'path': str(tmp_path / 't.db')},
            'plugin_paths': ['my-plugins'],
            'plugins': [{'name': 'Hi', 'id': 'hi', 'type': 'hello', 'target_host': 'h'},
                        {'name': 'Gone', 'id': 'gone', 'type': 'nope'}],
        }))
        with patch('vigil.core.connectors.engine.SSHConnection'):
            engine = VigilEngine(str(cfg))
            engine.setup_modules()
        assert [type(p).__name__ for p in engine.plugins] == ['Hello']
