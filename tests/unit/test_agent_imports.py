"""The agent carries X-Monitor's plugins and engine but never the dashboard, so it must import without the UI's libraries."""

import subprocess
import sys

from x_monitor.code_version import code_version

# The libraries only the server installs: the dashboard and its web stack, and the notification and export extras.
_SERVER_ONLY = ('nicegui', 'fastapi', 'starlette', 'uvicorn', 'apprise', 'aiomqtt', 'paho')

_PROBE = f'''
import importlib, pkgutil, sys

class _ServerOnly:
    def find_spec(self, name, path=None, target=None):
        if name.split('.')[0] in {_SERVER_ONLY!r}:
            raise ImportError('server-only library ' + name)
        return None

sys.meta_path.insert(0, _ServerOnly())
import x_monitor_agent.__main__
import x_monitor.core.coordination.engine
import x_monitor.plugins as plugins
for module in pkgutil.iter_modules(plugins.__path__):
    importlib.import_module('x_monitor.plugins.' + module.name)
'''


def test_the_agent_and_every_plugin_import_without_server_only_libraries():
    result = subprocess.run([sys.executable, '-c', _PROBE], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_the_code_version_is_a_stable_short_hash():
    assert code_version() == code_version()
    assert len(code_version()) == 16 and int(code_version(), 16) >= 0
