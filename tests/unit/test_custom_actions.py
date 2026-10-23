"""Custom actions: parsing a monitor's `actions` list, the buttons they add to any plugin, and how the engine runs them."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from x_monitor.__main__ import XMonitorEngine
from x_monitor.core.connectors.types import ActionPlan, CmdResult
from x_monitor.plugins.base.custom_actions import parse_custom_actions
from x_monitor.plugins.group import Group
from x_monitor.plugins.systemd_service import SystemdService


# ===== Parsing =====

class TestParseCustomActions:
    def test_missing_list_means_none(self):
        assert parse_custom_actions(None) == []

    def test_id_comes_from_the_name(self):
        [action] = parse_custom_actions([{'name': 'Clear Cache!', 'command': 'rm -rf /var/cache/app/*'}])
        assert action.action_id == 'custom:clear_cache'
        assert action.command == 'rm -rf /var/cache/app/*'
        assert action.icon == 'terminal'

    def test_explicit_id_and_options(self):
        [action] = parse_custom_actions([{
            'name': 'Reboot', 'id': 'reboot', 'command': 'systemctl reboot', 'icon': 'power',
            'confirm': 'Reboot this host?', 'danger': True, 'timeout': '2m', 'agent': 'odin',
        }])
        assert action.action_id == 'custom:reboot'
        assert action.plan() == ActionPlan('systemctl reboot', timeout=120, agent='odin')
        assert action.button() == {'action_id': 'custom:reboot', 'name': 'Reboot', 'icon': 'power',
                                   'variant': 'danger', 'confirm': 'Reboot this host?'}

    def test_more_puts_the_button_in_the_more_menu(self):
        [action] = parse_custom_actions([{'name': 'Rotate Logs', 'command': 'logrotate -f /etc/logrotate.conf',
                                          'more': True}])
        assert action.button()['more'] is True

    def test_a_button_is_on_its_own_by_default(self):
        [action] = parse_custom_actions([{'name': 'Rotate Logs', 'command': 'true'}])
        assert 'more' not in action.button()

    @pytest.mark.parametrize('value', [
        {'name': 'x', 'command': 'y'},
        [{'name': 'No command'}],
        [{'command': 'true'}],
        [{'name': '!!!', 'command': 'true'}],
        [{'name': 'Same', 'command': 'a'}, {'name': 'same', 'command': 'b'}],
    ])
    def test_malformed_entries_are_refused(self, value):
        with pytest.raises(ValueError):
            parse_custom_actions(value)


# ===== Outcome =====

class TestInterpret:
    def test_success_logs_output(self):
        [action] = parse_custom_actions([{'name': 'Flush', 'command': 'flush'}])
        outcome = action.interpret(CmdResult(0, 'flushed 3\n', ''))
        assert outcome.success
        assert outcome.logs == [('Flush ran: flushed 3', 'INFO')]
        assert outcome.metadata == {'content': 'flushed 3\n'}

    def test_failure_logs_exit_code_and_error(self):
        [action] = parse_custom_actions([{'name': 'Flush', 'command': 'flush'}])
        outcome = action.interpret(CmdResult(2, '', 'permission denied\n'))
        assert not outcome.success
        assert outcome.logs == [('Flush failed (exit 2): permission denied', 'ERROR')]


# ===== Any plugin accepts them =====

_ACTIONS = [{'name': 'Clear Cache', 'command': 'rm -rf /tmp/cache'}]


class TestPluginActions:
    def test_custom_buttons_follow_the_plugins_own(self):
        plugin = SystemdService('nginx', {'service_name': 'nginx', 'actions': _ACTIONS})
        ids = [a.get('action_id') or a['name'] for a in plugin.all_actions()]
        assert ids[-1] == 'custom:clear_cache'
        assert ids[:-1] == [a.get('action_id') or a['name'] for a in plugin.get_actions()]

    def test_a_plugin_with_no_actions_of_its_own_gets_them(self):
        plugin = Group('Rack', {'actions': _ACTIONS})
        assert [a['action_id'] for a in plugin.all_actions()] == ['custom:clear_cache']
        assert plugin.custom_action('custom:clear_cache').command == 'rm -rf /tmp/cache'
        assert plugin.custom_action('clear_cache') is None


# ===== The engine runs them =====

def _engine(stdout='ok', exit_code=0):
    """An engine whose connector records the plan it is asked to run."""
    engine = object.__new__(XMonitorEngine)
    engine._exec_contexts = {}
    engine._apply = MagicMock()
    engine.connectors = MagicMock()
    engine.connectors.execute = AsyncMock(return_value=CmdResult(exit_code, stdout, ''))
    return engine


class TestDispatch:
    async def test_runs_the_command_and_logs_it(self):
        plugin = Group('Rack', {'actions': _ACTIONS})
        plugin.plan_action = MagicMock()
        engine = _engine()
        success, metadata = await engine.dispatch_action(plugin, 'custom:clear_cache')
        assert success and metadata == {'content': 'ok'}
        assert engine.connectors.execute.await_args.args[1] == ActionPlan('rm -rf /tmp/cache')
        assert engine._apply.call_args.args[1].logs == [('Clear Cache ran: ok', 'INFO')]
        plugin.plan_action.assert_not_called()

    async def test_failure_is_reported(self):
        plugin = Group('Rack', {'actions': _ACTIONS})
        success, _ = await _engine(exit_code=1).dispatch_action(plugin, 'custom:clear_cache')
        assert not success

    async def test_other_ids_still_reach_the_plugin(self):
        plugin = Group('Rack', {'actions': _ACTIONS})
        engine = _engine()
        assert await engine.dispatch_action(plugin, 'unknown') == (False, None)
        engine.connectors.execute.assert_not_awaited()
