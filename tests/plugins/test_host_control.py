import os
import subprocess

import pytest

from x_monitor.core.connectors.types import ActionPlan, CmdResult, CollectResult
from x_monitor.plugins.host_control import HostControl, parse_power


_PPD = """  performance:
    CpuDriver:\tintel_pstate
    Degraded:   no

* balanced:
    CpuDriver:\tintel_pstate
    PlatformDriver:\tplatform_profile

  power-saver:
    CpuDriver:\tintel_pstate
"""

_TUNED = """Available profiles:
- balanced                    - General non-specialized tuned profile
- powersave                   - Optimize for low power consumption
- throughput-performance      - Broadly applicable tuning
Current active profile: powersave
"""

def _cfg(**extra):
    base = {"name": "host1 control", "id": "host1-control", "ssh_config": {"host": "host1"}}
    base.update(extra)
    return base


def _results(power=f"backend=ppd\n{_PPD}", sleep="freeze mem disk"):
    return [CmdResult(0, power, ""), CmdResult(0, sleep, "")]


def _collected(make_plugin, **cfg):
    plugin = make_plugin(HostControl, _cfg(**cfg))
    plugin.storage.apply(plugin.parse(_results()))
    return plugin


class TestParsePower:
    def test_power_profiles_daemon_marks_the_current_one(self):
        power = parse_power(f"backend=ppd\n{_PPD}")
        assert power == {'backend': 'ppd', 'current': 'balanced',
                         'profiles': ['performance', 'balanced', 'power-saver']}

    def test_tuned(self):
        power = parse_power(f"backend=tuned\n{_TUNED}")
        assert power['current'] == 'powersave'
        assert power['profiles'] == ['balanced', 'powersave', 'throughput-performance']

    def test_platform_profile(self):
        power = parse_power("backend=sysfs\ncurrent=quiet\nchoices=quiet balanced performance")
        assert power == {'backend': 'sysfs', 'current': 'quiet',
                         'profiles': ['quiet', 'balanced', 'performance']}

    def test_nothing_available(self):
        assert parse_power("backend=none") == {'backend': 'none', 'current': None, 'profiles': []}
        assert parse_power("") == {'backend': 'none', 'current': None, 'profiles': []}


class TestCollection:
    async def test_everything_collected_is_online(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        result = plugin.parse(_results())
        assert result.status == 'online'
        assert result.metrics == {'power_profiles': 3.0, 'suspend_supported': 1.0}
        assert result.snapshot['power']['current'] == 'balanced'
        assert result.snapshot['can_suspend'] is True

    async def test_missing_tools_are_still_online(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        result = plugin.parse([CmdResult(0, "backend=none", ""), CmdResult(1, "", "No such file")])
        assert result.status == 'online'
        assert result.metrics == {'power_profiles': 0.0, 'suspend_supported': 0.0}
        assert not any(level in ('WARNING', 'ERROR') for _, level in result.logs)

    async def test_commands_are_valid_shell(self, make_plugin):
        for privilege in ('sudo', 'none'):
            plugin = make_plugin(HostControl, _cfg(privilege=privilege))
            for command in plugin.commands():
                subprocess.run(['sh', '-n', '-c', command.text], check=True)

    async def test_boot_entries_are_never_read(self, make_plugin):
        texts = [c.text for c in make_plugin(HostControl, _cfg()).commands()]
        assert len(texts) == 2
        assert not any(tool in text for text in texts for tool in ('bootctl', 'grub', 'efibootmgr'))

    async def test_power_command_runs_against_a_fake_tool(self, make_plugin, tmp_path):
        bin_dir = tmp_path / 'bin'
        bin_dir.mkdir()
        tool = bin_dir / 'powerprofilesctl'
        tool.write_text(f"#!/bin/sh\ncat <<'EOF'\n{_PPD}EOF\n")
        tool.chmod(0o755)
        env = {**os.environ, 'PATH': f"{bin_dir}:{os.environ['PATH']}"}
        plugin = make_plugin(HostControl, _cfg(privilege='none'))
        power_cmd, _ = plugin.commands()
        power = subprocess.run(['sh', '-c', power_cmd.text], env=env, capture_output=True, text=True)
        assert parse_power(power.stdout)['current'] == 'balanced'


class TestAllowList:
    @pytest.mark.parametrize('action', ['reboot', 'shutdown', 'suspend', 'identify', 'identify_off'])
    async def test_everything_is_refused_by_default(self, make_plugin, action):
        plugin = _collected(make_plugin)
        plan = plugin.plan_action(action)
        assert isinstance(plan, CollectResult)
        assert plan.success is False and plan.status is None
        assert plan.logs[0][0].endswith('refused: not in allow')
        assert 'host1' in plan.logs[0][0]

    async def test_refused_dialog_actions(self, make_plugin):
        plugin = _collected(make_plugin, allow=['reboot'])
        assert 'refused: not in allow' in plugin.plan_action('power_profile', profile='balanced').logs[0][0]

    async def test_next_boot_is_no_longer_an_action(self, make_plugin):
        plugin = _collected(make_plugin, allow=['next_boot', 'reboot'])
        assert plugin.plan_action('next_boot', entry='nixos-generation-100.conf') is None

    async def test_unknown_action_is_unhandled(self, make_plugin):
        assert _collected(make_plugin, allow=list(ACTIONS_ALL)).plan_action('format_disk') is None

    async def test_refusal_is_logged_to_events(self, make_plugin, db_manager):
        plugin = _collected(make_plugin)
        plugin.storage.apply(plugin.plan_action('reboot'))
        events = db_manager.plugin_events(plugin_id='host1-control', limit=1)
        assert 'Reboot on host1 refused: not in allow' in events[0]['message']


ACTIONS_ALL = ['reboot', 'shutdown', 'suspend', 'power_profile', 'identify']


class TestPowerActions:
    @pytest.mark.parametrize('action,verb', [('reboot', 'reboot'), ('shutdown', 'poweroff'),
                                             ('suspend', 'suspend')])
    async def test_systemctl_through_sudo(self, make_plugin, action, verb):
        plan = _collected(make_plugin, allow=[action]).plan_action(action)
        assert plan == ActionPlan(f"sudo -n systemctl {verb}")

    async def test_privilege_none(self, make_plugin):
        plan = _collected(make_plugin, allow=['reboot'], privilege='none').plan_action('reboot')
        assert plan == ActionPlan("systemctl reboot")

    async def test_success_is_logged(self, make_plugin):
        plugin = _collected(make_plugin, allow=['suspend'])
        outcome = plugin.interpret_action('suspend', CmdResult(0, "", ""))
        assert outcome.success is True
        assert outcome.logs == [("Suspend on host1: done", "INFO")]

    @pytest.mark.parametrize('stderr', ['Connection lost', '', 'Agent disconnected',
                                        'Timed out after 60.0s'])
    async def test_dropped_connection_after_sending_is_success(self, make_plugin, stderr):
        plugin = _collected(make_plugin, allow=['reboot'])
        outcome = plugin.interpret_action('reboot', CmdResult(-1, "", stderr))
        assert outcome.success is True
        assert 'dropped the connection' in outcome.logs[0][0]

    @pytest.mark.parametrize('stderr', ['Connect failed: [Errno 113] No route to host',
                                        "Agent 'host1' is not connected"])
    async def test_never_reaching_the_host_is_failure(self, make_plugin, stderr):
        plugin = _collected(make_plugin, allow=['shutdown'])
        outcome = plugin.interpret_action('shutdown', CmdResult(-1, "", stderr))
        assert outcome.success is False
        assert outcome.logs[0][1] == 'ERROR'
        assert outcome.status is None

    async def test_dropped_connection_is_failure_for_actions_that_keep_the_host_up(self, make_plugin):
        plugin = _collected(make_plugin, allow=['power_profile'])
        outcome = plugin.interpret_action('power_profile', CmdResult(-1, "", "Connection lost"),
                                          profile='balanced')
        assert outcome.success is False

    async def test_sudo_refusal_has_clear_text(self, make_plugin):
        plugin = _collected(make_plugin, allow=['reboot'])
        outcome = plugin.interpret_action('reboot', CmdResult(1, "", "sudo: a password is required"))
        assert outcome.success is False
        message = outcome.logs[0][0]
        assert 'sudo refused (sudo: a password is required)' in message
        assert 'without a password' in message

    async def test_other_failure_keeps_the_error(self, make_plugin):
        plugin = _collected(make_plugin, allow=['suspend'])
        outcome = plugin.interpret_action('suspend', CmdResult(1, "", "Sleep verb not supported"))
        assert outcome.logs[0][0] == "Suspend on host1 failed: Sleep verb not supported"


class TestPowerProfile:
    async def test_power_profiles_daemon(self, make_plugin):
        plan = _collected(make_plugin, allow=['power_profile']).plan_action('power_profile', profile='power-saver')
        assert plan == ActionPlan("sudo -n powerprofilesctl set power-saver")

    async def test_tuned(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg(allow=['power_profile']))
        plugin.storage.apply(plugin.parse(_results(power=f"backend=tuned\n{_TUNED}")))
        assert plugin.plan_action('power_profile', profile='balanced') == ActionPlan(
            "sudo -n tuned-adm profile balanced")

    async def test_platform_profile(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg(allow=['power_profile']))
        plugin.storage.apply(plugin.parse(_results(power="backend=sysfs\ncurrent=quiet\nchoices=quiet performance")))
        assert plugin.plan_action('power_profile', profile='performance') == ActionPlan(
            "echo performance | sudo -n tee /sys/firmware/acpi/platform_profile >/dev/null")

    async def test_unknown_profile_is_refused(self, make_plugin):
        plan = _collected(make_plugin, allow=['power_profile']).plan_action('power_profile', profile='turbo; rm -rf /')
        assert isinstance(plan, CollectResult) and plan.success is False
        assert 'unknown profile' in plan.logs[0][0]

    async def test_outcome_names_the_profile(self, make_plugin):
        plugin = _collected(make_plugin, allow=['power_profile'])
        outcome = plugin.interpret_action('power_profile', CmdResult(0, "", ""), profile='balanced')
        assert outcome.logs[0][0] == "Power profile balanced on host1: done"


class TestIdentify:
    async def test_ledctl_locate_and_off(self, make_plugin):
        plugin = _collected(make_plugin, allow=['identify'], identify_device='/dev/sda')
        assert plugin.identify_method == 'ledctl'
        assert plugin.plan_action('identify') == ActionPlan("sudo -n ledctl locate=/dev/sda")
        assert plugin.plan_action('identify_off') == ActionPlan("sudo -n ledctl locate_off=/dev/sda")

    async def test_beep_by_default(self, make_plugin):
        plugin = _collected(make_plugin, allow=['identify'])
        plan = plugin.plan_action('identify')
        assert plugin.identify_method == 'beep'
        assert 'sudo -n beep -r 5' in plan.command
        assert "printf '\\a' | sudo -n tee /dev/console" in plan.command
        subprocess.run(['sh', '-n', '-c', plan.command], check=True)
        assert 'stops by itself' in plugin.plan_action('identify_off').logs[0][0]

    async def test_ledctl_without_a_device_is_refused(self, make_plugin):
        plugin = _collected(make_plugin, allow=['identify'], identify_method='ledctl')
        assert 'identify_device is not set' in plugin.plan_action('identify').logs[0][0]

    async def test_identify_off_follows_the_identify_gate(self, make_plugin):
        plugin = _collected(make_plugin, identify_device='/dev/sda')
        assert 'not in allow' in plugin.plan_action('identify_off').logs[0][0]


class TestPage:
    async def test_cards_read_the_snapshot(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        plugin.storage.apply(plugin.parse(_results()))
        assert plugin._profile_text == 'balanced'
        assert plugin._suspend_text == 'Supported'
        assert plugin.power_profiles == ['performance', 'balanced', 'power-saver']

    async def test_before_collection(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        assert plugin._profile_text == 'n/a' and plugin._suspend_text == 'Unsupported'

    async def test_buttons_follow_allow(self, make_plugin):
        plugin = _collected(make_plugin, allow=['reboot', 'power_profile'])
        buttons = plugin.UI_SPEC['buttons']['controls']
        visible = [b['id'] for b in buttons if b['visible_if'](plugin)]
        assert visible == ['reboot', 'power_profile']

    async def test_every_direct_button_confirms_with_the_host(self, make_plugin):
        from x_monitor.core.ui.components import _substitute
        plugin = _collected(make_plugin, allow=ACTIONS_ALL, identify_device='/dev/sda')
        spec = plugin.UI_SPEC
        for button in spec['buttons']['controls']:
            template = button.get('confirm') or spec['dialogs'][button['dialog']]['confirm']
            text = _substitute(template, {'profile': 'balanced'}, plugin)
            assert 'host1' in text

    async def test_no_boot_entries_on_the_page(self, make_plugin):
        spec = _collected(make_plugin, allow=['next_boot', 'reboot']).UI_SPEC
        assert 'next_boot' not in spec['dialogs'] and 'tables' not in spec
        assert 'next_boot' not in [b['id'] for b in spec['buttons']['controls']]
        assert all(cell not in ('next_boot_card', 'boot_entries') for row in spec['layout'] for cell in row)
