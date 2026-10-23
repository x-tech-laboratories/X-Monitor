"""A host's power and boot controls: its power profile, its boot entries with
the default and one-shot next-boot entry, and whether it can suspend, with
actions to reboot, shut down, suspend, change the power profile, pick the next
boot entry and blink a locate LED or beep. Config: allow (the actions to offer;
every one is off unless listed), privilege (sudo, the default, or none),
identify_method (ledctl or beep) and identify_device. A control surface rather
than a health check: it is online whenever the host answers, and a host
lacking one of the tools just shows that control as unavailable."""

import json
import re
import shlex
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.ssh_connector import CONNECT_FAILED
from x_monitor.core.connectors.types import ActionPlan, CmdResult, Command, CollectResult

ACTIONS = ('reboot', 'shutdown', 'suspend', 'power_profile', 'next_boot', 'identify')

_LABELS = {
    'reboot': 'Reboot', 'shutdown': 'Shutdown', 'suspend': 'Suspend',
    'power_profile': 'Power profile', 'next_boot': 'Next boot',
    'identify': 'Identify', 'identify_off': 'Identify off',
}

_SYSTEMCTL_VERBS = {'reboot': 'reboot', 'shutdown': 'poweroff', 'suspend': 'suspend'}

# Actions that take the host away, so a connection cut off after sending them means they worked.
_DISCONNECTING = {'reboot', 'shutdown', 'suspend'}

# Transport errors that mean the command never reached the host.
_NEVER_SENT = (CONNECT_FAILED, 'is not connected', 'Agent send failed')

_ONESHOT_VAR = '/sys/firmware/efi/efivars/LoaderEntryOneShot-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f'
_PLATFORM_PROFILE = '/sys/firmware/acpi/platform_profile'
_GRUB_CONFIGS = ('/boot/grub/grub.cfg', '/boot/grub2/grub.cfg')

_ENTRIES = '@@entries'
_ENV = '@@env'
_CFG = '@@cfg'

_DEFAULT_LAYOUT = [
    ['host_card', 'profile_card', 'next_boot_card', 'suspend_card'],
    ['controls'],
    ['boot_entries'],
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


def _read(priv: str, command: str) -> str:
    """Runs a read with the privilege prefix, falling back to trying it unprivileged."""
    if not priv:
        return f'{command} 2>/dev/null'
    return f'{{ {priv}{command} 2>/dev/null || {command} 2>/dev/null; }}'


def _boot_command(priv: str) -> str:
    grub_cfgs = ' '.join(_GRUB_CONFIGS)
    return (
        f'if out=$({_read(priv, "bootctl list --json=short")}) && [ -n "$out" ]; then '
        'echo loader=systemd-boot; '
        f'echo "oneshot=$(tail -c +5 {_ONESHOT_VAR} 2>/dev/null | tr -d \'\\000\')"; '
        f'echo {_ENTRIES}; printf "%s\\n" "$out"; '
        'elif e=$(command -v grub-editenv || command -v grub2-editenv); then '
        'echo loader=grub; echo "editenv=${e##*/}"; '
        f'echo {_ENV}; "$e" list 2>/dev/null; echo {_CFG}; '
        f'for f in {grub_cfgs}; do [ -e "$f" ] && {{ {_read(priv, "cat $f")}; break; }}; done; '
        'elif command -v efibootmgr >/dev/null 2>&1; then '
        f'echo loader=efi; echo {_ENTRIES}; efibootmgr 2>/dev/null; '
        'else echo loader=none; fi'
    )


def _sections(stdout: str) -> Tuple[Dict[str, str], Dict[str, List[str]]]:
    """Splits the boot command's output into its leading key=value header and its @@-marked sections."""
    header: Dict[str, str] = {}
    sections: Dict[str, List[str]] = {}
    current: Optional[List[str]] = None
    for line in stdout.splitlines():
        if line in (_ENTRIES, _ENV, _CFG):
            current = sections.setdefault(line, [])
        elif current is not None:
            current.append(line)
        elif '=' in line:
            key, _, value = line.partition('=')
            header[key.strip()] = value.strip()
    return header, sections


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


def _systemd_boot_entries(lines: List[str]) -> List[Dict[str, Any]]:
    try:
        raw = json.loads('\n'.join(lines) or '[]')
    except ValueError:
        return []
    entries = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or not item.get('id'):
            continue
        entries.append({
            'id': str(item['id']),
            'title': str(item.get('showTitle') or item.get('title') or item['id']),
            'default': bool(item.get('isDefault')),
        })
    return entries


def grub_menu_entries(cfg: str) -> List[str]:
    """The grub-reboot names of a grub.cfg's boot entries, a submenu's entries written as 'Submenu>Entry'."""
    entries: List[str] = []
    stack: List[Optional[str]] = []
    for line in cfg.splitlines():
        stripped = line.strip()
        match = re.match(r'^(menuentry|submenu)\s+([\'"])(.*?)\2', stripped)
        if match and stripped.endswith('{'):
            kind, title = match.group(1), match.group(3)
            path = [t for t in stack if t is not None] + [title]
            if kind == 'menuentry':
                entries.append('>'.join(path))
                stack.append(None)
            else:
                stack.append(title)
        elif stripped.endswith('{'):
            stack.append(None)
        elif stripped == '}' and stack:
            stack.pop()
    return entries


def _grub_entries(sections: Dict[str, List[str]]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    env = dict(line.partition('=')[::2] for line in sections.get(_ENV, []) if '=' in line)
    titles = grub_menu_entries('\n'.join(sections.get(_CFG, [])))
    saved = env.get('saved_entry', '').strip()
    if saved in titles:
        default = saved
    elif saved.isdigit() and int(saved) < len(titles):
        default = titles[int(saved)]
    else:
        default = titles[0] if titles else None
    entries = [{'id': t, 'title': t, 'default': t == default} for t in titles]
    return entries, env.get('next_entry', '').strip() or None


def _efi_entries(lines: List[str]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    header: Dict[str, str] = {}
    entries: List[Dict[str, Any]] = []
    for line in lines:
        match = re.match(r'^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$', line)
        if match:
            title = match.group(2).split('\t')[0].strip()
            entries.append({'id': match.group(1).upper(), 'title': title or match.group(1), 'default': False})
        elif ':' in line:
            key, _, value = line.partition(':')
            header[key.strip()] = value.strip()
    order = [b.strip().upper() for b in header.get('BootOrder', '').split(',') if b.strip()]
    for entry in entries:
        entry['default'] = bool(order) and entry['id'] == order[0]
    return entries, (header.get('BootNext') or '').upper() or None


def parse_boot(stdout: str) -> Dict[str, Any]:
    """The boot loader, its entries, the default and the one-shot next entry from the boot command's output."""
    header, sections = _sections(stdout)
    loader = header.get('loader', 'none')
    next_entry: Optional[str] = None
    if loader == 'systemd-boot':
        entries = _systemd_boot_entries(sections.get(_ENTRIES, []))
        next_entry = header.get('oneshot') or None
    elif loader == 'grub':
        entries, next_entry = _grub_entries(sections)
    elif loader == 'efi':
        entries, next_entry = _efi_entries(sections.get(_ENTRIES, []))
    else:
        loader, entries = 'none', []
    for entry in entries:
        entry['next'] = entry['id'] == next_entry
    default = next((e['id'] for e in entries if e['default']), None)
    boot = {'loader': loader, 'entries': entries, 'default': default, 'next': next_entry}
    if loader == 'grub':
        boot['reboot_tool'] = 'grub2-reboot' if header.get('editenv') == 'grub2-editenv' else 'grub-reboot'
    return boot


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
            Command(_boot_command(self._priv)),
            Command('cat /sys/power/state'),
        ]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        power_result, boot_result, sleep_result = results
        power = parse_power(power_result.stdout) if power_result.exit_code == 0 else parse_power('')
        boot = parse_boot(boot_result.stdout) if boot_result.exit_code == 0 else parse_boot('')
        states = sleep_result.stdout.split() if sleep_result.exit_code == 0 else []
        can_suspend = 'mem' in states or 'freeze' in states
        snapshot = {'power': power, 'boot': boot, 'sleep_states': states, 'can_suspend': can_suspend}
        summary = (
            f"power profile {power['current'] or 'n/a'} ({power['backend']}), "
            f"{len(boot['entries'])} boot entr{'y' if len(boot['entries']) == 1 else 'ies'} ({boot['loader']}), "
            f"suspend {'supported' if can_suspend else 'unsupported'}"
        )
        return CollectResult(
            metrics={
                'power_profiles': float(len(power['profiles'])),
                'boot_entries': float(len(boot['entries'])),
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
    def boot_options(self) -> Dict[str, str]:
        return {e['id']: e['title'] for e in self._state().get('boot', {}).get('entries') or []}

    @property
    def next_boot_default(self) -> Optional[str]:
        boot = self._state().get('boot', {})
        return boot.get('next') or boot.get('default')

    @property
    def can_suspend(self) -> bool:
        return bool(self._state().get('can_suspend'))

    @property
    def _profile_text(self) -> str:
        return self.current_profile or 'n/a'

    @property
    def _next_boot_text(self) -> str:
        boot = self._state().get('boot', {})
        titles = self.boot_options
        chosen = boot.get('next') or boot.get('default')
        if not chosen:
            return 'n/a'
        title = titles.get(chosen, chosen)
        return f'{title} (once)' if boot.get('next') else title

    @property
    def _suspend_text(self) -> str:
        return 'Supported' if self.can_suspend else 'Unsupported'

    @property
    def _boot_rows(self) -> List[Dict[str, str]]:
        return [
            {'id': e['id'], 'title': e['title'],
             'default': 'yes' if e.get('default') else '', 'next': 'yes' if e.get('next') else ''}
            for e in self._state().get('boot', {}).get('entries') or []
        ]

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
        if action_id == 'next_boot':
            return self._plan_next_boot(str(kwargs.get('entry') or ''), bool(kwargs.get('reboot')))
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

    def _plan_next_boot(self, entry: str, reboot: bool):
        boot = self._state().get('boot', {})
        if entry not in self.boot_options:
            return self._refuse('next_boot', f"unknown boot entry {entry!r}")
        if reboot and not self.allowed('reboot'):
            return self._refuse('next_boot', 'reboot is not in allow')
        quoted = shlex.quote(entry)
        loader = boot.get('loader')
        if loader == 'systemd-boot':
            command = f"{self._priv}bootctl set-oneshot {quoted}"
        elif loader == 'grub':
            command = f"{self._priv}{boot.get('reboot_tool', 'grub-reboot')} {quoted}"
        else:
            command = f"{self._priv}efibootmgr --bootnext {quoted}"
        if reboot:
            command += f" && {self._priv}systemctl reboot"
        return ActionPlan(command)

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
        if action_id == 'next_boot':
            title = self.boot_options.get(str(kwargs.get('entry')), kwargs.get('entry'))
            suffix = ' and reboot' if kwargs.get('reboot') else ''
            return f"{label} {title!s}{suffix} on {self.target}"
        return f"{label} on {self.target}"

    def interpret_action(self, action_id: str, result: CmdResult, **kwargs):
        what = self._describe(action_id, **kwargs)
        takes_host_down = action_id in _DISCONNECTING or (action_id == 'next_boot' and kwargs.get('reboot'))
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
        next_boot_fields = [{'name': 'entry', 'label': 'Boot entry', 'options_attr': 'boot_options',
                             'default_attr': 'next_boot_default'}]
        if self.allowed('reboot'):
            next_boot_fields.append({'name': 'reboot', 'label': 'Reboot now', 'type': 'checkbox'})
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'profile_card': {'title': 'POWER PROFILE', 'value_attr': '_profile_text', 'refresh': True},
                'next_boot_card': {'title': 'NEXT BOOT', 'value_attr': '_next_boot_text', 'refresh': True},
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
                    {'id': 'next_boot', 'label': 'Next Boot', 'icon': 'start', 'kind': 'dialog',
                     'dialog': 'next_boot',
                     'visible_if': lambda p: p.allowed('next_boot') and bool(p.boot_options)},
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
                'next_boot': {
                    'kind': 'form', 'title': f'Next boot: {host}', 'action_id': 'next_boot',
                    'submit_label': 'Set', 'fields': next_boot_fields,
                    'confirm': f'Boot {host} into {{row[entry]}} on its next boot only? '
                               'With Reboot now ticked, it reboots straight away.'
                               if self.allowed('reboot') else
                               f'Boot {host} into {{row[entry]}} on its next boot only?',
                },
            },
            'tables': {
                'boot_entries': {
                    'row_key': 'id',
                    'rows_attr': '_boot_rows',
                    'columns': [
                        {'name': 'title', 'label': 'Boot entry', 'field': 'title', 'align': 'left'},
                        {'name': 'id', 'label': 'Id', 'field': 'id', 'align': 'left'},
                        {'name': 'default', 'label': 'Default', 'field': 'default', 'align': 'left'},
                        {'name': 'next', 'label': 'Next boot', 'field': 'next', 'align': 'left'},
                    ],
                },
            },
            'events': True,
        }
