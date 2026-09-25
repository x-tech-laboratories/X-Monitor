"""Logged-in users and active sessions, from `loginctl` (falling back to
`who -u --ips` where logind is not running), plus the most recent logins from
`last`. Each session shows its user, tty/seat, remote host, type, login time
and idle time. A session whose user is not in allowed_users, or whose remote
host is not in allowed_sources (CIDRs, hostnames or globs), is
violation_status (warning by default) while it lasts and logs one event when
first seen. Display-manager and per-user manager sessions are not counted.
Config: allowed_users, allowed_sources, violation_status, recent_logins."""

import ipaddress
import re
import time
from fnmatch import fnmatch
from typing import Any, Dict, List, Optional, Set

from vigil.plugins.base.signal_plugin import SignalPlugin
from vigil.core.connectors.types import CmdResult, CollectResult, Command, Status
from vigil.core.settings.config_schema import PluginConfig
from vigil.plugins.base.plugin_helpers import SCRIPT_SEP, StatusAccumulator, format_duration

_SEVERITIES = ('online', 'warning', 'failed')

# logind session classes that are not a person logging in: the per-user service manager and the login screen.
_IGNORED_CLASSES = {'manager', 'manager-early', 'greeter', 'lock-screen'}

# Properties read from `loginctl show-session` for each session.
_PROPERTIES = ('Id', 'Name', 'Remote', 'RemoteHost', 'RemoteUser', 'Type', 'Class', 'TTY',
               'Seat', 'Service', 'State', 'Timestamp', 'IdleHint', 'IdleSinceHint')

# What `last` prints for the remote host of a local login when asked for numeric addresses.
_LOCAL_HOSTS = {'', '0.0.0.0', '::', '-'}

_ISO_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}')
_WHO_IDLE_RE = re.compile(r'^(\.|\?|old|\d+:\d+)$')
# What who's idle column means when it is not an hours:minutes duration.
_WHO_IDLE_TEXT = {'': 'active', '.': 'active', '?': '--', 'old': 'over 1 day'}
_WHO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_WEEKDAY_RE = re.compile(r'^[A-Z][a-z]{2} ')


def _probe_script(recent: int) -> str:
    """One script listing sessions through loginctl or who, then the recent logins from last."""
    properties = ' '.join(f'-p {p}' for p in _PROPERTIES)
    lines = [
        'if command -v loginctl >/dev/null 2>&1 && list=$(loginctl list-sessions --no-legend --no-pager 2>/dev/null); then',
        '  echo "source=loginctl"',
        f'  echo "{SCRIPT_SEP}"',
        "  ids=$(printf '%s\\n' \"$list\" | awk 'NF {print $1}')",
        f'  if [ -n "$ids" ]; then loginctl show-session --no-pager $ids {properties} 2>/dev/null; fi',
        'else',
        '  echo "source=who"',
        f'  echo "{SCRIPT_SEP}"',
        '  who -u --ips 2>/dev/null || who -u 2>/dev/null',
        'fi',
        f'echo "{SCRIPT_SEP}"',
    ]
    if recent > 0:
        # Reboot records count towards -n, so ask for twice as many and keep the logins.
        lines.append(f'last -i -w -n {int(recent) * 2} --time-format iso 2>/dev/null')
    return '\n'.join(lines)


def _is_local(host: str) -> bool:
    """Whether a remote-host field actually means a local login (none, an X display, or an unspecified address)."""
    return host in _LOCAL_HOSTS or host.startswith(':')


def _session(**fields: Any) -> Dict[str, Any]:
    base = {'id': '', 'user': '', 'tty': '', 'seat': '', 'host': '', 'type': '', 'class': '',
            'service': '', 'state': '', 'since': '', 'idle': False, 'idle_since': None,
            'idle_text': '', 'remote': False}
    base.update(fields)
    return base


def _loginctl_blocks(text: str) -> List[Dict[str, str]]:
    """Split `loginctl show-session` output into one property dict per session."""
    blocks: List[Dict[str, str]] = []
    current: Dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition('=')
        if not sep:
            if current:
                blocks.append(current)
                current = {}
            continue
        if key in current:
            blocks.append(current)
            current = {}
        current[key] = value.strip()
    if current:
        blocks.append(current)
    return blocks


def parse_loginctl(text: str) -> List[Dict[str, Any]]:
    """Sessions from `loginctl show-session`, leaving out manager and login-screen sessions."""
    sessions = []
    for block in _loginctl_blocks(text):
        if not block.get('Id') or block.get('Class', '') in _IGNORED_CLASSES:
            continue
        host = block.get('RemoteHost', '')
        idle_since = int(block.get('IdleSinceHint') or 0) // 1_000_000
        session = _session(
            id=block['Id'],
            user=block.get('Name', ''),
            tty=block.get('TTY', ''),
            seat=block.get('Seat', ''),
            host='' if _is_local(host) else host,
            type=block.get('Type', ''),
            service=block.get('Service', ''),
            state=block.get('State', ''),
            since=_WEEKDAY_RE.sub('', block.get('Timestamp', '')),
            idle=block.get('IdleHint') == 'yes',
            idle_since=idle_since or None,
            remote=block.get('Remote') == 'yes' or not _is_local(host),
        )
        session['class'] = block.get('Class', '')
        sessions.append(session)
    return sessions


def parse_who(text: str) -> List[Dict[str, Any]]:
    """Sessions from `who -u [--ips]`: user, tty, date, time, idle, pid, then the remote host if any."""
    sessions = []
    for line in text.splitlines():
        tokens = line.split()
        if len(tokens) < 4 or not _WHO_DATE_RE.match(tokens[2]):
            continue
        user, tty, since = tokens[0], tokens[1], f'{tokens[2]} {tokens[3]}'
        rest = tokens[4:]
        idle = ''
        if rest and _WHO_IDLE_RE.match(rest[0]):
            idle = rest.pop(0)
        if rest and rest[0].isdigit():
            rest.pop(0)
        host = ' '.join(rest).strip('()')
        local = _is_local(host)
        sessions.append(_session(
            id=f'{user}@{tty}@{since}', user=user, tty=tty, host='' if local else host,
            type='tty', since=since, idle=idle not in ('', '.', '?'),
            idle_text=_WHO_IDLE_TEXT.get(idle, idle),
            remote=not local,
        ))
    return sessions


def parse_last(text: str) -> List[Dict[str, str]]:
    """Recent logins from `last --time-format iso`, leaving out reboot records and the wtmp footer."""
    logins = []
    for line in text.splitlines():
        tokens = line.split()
        if not tokens or tokens[0] in ('reboot', 'shutdown', 'wtmp', 'btmp', 'wtmpdb'):
            continue
        at = next((i for i, token in enumerate(tokens) if _ISO_RE.match(token)), None)
        if at is None or at < 2:
            continue
        host = ' '.join(tokens[2:at])
        rest = tokens[at + 1:]
        duration = next((t.strip('()') for t in rest if t.startswith('(')), '')
        rest = [t for t in rest if not t.startswith('(')]
        if rest and rest[0] == '-':
            rest = rest[1:]
        until = ' '.join(rest)
        logins.append({'user': tokens[0], 'tty': tokens[1], 'host': '' if _is_local(host) else host,
                       'login': tokens[at], 'until': until, 'duration': duration})
    return logins


def _source_allowed(host: str, patterns: List[str]) -> bool:
    """Whether a remote host matches one of the allowed CIDRs, hostnames or globs."""
    try:
        address = ipaddress.ip_address(host.split('%', 1)[0])
    except ValueError:
        address = None
    for pattern in patterns:
        if address is not None and '/' in pattern:
            try:
                if address in ipaddress.ip_network(pattern, strict=False):
                    return True
            except ValueError:
                pass
            continue
        if fnmatch(host.lower(), pattern.lower()):
            return True
    return False


def _where(session: Dict[str, Any]) -> str:
    place = session.get('tty') or session.get('seat') or '?'
    host = session.get('host')
    return f"{session['user']} on {place}" + (f" from {host}" if host else '')


class Sessions(SignalPlugin):
    """Who is logged in, from where and since when, with an allowlist of
    users and remote sources and a list of recent logins."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.allowed_users: List[str] = [str(u) for u in config.get('allowed_users') or []]
        self.allowed_sources: List[str] = [str(s) for s in config.get('allowed_sources') or []]
        status = str(config.get('violation_status', 'warning')).lower()
        self.violation_status = status if status in _SEVERITIES else 'warning'
        self.recent_logins = int(config.get('recent_logins', 10))
        # Sessions already reported, so each new one logs once; None until the first cycle sets the baseline.
        self._seen: Optional[Set[str]] = None

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command(_probe_script(self.recent_logins))]

    def _violation(self, session: Dict[str, Any]) -> Optional[str]:
        """Why a session is outside the allowlists, or None when it is allowed."""
        user = session['user']
        if self.allowed_users and not any(fnmatch(user, pattern) for pattern in self.allowed_users):
            return f"user {user} is not in allowed_users"
        host = session['host']
        if host and self.allowed_sources and not _source_allowed(host, self.allowed_sources):
            return f"source {host} is not in allowed_sources"
        return None

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if SCRIPT_SEP not in stdout:
            return CollectResult.unavailable(
                f"Could not list sessions: {(stderr or stdout).strip()[:200]}")

        parts = stdout.split(SCRIPT_SEP)
        parts += [''] * (3 - len(parts))
        source = parts[0].strip().partition('=')[2] or 'who'
        sessions = parse_loginctl(parts[1]) if source == 'loginctl' else parse_who(parts[1])
        recent = parse_last(parts[2])[:self.recent_logins] if self.recent_logins > 0 else []

        acc = StatusAccumulator()
        logs: List[tuple] = []
        first = self._seen is None
        seen = set() if first else self._seen
        current: Set[str] = set()
        for session in sessions:
            key = f"{session['id']}@{session['since']}"
            current.add(key)
            reason = self._violation(session)
            session['allowed'] = reason is None
            if reason:
                acc.escalate(self.violation_status, f"{_where(session)}: {reason}")
            if key in seen:
                continue
            if reason:
                logs.append((f"Unexpected session: {_where(session)} ({reason})",
                             Status(self.violation_status).log_level))
            elif not first:
                logs.append((f"New session: {_where(session)}", 'INFO'))
        self._seen = current

        remote = sum(1 for s in sessions if s['remote'])
        unexpected = sum(1 for s in sessions if not s['allowed'])
        users = len({s['user'] for s in sessions})
        summary = f"{len(sessions)} session(s), {remote} remote, {users} user(s)"
        if unexpected:
            summary += f", {unexpected} unexpected"
        logs.insert(0, (summary, acc.log_level))
        return CollectResult(
            metrics={'sessions_total': float(len(sessions)), 'sessions_remote': float(remote),
                     'sessions_unexpected': float(unexpected), 'users_total': float(users)},
            logs=logs,
            status=str(acc.status),
            snapshot={'source': source, 'sessions': sessions, 'recent': recent},
        )

    def _snapshot(self) -> Dict[str, Any]:
        snapshot = self.data.latest_snapshot(default={}) if self.data else {}
        return snapshot if isinstance(snapshot, dict) else {}

    @staticmethod
    def _idle_text(session: Dict[str, Any], now: float) -> str:
        if session.get('idle_text'):
            return session['idle_text']
        if not session.get('idle'):
            return 'active'
        since = session.get('idle_since')
        return format_duration(int(now - since)) if since else 'idle'

    @property
    def _session_rows(self) -> List[Dict[str, Any]]:
        now = time.time()
        rows = []
        for session in self._snapshot().get('sessions') or []:
            kind = session.get('type', '')
            if session.get('service'):
                kind = f"{kind} ({session['service']})" if kind else session['service']
            place = '/'.join(p for p in (session.get('seat'), session.get('tty')) if p)
            rows.append({
                'id': session.get('id', ''),
                'user': session.get('user', ''),
                'where': place or '--',
                'host': session.get('host') or 'local',
                'type': kind or '--',
                'since': session.get('since') or '--',
                'idle': self._idle_text(session, now),
                'allowed': session.get('allowed', True),
            })
        return rows

    @property
    def _recent_rows(self) -> List[Dict[str, str]]:
        return [{
            'key': f"{i}-{login.get('login', '')}",
            'user': login.get('user', ''),
            'tty': login.get('tty', ''),
            'host': login.get('host') or 'local',
            'login': login.get('login', ''),
            'until': login.get('until', ''),
            'duration': login.get('duration') or '--',
        } for i, login in enumerate(self._snapshot().get('recent') or [])]

    def _allowed_color(self, row: Dict[str, Any]) -> Optional[str]:
        return None if row.get('allowed', True) else self.violation_status

    def _unexpected_color(self, value: Optional[float]) -> Optional[str]:
        if value is None:
            return None
        return self.violation_status if value > 0 else 'online'

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'sessions_card': {'metric': 'sessions_total', 'title': 'SESSIONS', 'format': 'int'},
            'remote_card': {'metric': 'sessions_remote', 'title': 'REMOTE', 'format': 'int'},
            'users_card': {'metric': 'users_total', 'title': 'USERS', 'format': 'int'},
            'unexpected_card': {'metric': 'sessions_unexpected', 'title': 'UNEXPECTED',
                                'format': 'int', 'color': self._unexpected_color},
        }

    def tables(self) -> Dict[str, Dict[str, Any]]:
        tables: Dict[str, Dict[str, Any]] = {
            'sessions': {
                'row_key': 'id',
                'rows_attr': '_session_rows',
                'columns': [
                    {'name': 'user', 'label': 'User', 'field': 'user', 'sortable': True, 'align': 'left',
                     'cell_color_by': self._allowed_color},
                    {'name': 'where', 'label': 'TTY / Seat', 'field': 'where', 'align': 'left'},
                    {'name': 'host', 'label': 'From', 'field': 'host', 'sortable': True, 'align': 'left',
                     'cell_color_by': self._allowed_color},
                    {'name': 'type', 'label': 'Type', 'field': 'type', 'align': 'left'},
                    {'name': 'since', 'label': 'Since', 'field': 'since', 'sortable': True, 'align': 'left'},
                    {'name': 'idle', 'label': 'Idle', 'field': 'idle', 'align': 'left'},
                ],
            },
        }
        if self.recent_logins > 0:
            tables['recent_logins'] = {
                'row_key': 'key',
                'rows_attr': '_recent_rows',
                'columns': [
                    {'name': 'user', 'label': 'User', 'field': 'user', 'align': 'left'},
                    {'name': 'tty', 'label': 'TTY', 'field': 'tty', 'align': 'left'},
                    {'name': 'host', 'label': 'From', 'field': 'host', 'align': 'left'},
                    {'name': 'login', 'label': 'Login', 'field': 'login', 'align': 'left'},
                    {'name': 'until', 'label': 'Until', 'field': 'until', 'align': 'left'},
                    {'name': 'duration', 'label': 'Duration', 'field': 'duration', 'align': 'right'},
                ],
            }
        return tables

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'sessions_chart': {'metric': 'sessions_total', 'title': 'SESSIONS'}}
