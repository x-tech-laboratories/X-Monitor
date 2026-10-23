"""Pending package updates and how many of them are security fixes, read
from the package manager's existing cache so the check never refreshes
metadata or needs root: `apt list --upgradable` (security by a `-security`
origin), `dnf --cacheonly check-update` plus `updateinfo list --security`, or
pacman's `checkupdates` (falling back to `pacman -Qu`) with `arch-audit` for
security when it is installed. The manager is auto-detected unless `manager`
names one. Each count ranks against its own optional warning/threshold, and a
security update is warning by default; a host with none of the managers, such
as NixOS (see nixos_upgrade), or a cache that cannot be read is unavailable.
Config: manager, warning, threshold, security_warning, security_threshold."""

import re
import shlex
from typing import Any, Dict, List, Optional

from x_monitor.plugins.base.signal_plugin import SignalPlugin
from x_monitor.core.connectors.types import CmdResult, CollectResult, Command, Status
from x_monitor.core.settings.config_schema import PluginConfig
from x_monitor.plugins.base.plugin_helpers import SCRIPT_SEP, parse_duration

MANAGERS = ('apt', 'dnf', 'pacman')

# How many security package names one log line lists before summarising the rest.
_LOGGED_NAMES = 10

# `name/suite1,suite2 newver arch [upgradable from: oldver]` from apt list.
_APT_LIST_RE = re.compile(r'^(\S+?)/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?')

# `Inst name [oldver] (newver origin [arch])` from apt-get -s.
_APT_INST_RE = re.compile(r'^Inst\s+(\S+)\s+(?:\[([^\]]+)\]\s+)?\((\S+)\s+([^\[)]*)')

# `name oldver -> newver` from checkupdates and pacman -Qu.
_PACMAN_RE = re.compile(r'^(\S+)\s+(\S+)\s+->\s+(\S+)')

# A dnf package NEVRA such as `curl-8.6.0-8.fc40.x86_64`.
_NEVRA_RE = re.compile(r'^(.+)-([^-]+)-([^-]+)\.([^.\s]+)$')


def _probe_script(manager: Optional[str]) -> str:
    """One script that finds the package manager and reads its pending updates without touching the cache."""
    forced = shlex.quote(manager) if manager else "''"
    return '\n'.join([
        f'm={forced}',
        'if [ -z "$m" ]; then',
        '  if command -v apt-get >/dev/null 2>&1; then m=apt',
        '  elif command -v dnf >/dev/null 2>&1; then m=dnf',
        '  elif command -v pacman >/dev/null 2>&1; then m=pacman',
        '  fi',
        'fi',
        "upd=''; sec=''; cur=''; rc=''; src=''",
        'case "$m" in',
        '  apt)',
        '    if command -v apt >/dev/null 2>&1; then',
        "      src='apt list --upgradable'; upd=$(LC_ALL=C apt list --upgradable 2>/dev/null); rc=$?",
        '    else',
        "      src='apt-get -s dist-upgrade'; upd=$(LC_ALL=C apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>&1); rc=$?",
        '    fi ;;',
        '  dnf)',
        "    src='dnf check-update'; upd=$(dnf -q --cacheonly check-update 2>&1); rc=$?",
        '    sec=$(dnf -q --cacheonly updateinfo list --security 2>/dev/null)',
        "    cur=$(printf '%s\\n' \"$upd\" | awk '(NF==3 || NF==1) && $1 ~ /\\./ {print $1}' "
        "| xargs -r rpm -q --qf '%{NAME}.%{ARCH} %{VERSION}-%{RELEASE}\\n' 2>/dev/null) ;;",
        '  pacman)',
        '    if command -v checkupdates >/dev/null 2>&1; then',
        "      src='checkupdates'; upd=$(checkupdates 2>&1); rc=$?",
        '    fi',
        '    if [ -z "$src" ] || [ "$rc" = 1 ]; then',
        "      src='pacman -Qu'; upd=$(pacman -Qu 2>&1); rc=$?",
        '    fi',
        '    if command -v arch-audit >/dev/null 2>&1; then sec=$(arch-audit -u -q 2>/dev/null); fi ;;',
        'esac',
        'echo "manager=$m"',
        'echo "source=$src"',
        'echo "rc=$rc"',
        'if [ -e /etc/NIXOS ]; then echo "nixos=1"; fi',
        f'echo "{SCRIPT_SEP}"',
        "printf '%s\\n' \"$upd\"",
        f'echo "{SCRIPT_SEP}"',
        "printf '%s\\n' \"$sec\"",
        f'echo "{SCRIPT_SEP}"',
        "printf '%s\\n' \"$cur\"",
    ])


def _split_output(stdout: str) -> Dict[str, Any]:
    """The header's key=value fields plus the updates, security and installed-version sections."""
    parts = stdout.split(SCRIPT_SEP)
    parts += [''] * (4 - len(parts))
    fields: Dict[str, Any] = {}
    for line in parts[0].splitlines():
        key, sep, value = line.partition('=')
        if sep:
            fields[key.strip()] = value.strip()
    fields['updates'], fields['security'], fields['installed'] = (p.strip('\n') for p in parts[1:4])
    return fields


def _package(name: str, current: str, new: str, security: bool, origin: str = '') -> Dict[str, Any]:
    return {'name': name, 'current': current, 'new': new, 'security': security, 'origin': origin}


def parse_apt(text: str) -> List[Dict[str, Any]]:
    """Packages from `apt list --upgradable` or `apt-get -s` Inst lines, security meaning a -security origin."""
    packages = []
    for line in text.splitlines():
        m = _APT_LIST_RE.match(line)
        if m:
            name, suites, new, current = m.groups()
            packages.append(_package(name, (current or '').strip(), new,
                                     'security' in suites.lower(), suites))
            continue
        m = _APT_INST_RE.match(line)
        if m:
            name, current, new, origin = m.groups()
            origin = origin.strip()
            packages.append(_package(name, current or '', new,
                                     'security' in origin.lower(), origin))
    return packages


def parse_dnf(updates: str, security: str, installed: str) -> List[Dict[str, Any]]:
    """Packages from `dnf check-update`, with current versions from rpm and security from updateinfo."""
    current: Dict[str, str] = {}
    for line in installed.splitlines():
        fields = line.split()
        if len(fields) == 2:
            current[fields[0]] = fields[1]
    secure = set()
    for line in security.splitlines():
        for token in line.split():
            m = _NEVRA_RE.match(token)
            if m:
                secure.add(f'{m.group(1)}.{m.group(4)}')
    packages = []
    wrapped: Optional[str] = None
    for line in updates.splitlines():
        # Everything after this header is an obsoleted package, already counted under its replacement.
        if line.strip().lower().startswith('obsoleting'):
            break
        fields = line.split()
        # dnf moves the version and repo of a long package name onto the next line.
        if wrapped and len(fields) == 2:
            fields, wrapped = [wrapped] + fields, None
        elif len(fields) == 1 and '.' in fields[0] and not line.startswith(' '):
            wrapped = fields[0]
            continue
        if len(fields) != 3 or '.' not in fields[0]:
            continue
        name_arch, new, repo = fields
        name = name_arch.rsplit('.', 1)[0]
        packages.append(_package(name, current.get(name_arch, ''), new,
                                 name_arch in secure, repo))
    return packages


def parse_pacman(updates: str, security: str) -> List[Dict[str, Any]]:
    """Packages from `checkupdates` or `pacman -Qu`, security meaning arch-audit lists them."""
    secure = set()
    for line in security.splitlines():
        words = line.split()
        if not words:
            continue
        # arch-audit prints either bare names or "Package <name> is affected by ...".
        token = words[1] if words[0] == 'Package' and len(words) > 1 else words[0]
        secure.add(re.split(r'[<>=:]', token, 1)[0])
    packages = []
    for line in updates.splitlines():
        m = _PACMAN_RE.match(line)
        if m:
            name, current, new = m.groups()
            packages.append(_package(name, current, new, name in secure, 'ignored' if '[ignored]' in line else ''))
    return packages


def _read_error(manager: str, rc: str, text: str) -> Optional[str]:
    """Why the manager's cache could not be read, or None when its exit code means success."""
    ok = {'apt': {'0'}, 'dnf': {'0', '100'}, 'pacman': {'0', '1', '2'}}[manager]
    if rc in ok:
        return None
    detail = ' '.join(text.split())[:200]
    return f"{manager} could not read its package cache (exit {rc or '?'}): {detail or 'no output'}"


def _optional_level(value: float, warning: Optional[float], threshold: Optional[float]) -> str:
    """Rank a count against whichever of its two bounds are configured."""
    if threshold is not None and value >= threshold:
        return 'failed'
    if warning is not None and value >= warning:
        return 'warning'
    return 'online'


def _bound(config: PluginConfig, key: str, default: Optional[float] = None) -> Optional[float]:
    value = config.get(key, default)
    return None if value is None else float(value)


class PackageUpdates(SignalPlugin):
    """Pending apt, dnf or pacman updates, normalised into one package list
    with a security flag, counted and ranked against the configured bounds."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        # Reading a package cache every minute buys nothing, so this monitor defaults to hourly.
        self.interval = parse_duration(config.get('interval', '1h'))
        manager = str(config.get('manager') or '').lower()
        self.manager = manager if manager in MANAGERS else None
        self.warning = _bound(config, 'warning')
        self.threshold = _bound(config, 'threshold')
        self.security_warning = _bound(config, 'security_warning', 1)
        self.security_threshold = _bound(config, 'security_threshold')

    def commands(self) -> List[Command]:
        return [Command(_probe_script(self.manager))]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if SCRIPT_SEP not in stdout:
            return CollectResult.unavailable(
                f"Could not check for package updates: {(stderr or stdout).strip()[:200]}")

        fields = _split_output(stdout)
        manager = fields.get('manager', '')
        if manager not in MANAGERS:
            if fields.get('nixos'):
                return CollectResult.unavailable(
                    "NixOS has no apt, dnf or pacman; use the nixos_upgrade monitor for this host")
            return CollectResult.unavailable("No supported package manager (apt, dnf or pacman) found")

        error = _read_error(manager, fields.get('rc', ''), fields['updates'])
        if error:
            return CollectResult.unavailable(error)

        if manager == 'apt':
            packages = parse_apt(fields['updates'])
        elif manager == 'dnf':
            packages = parse_dnf(fields['updates'], fields['security'], fields['installed'])
        else:
            packages = parse_pacman(fields['updates'], fields['security'])

        return self._assemble(manager, fields.get('source', ''), packages)

    def _assemble(self, manager: str, source: str, packages: List[Dict[str, Any]]) -> CollectResult:
        packages.sort(key=lambda p: (not p['security'], p['name']))
        secure = [p['name'] for p in packages if p['security']]
        pending, security = len(packages), len(secure)
        status = Status.worst([
            _optional_level(pending, self.warning, self.threshold),
            _optional_level(security, self.security_warning, self.security_threshold),
        ])
        message = f"{pending} update(s) pending, {security} security ({source or manager})"
        if secure:
            shown = ', '.join(secure[:_LOGGED_NAMES])
            more = len(secure) - _LOGGED_NAMES
            message += f": {shown}" + (f" and {more} more" if more > 0 else '')
        return CollectResult(
            metrics={'updates_pending': float(pending), 'security_updates_pending': float(security)},
            logs=[(message, Status(status).log_level)],
            status=status,
            snapshot={'manager': manager, 'source': source, 'packages': packages},
        )

    def _snapshot(self) -> Dict[str, Any]:
        snapshot = self.data.latest_snapshot(default={}) if self.data else {}
        return snapshot if isinstance(snapshot, dict) else {}

    @property
    def _manager_text(self) -> str:
        return self._snapshot().get('manager') or self.manager or 'Detecting...'

    @property
    def _package_rows(self) -> List[Dict[str, Any]]:
        return [{
            'id': f"{i}-{p.get('name', '')}",
            'name': p.get('name', ''),
            'current': p.get('current', '') or '--',
            'new': p.get('new', ''),
            'security': 'yes' if p.get('security') else '',
            'origin': p.get('origin', ''),
        } for i, p in enumerate(self._snapshot().get('packages') or [])]

    def _updates_color(self, value: Optional[float]) -> Optional[str]:
        return None if value is None else _optional_level(value, self.warning, self.threshold)

    def _security_color(self, value: Optional[float]) -> Optional[str]:
        if value is None:
            return None
        return _optional_level(value, self.security_warning, self.security_threshold)

    def _security_cell(self, row: Dict[str, Any]) -> Optional[str]:
        """Color a security row with the status a single security update earns, if any."""
        if not row.get('security'):
            return None
        level = _optional_level(1, self.security_warning, self.security_threshold)
        return None if level == 'online' else level

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'manager_card': {'title': 'PACKAGE MANAGER', 'value_attr': '_manager_text',
                             'refresh': True},
            'updates_card': {'metric': 'updates_pending', 'title': 'UPDATES',
                             'format': 'int', 'color': self._updates_color},
            'security_card': {'metric': 'security_updates_pending', 'title': 'SECURITY',
                              'format': 'int', 'color': self._security_color},
        }

    def tables(self) -> Dict[str, Dict[str, Any]]:
        return {
            'packages': {
                'row_key': 'id',
                'rows_attr': '_package_rows',
                'columns': [
                    {'name': 'name', 'label': 'Package', 'field': 'name', 'sortable': True, 'align': 'left'},
                    {'name': 'current', 'label': 'Installed', 'field': 'current', 'align': 'left'},
                    {'name': 'new', 'label': 'Available', 'field': 'new', 'align': 'left'},
                    {'name': 'security', 'label': 'Security', 'field': 'security', 'sortable': True,
                     'align': 'left', 'cell_color_by': self._security_cell},
                    {'name': 'origin', 'label': 'Origin', 'field': 'origin', 'align': 'left'},
                ],
            },
        }

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {
            'updates_chart': {'metric': 'updates_pending', 'title': 'PENDING UPDATES'},
            'security_chart': {'metric': 'security_updates_pending', 'title': 'PENDING SECURITY UPDATES'},
        }
