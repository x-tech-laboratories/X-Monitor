"""A host's power controls: its power profile and whether it can suspend, with
actions to reboot, shut down, suspend, change the power profile and blink a
locate LED or beep; boot entries and the next boot are X-Nix's. Config: allow
(the actions to offer; every one is off unless listed), privilege (sudo, the
default, or none), identify_method (ledctl or beep) and identify_device. A
control surface rather than a health check: it is online whenever the host
answers, and a host lacking one of the tools just shows that control as
unavailable."""

import re
import shlex
from typing import Any, Dict, List, Optional

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.ssh_connector import CONNECT_FAILED
from x_monitor.core.connectors.types import ActionPlan, CmdResult, Command, CollectResult

ACTIONS = ('reboot', 'shutdown', 'suspend', 'power_profile', 'identify')

_LABELS = {
    'reboot': 'Reboot', 'shutdown': 'Shutdown', 'suspend': 'Suspend',
    'power_profile': 'Power profile',
    'identify': 'Identify', 'identify_off': 'Identify off',
}

_SYSTEMCTL_VERBS = {'reboot': 'reboot', 'shutdown': 'poweroff', 'suspend': 'suspend'}

# Actions that take the host away, so a connection cut off after sending them means they worked.
_DISCONNECTING = {'reboot', 'shutdown', 'suspend'}

# Transport errors that mean the command never reached the host.
_NEVER_SENT = (CONNECT_FAILED, 'is not connected', 'Agent send failed')

_PLATFORM_PROFILE = '/sys/firmware/acpi/platform_profile'

_DEFAULT_LAYOUT = [
    ['host_card', 'profile_card', 'suspend_card'],
    ['controls'],
    ['events'],
]


def _power_command() -> str:
    return (
        'if out=$(powerprofilesctl list 2>/dev/null); then echo backend=ppd; printf "%s\\n" "$out"; '
        'elif out=$(tuned-adm list 2>/dev/null); then echo backend=tuned; printf "%s\\n" "$out"; '
        f'elif [ -r {_PLATFORM_PROFILE} ]; then echo backend=sysfs; '
        f'echo "current=$(cat {_PLATFORM_PROFILE})"; '
        f'echo "choices=$(cat {_PLATFORM_PROFILE}_choices 2>/dev/null)"; '
        'else echo backend=none; fi'
    )


def parse_power(stdout: str) -> Dict[str, Any]:
    """The power-profile backend, current profile and available profiles from the power command's output."""
    lines = stdout.splitlines()
    backend = lines[0].partition('=')[2].strip() if lines and lines[0].startswith('backend=') else 'none'
    body = lines[1:]
    current: Optional[str] = None
    profiles: List[str] = []
    if backend == 'ppd':
        for line in body:
            match = re.match(r'^([* ]) (\S+):\s*$', line)
            if match:
                profiles.append(match.group(2))
                if match.group(1) == '*':
                    current = match.group(2)
    elif backend == 'tuned':
        for line in body:
            if line.startswith('- '):
                profiles.append(line[2:].split()[0])
            elif line.startswith('Current active profile:'):
                current = line.partition(':')[2].strip() or None
    elif backend == 'sysfs':
        values = dict(line.partition('=')[::2] for line in body if '=' in line)
        current = values.get('current', '').strip() or None
        profiles = values.get('choices', '').split()
    else:
        backend = 'none'
    return {'backend': backend, 'current': current, 'profiles': profiles}


def _dropped(result: CmdResult) -> bool:
    """Whether the command reached the host and the connection was then cut, as a going-down host does."""
    return result.exit_code == -1 and not any(m in result.stderr for m in _NEVER_SENT)


def _sudo_refused(text: str) -> bool:
    lowered = text.lower()
    return 'sudo:' in lowered and any(s in lowered for s in (
        'password is required', 'not allowed', 'terminal is required', 'no tty', 'not in the sudoers'))


class HostControl(Plugin):
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.allow = {str(a) for a in (config.get('allow') or [])}
        self.privilege = 'none' if config.get('privilege') == 'none' else 'sudo'
        self.identify_device = config.get('identify_device')
        method = config.get('identify_method') or ('ledctl' if self.identify_device else 'beep')
        self.identify_method = method if method in ('ledctl', 'beep') else 'beep'

    @property
    def _priv(self) -> str:
        return 'sudo -n ' if self.privilege == 'sudo' else ''

    def commands(self) -> List[Command]:
        return [
            Command(_power_command()),
            Command('cat /sys/power/state'),
        ]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        power_result, sleep_result = results
        power = parse_power(power_result.stdout) if power_result.exit_code == 0 else parse_power('')
        states = sleep_result.stdout.split() if sleep_result.exit_code == 0 else []
        can_suspend = 'mem' in states or 'freeze' in states
        snapshot = {'power': power, 'sleep_states': states, 'can_suspend': can_suspend}
        summary = (
            f"power profile {power['current'] or 'n/a'} ({power['backend']}), "
            f"suspend {'supported' if can_suspend else 'unsupported'}"
        )
        return CollectResult(
            metrics={
                'power_profiles': float(len(power['profiles'])),
                'suspend_supported': 1.0 if can_suspend else 0.0,
            },
            logs=[(summary, 'INFO')],
            snapshot=snapshot,
            status='online',
        )

    # --- state read back for actions and the page ---

    def _state(self) -> Dict[str, Any]:
        snapshot = self.data.latest_snapshot() if self.data is not None else None
        return snapshot if isinstance(snapshot, dict) else {}

    @property
    def power_profiles(self) -> List[str]:
        return list(self._state().get('power', {}).get('profiles') or [])

    @property
    def current_profile(self) -> Optional[str]:
        return self._state().get('power', {}).get('current')

    @property
    def can_suspend(self) -> bool:
        return bool(self._state().get('can_suspend'))

    @property
    def _profile_text(self) -> str:
        return self.current_profile or 'n/a'

    @property
    def _suspend_text(self) -> str:
        return 'Supported' if self.can_suspend else 'Unsupported'

    # --- actions ---

    def allowed(self, action: str) -> bool:
        return action in self.allow

    def _outcome(self, message: str, success: bool, level: Optional[str] = None) -> CollectResult:
        """An action outcome logged to the events feed, leaving the monitor's status alone."""
        return CollectResult(logs=[(message, level or ('INFO' if success else 'ERROR'))],
                             metadata={'content': message}, success=success)

    def _refuse(self, action_id: str, reason: str) -> CollectResult:
        return self._outcome(f"{_LABELS.get(action_id, action_id)} on {self.target} refused: {reason}",
                             False, 'WARNING')

    def plan_action(self, action_id: str, **kwargs):
        gate = 'identify' if action_id == 'identify_off' else action_id
        if gate not in ACTIONS:
            return None
        if not self.allowed(gate):
            return self._refuse(action_id, 'not in allow')
        if action_id in _SYSTEMCTL_VERBS:
            return ActionPlan(f"{self._priv}systemctl {_SYSTEMCTL_VERBS[action_id]}")
        if action_id == 'power_profile':
            return self._plan_power_profile(str(kwargs.get('profile') or ''))
        return self._plan_identify(on=action_id == 'identify')

    def _plan_power_profile(self, profile: str):
        power = self._state().get('power', {})
        if profile not in (power.get('profiles') or []):
            return self._refuse('power_profile', f"unknown profile {profile!r}")
        quoted = shlex.quote(profile)
        backend = power.get('backend')
        if backend == 'ppd':
            return ActionPlan(f"{self._priv}powerprofilesctl set {quoted}")
        if backend == 'tuned':
            return ActionPlan(f"{self._priv}tuned-adm profile {quoted}")
        return ActionPlan(f"echo {quoted} | {self._priv}tee {_PLATFORM_PROFILE} >/dev/null")

    def _plan_identify(self, on: bool):
        if self.identify_method == 'ledctl':
            if not self.identify_device:
                return self._refuse('identify' if on else 'identify_off', 'identify_device is not set')
            state = 'locate' if on else 'locate_off'
            return ActionPlan(f"{self._priv}ledctl {state}={shlex.quote(str(self.identify_device))}")
        if not on:
            return self._refuse('identify_off', 'a beep stops by itself')
        return ActionPlan(
            f"if command -v beep >/dev/null 2>&1; then {self._priv}beep -r 5; "
            f"else printf '\\a' | {self._priv}tee /dev/console >/dev/null; fi"
        )

    def _describe(self, action_id: str, **kwargs) -> str:
        label = _LABELS.get(action_id, action_id)
        if action_id == 'power_profile':
            return f"{label} {kwargs.get('profile')!s} on {self.target}"
        return f"{label} on {self.target}"

    def interpret_action(self, action_id: str, result: CmdResult, **kwargs):
        what = self._describe(action_id, **kwargs)
        takes_host_down = action_id in _DISCONNECTING
        if result.exit_code == 0:
            return self._outcome(f"{what}: done", True)
        if takes_host_down and _dropped(result):
            return self._outcome(f"{what}: sent, and the host dropped the connection as it went down", True)
        detail = (result.stderr or result.stdout).strip()
        if _sudo_refused(detail):
            first = detail.splitlines()[0]
            return self._outcome(
                f"{what} failed: sudo refused ({first}); allow this command for the X-Monitor user "
                f"without a password, or set privilege: none", False)
        return self._outcome(f"{what} failed: {detail or f'exit code {result.exit_code}'}", False)

    @property
    def UI_SPEC(self):
        host = '{plugin.target}'
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'profile_card': {'title': 'POWER PROFILE', 'value_attr': '_profile_text', 'refresh': True},
                'suspend_card': {'title': 'SUSPEND', 'value_attr': '_suspend_text', 'refresh': True},
            },
            'buttons': {
                'controls': [
                    {'id': 'reboot', 'label': 'Reboot', 'icon': 'restart_alt', 'color': 'negative',
                     'visible_if': lambda p: p.allowed('reboot'),
                     'confirm': f'Reboot {host} now? Everything running on it stops.'},
                    {'id': 'shutdown', 'label': 'Shut Down', 'icon': 'power_settings_new', 'color': 'negative',
                     'visible_if': lambda p: p.allowed('shutdown'),
                     'confirm': f'Shut down {host} now? It stays off until someone powers it on.'},
                    {'id': 'suspend', 'label': 'Suspend', 'icon': 'bedtime',
                     'visible_if': lambda p: p.allowed('suspend') and p.can_suspend,
                     'confirm': f'Suspend {host} now? It stays asleep until woken.'},
                    {'id': 'power_profile', 'label': 'Power Profile', 'icon': 'speed', 'kind': 'dialog',
                     'dialog': 'power_profile',
                     'visible_if': lambda p: p.allowed('power_profile') and bool(p.power_profiles)},
                    {'id': 'identify', 'label': 'Identify', 'icon': 'emergency',
                     'visible_if': lambda p: p.allowed('identify'),
                     'confirm': f'Blink or beep {host} so you can find it?'},
                    {'id': 'identify_off', 'label': 'Stop Identify', 'icon': 'block',
                     'visible_if': lambda p: p.allowed('identify') and p.identify_method == 'ledctl',
                     'confirm': f'Stop the locate LED on {host}?'},
                ],
            },
            'dialogs': {
                'power_profile': {
                    'kind': 'form', 'title': f'Power profile: {host}', 'action_id': 'power_profile',
                    'submit_label': 'Set',
                    'fields': [{'name': 'profile', 'label': 'Profile', 'options_attr': 'power_profiles',
                                'default_attr': 'current_profile'}],
                    'confirm': f'Switch {host} to the {{row[profile]}} power profile?',
                },
            },
            'events': True,
        }
