import json
import os
import subprocess

import pytest

from vigil.core.connectors.types import ActionPlan, CmdResult, CollectResult
from vigil.plugins.host_control import (
    HostControl, grub_menu_entries, parse_boot, parse_power,
)


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

_BOOTCTL = json.dumps([
    {"type": "type1", "id": "nixos-generation-101.conf", "title": "NixOS",
     "showTitle": "NixOS (Generation 101)", "isDefault": True, "isSelected": True},
    {"type": "type1", "id": "nixos-generation-100.conf", "title": "NixOS",
     "showTitle": "NixOS (Generation 100)", "isDefault": False},
    {"type": "loader", "id": "auto-reboot-to-firmware-setup", "title": "Reboot Into Firmware Interface"},
])

_GRUB_CFG = """set default="${saved_entry}"
function load_video {
  insmod all_video
}
menuentry 'Ubuntu' --class ubuntu $menuentry_id_option 'gnulinux-simple' {
	recordfail
	linux /vmlinuz root=UUID=x ro
}
submenu 'Advanced options for Ubuntu' $menuentry_id_option 'gnulinux-advanced' {
	menuentry 'Ubuntu, with Linux 6.8.0' --class ubuntu {
		linux /vmlinuz-6.8.0
	}
	menuentry "Ubuntu, with Linux 6.8.0 (recovery mode)" {
		linux /vmlinuz-6.8.0 single
	}
}
menuentry 'Windows Boot Manager (on /dev/sda1)' --class windows {
	chainloader /EFI/Microsoft/Boot/bootmgfw.efi
}
"""

_EFIBOOTMGR = """BootCurrent: 0001
Timeout: 1 seconds
BootNext: 0003
BootOrder: 0001,0003,0000
Boot0000* EFI PXE 0 for IPv4\tPciRoot(0x0)/Pci(0x1c,0x0)
Boot0001* Linux Boot Manager\tHD(1,GPT,x)/File(\\EFI\\systemd\\systemd-bootx64.efi)
Boot0003* Windows Boot Manager\tHD(1,GPT,x)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)
"""


def _cfg(**extra):
    base = {"name": "host1 control", "id": "host1-control", "ssh_config": {"host": "host1"}}
    base.update(extra)
    return base


def _systemd_boot_output(oneshot=""):
    return f"loader=systemd-boot\noneshot={oneshot}\n@@entries\n{_BOOTCTL}\n"


def _results(power=f"backend=ppd\n{_PPD}", boot=None, sleep="freeze mem disk"):
    return [CmdResult(0, power, ""), CmdResult(0, boot or _systemd_boot_output(), ""),
            CmdResult(0, sleep, "")]


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


class TestParseBoot:
    def test_systemd_boot_default_and_oneshot(self):
        boot = parse_boot(_systemd_boot_output(oneshot="nixos-generation-100.conf"))
        assert boot['loader'] == 'systemd-boot'
        assert boot['default'] == 'nixos-generation-101.conf'
        assert boot['next'] == 'nixos-generation-100.conf'
        titles = {e['id']: e['title'] for e in boot['entries']}
        assert titles['nixos-generation-100.conf'] == 'NixOS (Generation 100)'
        assert [e['id'] for e in boot['entries'] if e['next']] == ['nixos-generation-100.conf']

    def test_systemd_boot_without_oneshot(self):
        boot = parse_boot(_systemd_boot_output())
        assert boot['next'] is None
        assert not any(e['next'] for e in boot['entries'])

    def test_unreadable_bootctl_json_gives_no_entries(self):
        boot = parse_boot("loader=systemd-boot\noneshot=\n@@entries\nnot json\n")
        assert boot['entries'] == [] and boot['default'] is None

    def test_grub_menu_entries_follow_submenus(self):
        assert grub_menu_entries(_GRUB_CFG) == [
            'Ubuntu',
            'Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0',
            'Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0 (recovery mode)',
            'Windows Boot Manager (on /dev/sda1)',
        ]

    def test_grub_saved_and_next_entry(self):
        out = ("loader=grub\neditenv=grub-editenv\n@@env\n# GRUB Environment Block\n"
               "saved_entry=Windows Boot Manager (on /dev/sda1)\nnext_entry=Ubuntu\n"
               f"@@cfg\n{_GRUB_CFG}")
        boot = parse_boot(out)
        assert boot['loader'] == 'grub'
        assert boot['default'] == 'Windows Boot Manager (on /dev/sda1)'
        assert boot['next'] == 'Ubuntu'
        assert boot['reboot_tool'] == 'grub-reboot'

    def test_grub_numeric_saved_entry_and_grub2_tools(self):
        out = f"loader=grub\neditenv=grub2-editenv\n@@env\nsaved_entry=3\n@@cfg\n{_GRUB_CFG}"
        boot = parse_boot(out)
        assert boot['default'] == 'Windows Boot Manager (on /dev/sda1)'
        assert boot['next'] is None
        assert boot['reboot_tool'] == 'grub2-reboot'

    def test_grub_without_saved_entry_defaults_to_the_first(self):
        boot = parse_boot(f"loader=grub\neditenv=grub-editenv\n@@env\n@@cfg\n{_GRUB_CFG}")
        assert boot['default'] == 'Ubuntu'

    def test_efibootmgr(self):
        boot = parse_boot(f"loader=efi\n@@entries\n{_EFIBOOTMGR}")
        assert [(e['id'], e['title']) for e in boot['entries']] == [
            ('0000', 'EFI PXE 0 for IPv4'), ('0001', 'Linux Boot Manager'), ('0003', 'Windows Boot Manager')]
        assert boot['default'] == '0001'
        assert boot['next'] == '0003'

    def test_no_loader(self):
        assert parse_boot("loader=none") == {'loader': 'none', 'entries': [], 'default': None, 'next': None}


class TestCollection:
    async def test_everything_collected_is_online(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        result = plugin.parse(_results())
        assert result.status == 'online'
        assert result.metrics == {'power_profiles': 3.0, 'boot_entries': 3.0, 'suspend_supported': 1.0}
        assert result.snapshot['power']['current'] == 'balanced'
        assert result.snapshot['can_suspend'] is True

    async def test_missing_tools_are_still_online(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        result = plugin.parse([CmdResult(0, "backend=none", ""), CmdResult(0, "loader=none", ""),
                               CmdResult(1, "", "No such file")])
        assert result.status == 'online'
        assert result.metrics == {'power_profiles': 0.0, 'boot_entries': 0.0, 'suspend_supported': 0.0}
        assert not any(level in ('WARNING', 'ERROR') for _, level in result.logs)

    async def test_commands_are_valid_shell(self, make_plugin):
        for privilege in ('sudo', 'none'):
            plugin = make_plugin(HostControl, _cfg(privilege=privilege))
            for command in plugin.commands():
                subprocess.run(['sh', '-n', '-c', command.text], check=True)

    async def test_boot_reads_try_sudo_then_fall_back(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        boot = plugin.commands()[1].text
        assert 'sudo -n bootctl list --json=short 2>/dev/null || bootctl list --json=short' in boot
        none = make_plugin(HostControl, _cfg(privilege='none')).commands()[1].text
        assert 'sudo' not in none

    async def test_power_and_boot_commands_run_against_fake_tools(self, make_plugin, tmp_path):
        bin_dir = tmp_path / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'powerprofilesctl').write_text(f"#!/bin/sh\ncat <<'EOF'\n{_PPD}EOF\n")
        (bin_dir / 'bootctl').write_text(f"#!/bin/sh\necho '{_BOOTCTL}'\n")
        for tool in bin_dir.iterdir():
            tool.chmod(0o755)
        env = {**os.environ, 'PATH': f"{bin_dir}:{os.environ['PATH']}"}
        plugin = make_plugin(HostControl, _cfg(privilege='none'))
        power_cmd, boot_cmd, _ = plugin.commands()
        power = subprocess.run(['sh', '-c', power_cmd.text], env=env, capture_output=True, text=True)
        boot = subprocess.run(['sh', '-c', boot_cmd.text], env=env, capture_output=True, text=True)
        assert parse_power(power.stdout)['current'] == 'balanced'
        parsed = parse_boot(boot.stdout)
        assert parsed['loader'] == 'systemd-boot'
        assert parsed['default'] == 'nixos-generation-101.conf'


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
        assert 'refused: not in allow' in plugin.plan_action(
            'next_boot', entry='nixos-generation-100.conf').logs[0][0]

    async def test_unknown_action_is_unhandled(self, make_plugin):
        assert _collected(make_plugin, allow=list(ACTIONS_ALL)).plan_action('format_disk') is None

    async def test_refusal_is_logged_to_events(self, make_plugin, db_manager):
        plugin = _collected(make_plugin)
        plugin.storage.apply(plugin.plan_action('reboot'))
        events = db_manager.plugin_events(plugin_id='host1-control', limit=1)
        assert 'Reboot on host1 refused: not in allow' in events[0]['message']


ACTIONS_ALL = ['reboot', 'shutdown', 'suspend', 'power_profile', 'next_boot', 'identify']


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


class TestNextBoot:
    async def test_systemd_boot_oneshot(self, make_plugin):
        plan = _collected(make_plugin, allow=['next_boot']).plan_action(
            'next_boot', entry='nixos-generation-100.conf')
        assert plan == ActionPlan("sudo -n bootctl set-oneshot nixos-generation-100.conf")

    async def test_grub_reboot_quotes_the_title(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg(allow=['next_boot']))
        boot = f"loader=grub\neditenv=grub2-editenv\n@@env\n@@cfg\n{_GRUB_CFG}"
        plugin.storage.apply(plugin.parse(_results(boot=boot)))
        plan = plugin.plan_action('next_boot', entry='Windows Boot Manager (on /dev/sda1)')
        assert plan == ActionPlan("sudo -n grub2-reboot 'Windows Boot Manager (on /dev/sda1)'")

    async def test_efibootmgr_bootnext(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg(allow=['next_boot']))
        plugin.storage.apply(plugin.parse(_results(boot=f"loader=efi\n@@entries\n{_EFIBOOTMGR}")))
        assert plugin.plan_action('next_boot', entry='0003') == ActionPlan("sudo -n efibootmgr --bootnext 0003")

    async def test_and_reboot_now(self, make_plugin):
        plan = _collected(make_plugin, allow=['next_boot', 'reboot']).plan_action(
            'next_boot', entry='nixos-generation-100.conf', reboot=True)
        assert plan == ActionPlan(
            "sudo -n bootctl set-oneshot nixos-generation-100.conf && sudo -n systemctl reboot")

    async def test_reboot_now_needs_reboot_allowed(self, make_plugin):
        plan = _collected(make_plugin, allow=['next_boot']).plan_action(
            'next_boot', entry='nixos-generation-100.conf', reboot=True)
        assert isinstance(plan, CollectResult)
        assert 'reboot is not in allow' in plan.logs[0][0]

    async def test_unknown_entry_is_refused(self, make_plugin):
        plan = _collected(make_plugin, allow=['next_boot']).plan_action('next_boot', entry='other')
        assert 'unknown boot entry' in plan.logs[0][0]

    async def test_before_any_collection_there_is_nothing_to_pick(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg(allow=['next_boot']))
        assert isinstance(plugin.plan_action('next_boot', entry='nixos-generation-100.conf'), CollectResult)

    async def test_dropped_connection_with_reboot_is_success(self, make_plugin):
        plugin = _collected(make_plugin, allow=['next_boot', 'reboot'])
        outcome = plugin.interpret_action('next_boot', CmdResult(-1, "", "Connection lost"),
                                          entry='nixos-generation-100.conf', reboot=True)
        assert outcome.success is True
        assert 'NixOS (Generation 100) and reboot on host1' in outcome.logs[0][0]


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
        plugin.storage.apply(plugin.parse(_results(boot=_systemd_boot_output("nixos-generation-100.conf"))))
        assert plugin._profile_text == 'balanced'
        assert plugin._next_boot_text == 'NixOS (Generation 100) (once)'
        assert plugin._suspend_text == 'Supported'
        assert plugin.next_boot_default == 'nixos-generation-100.conf'
        assert plugin.power_profiles == ['performance', 'balanced', 'power-saver']
        rows = plugin._boot_rows
        assert rows[0] == {'id': 'nixos-generation-101.conf', 'title': 'NixOS (Generation 101)',
                           'default': 'yes', 'next': ''}

    async def test_before_collection(self, make_plugin):
        plugin = make_plugin(HostControl, _cfg())
        assert plugin._profile_text == 'n/a' and plugin._next_boot_text == 'n/a'
        assert plugin.boot_options == {}

    async def test_buttons_follow_allow(self, make_plugin):
        plugin = _collected(make_plugin, allow=['reboot', 'power_profile'])
        buttons = plugin.UI_SPEC['buttons']['controls']
        visible = [b['id'] for b in buttons if b['visible_if'](plugin)]
        assert visible == ['reboot', 'power_profile']

    async def test_every_direct_button_confirms_with_the_host(self, make_plugin):
        from vigil.core.ui.components import _substitute
        plugin = _collected(make_plugin, allow=ACTIONS_ALL, identify_device='/dev/sda')
        spec = plugin.UI_SPEC
        for button in spec['buttons']['controls']:
            template = button.get('confirm') or spec['dialogs'][button['dialog']]['confirm']
            text = _substitute(template, {'profile': 'balanced', 'entry': 'x'}, plugin)
            assert 'host1' in text

    async def test_reboot_now_checkbox_only_when_reboot_is_allowed(self, make_plugin):
        without = _collected(make_plugin, allow=['next_boot']).UI_SPEC['dialogs']['next_boot']['fields']
        assert [f['name'] for f in without] == ['entry']
        with_reboot = _collected(make_plugin, allow=['next_boot', 'reboot']).UI_SPEC['dialogs']['next_boot']['fields']
        assert [f['name'] for f in with_reboot] == ['entry', 'reboot']
