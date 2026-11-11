"""A host's systemd journal: each poll counts the error and warning entries
written since the last one, logging an event when the errors pass a limit, and the Query Logs action searches the whole
journal on demand by time, priority, unit and text. Nothing is copied into
X-Monitor; a search reads whatever journald still keeps on the host. Status is
online unless warning/threshold (new error entries per poll) are set, warning
when the account can only read its own journal, and unavailable when
journalctl cannot be run. Config: warning, threshold, max_entries."""

import json
import shlex
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Union

from x_monitor.core.connectors.types import ActionPlan, CmdResult, CollectResult, Command
from x_monitor.core.settings.config_schema import PluginConfig
from x_monitor.plugins.base.plugin_helpers import level_for, limit_from, parse_duration
from x_monitor.plugins.base.signal_plugin import SignalPlugin

# ============================================================================
# Journal entries
# ============================================================================

PRIORITY_NAMES = ('emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug')

ERROR_PRIORITY = 3
WARNING_PRIORITY = 4

# The fields a search asks journalctl for; the timestamp and cursor always come along.
_FIELDS = ('MESSAGE', 'PRIORITY', '_SYSTEMD_UNIT', 'SYSLOG_IDENTIFIER', '_COMM', '_PID')

# The most entries one poll reads, so a host flooding its journal cannot flood X-Monitor.
_POLL_CAP = 5000

# The most entries one search returns from one host, which keeps its reply under the agent's 4 MB output limit.
MAX_SEARCH_LIMIT = 5000

_NO_SYSTEM_JOURNAL = 'not seeing messages'


def priority_of(name: Union[str, int, None], default: int = 7) -> int:
    """A journal priority from its number or name, such as 3 or 'err', or the default when it is neither."""
    if name is None or name == '':
        return default
    text = str(name).strip().lower()
    if text.isdigit():
        return min(int(text), 7)
    aliases = {'error': 'err', 'warn': 'warning', 'critical': 'crit', 'emergency': 'emerg'}
    text = aliases.get(text, text)
    return PRIORITY_NAMES.index(text) if text in PRIORITY_NAMES else default


def level_of(priority: int) -> str:
    """The feed level a priority shows as: errors and worse, warnings, and the rest."""
    if priority <= ERROR_PRIORITY:
        return 'ERROR'
    if priority == WARNING_PRIORITY:
        return 'WARNING'
    return 'DEBUG' if priority == 7 else 'INFO'


def _text(value: Any) -> str:
    """A journal field as text; journalctl writes a field that is not valid UTF-8 as a list of byte values."""
    if isinstance(value, list):
        try:
            return bytes(value).decode('utf-8', 'replace')
        except (TypeError, ValueError):
            return ''
    return '' if value is None else str(value)


def parse_entry(line: str) -> Optional[Dict[str, Any]]:
    """One line of `journalctl -o json` as an entry, or None for a line that is not one."""
    try:
        raw = json.loads(line)
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    try:
        epoch = int(raw.get('__REALTIME_TIMESTAMP', 0)) / 1_000_000
    except (TypeError, ValueError):
        epoch = 0.0
    priority = priority_of(_text(raw.get('PRIORITY')), default=6)
    identifier = _text(raw.get('SYSLOG_IDENTIFIER')) or _text(raw.get('_COMM'))
    return {
        'epoch': epoch,
        'cursor': _text(raw.get('__CURSOR')),
        'priority': priority,
        'unit': _text(raw.get('_SYSTEMD_UNIT')),
        'identifier': identifier,
        'pid': _text(raw.get('_PID')),
        'message': _text(raw.get('MESSAGE')),
    }


def entry_time(epoch: float) -> str:
    """An entry's time as the dashboard shows it, in the server's local time."""
    return datetime.fromtimestamp(epoch).strftime('%Y-%m-%d %H:%M:%S') if epoch else ''


def parse_entries(stdout: str) -> List[Dict[str, Any]]:
    """Every entry in `journalctl -o json` output, skipping lines that are not entries."""
    entries = []
    for line in stdout.splitlines():
        if line.startswith('{'):
            entry = parse_entry(line)
            if entry is not None:
                entries.append(entry)
    return entries


# ============================================================================
# Commands
# ============================================================================

def poll_command(cursor: Optional[str], window_seconds: int) -> str:
    """The warning-and-worse entries since the cursor, or over the last window when there is no cursor or it no longer exists."""
    read = (f"journalctl --no-pager -p warning -o json --output-fields={','.join(_FIELDS)} "
            f"-n {_POLL_CAP}")
    since = f"{read} --since=-{int(window_seconds)}s"
    if not cursor:
        return since
    return f"{read} --after-cursor={shlex.quote(cursor)} || {since}"


def search_command(since: Optional[str] = None, priority: Optional[int] = None, unit: str = '',
                   text: str = '', limit: int = 500) -> str:
    """The newest entries matching a search, newest first; `since` is a duration such as '1h', 'boot', or empty for the whole journal."""
    limit = max(1, min(int(limit), MAX_SEARCH_LIMIT))
    parts = ['journalctl', '--no-pager', '-q', '-r', '-o', 'json', f"--output-fields={','.join(_FIELDS)}"]
    if since == 'boot':
        parts.append('-b')
    elif since:
        parts.append(f"--since=-{parse_duration(since)}s")
    if priority is not None and priority < 7:
        parts += ['-p', str(int(priority))]
    if unit.strip():
        parts += ['-u', shlex.quote(unit.strip())]
    if not text.strip():
        return ' '.join(parts + ['-n', str(limit)])
    # grep reads the JSON lines, so a match is checked again against the decoded fields.
    return f"{' '.join(parts)} | grep -iF -e {shlex.quote(text.strip())} | head -n {limit}"


def matches_text(entry: Dict[str, Any], text: str) -> bool:
    """Whether the entry's message, unit or identifier holds the text, ignoring case."""
    needle = text.strip().lower()
    if not needle:
        return True
    return any(needle in str(entry.get(field, '')).lower() for field in ('message', 'unit', 'identifier'))


def search_failure(result: CmdResult) -> Optional[str]:
    """Why a search failed, or None when it ran."""
    error = result.stderr.strip()
    if result.exit_code != 0 and not result.stdout.strip():
        return error or f"journalctl exited with {result.exit_code}"
    if not result.stdout.strip() and error and 'grep' not in error:
        return error
    return None


# ============================================================================
# The monitor
# ============================================================================

class Journal(SignalPlugin):
    """One host's journal: error and warning counts per poll, and a search over all of it."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.warning = limit_from(config, 'warning')
        self.threshold = limit_from(config, 'threshold')
        self.max_entries = max(1, min(int(config.get('max_entries', 500)), MAX_SEARCH_LIMIT))
        self._cursor: Optional[str] = None

    # ===== Polling =====

    def commands(self) -> List[Command]:
        return [Command(poll_command(self._cursor, self.interval))]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        result = results[0]
        entries = parse_entries(result.stdout)
        if result.exit_code != 0 and not entries:
            return CollectResult.unavailable(
                f"Could not read the journal: {result.stderr.strip() or f'exit code {result.exit_code}'}")
        if entries and entries[-1]['cursor']:
            self._cursor = entries[-1]['cursor']

        errors = [entry for entry in entries if entry['priority'] <= ERROR_PRIORITY]
        warnings = len(entries) - len(errors)
        metrics = {'errors_new': float(len(errors)), 'warnings_new': float(warnings)}
        logs: List[Tuple[str, str]] = []
        status = level_for(len(errors), self.warning, self.threshold)

        if _NO_SYSTEM_JOURNAL in result.stderr or _NO_SYSTEM_JOURNAL in result.stdout:
            logs.append(("Only this account's own journal is readable; add it to the systemd-journal group "
                         "to see the system's", 'WARNING'))
            status = 'warning' if status == 'online' else status
        if errors and status != 'online':
            newest = errors[-1]
            source = newest['unit'] or newest['identifier'] or 'journal'
            logs.append((f"{len(errors)} new error entr{'y' if len(errors) == 1 else 'ies'}; newest from "
                         f"{source}: {newest['message'][:200]}", 'ERROR' if status == 'failed' else 'WARNING'))
        if len(entries) >= _POLL_CAP:
            logs.append((f"More than {_POLL_CAP} warning or error entries since the last poll", 'WARNING'))
        return CollectResult(metrics=metrics, logs=logs, status=status)

    # ===== Searching =====

    def plan_action(self, action_id: str, **kwargs) -> Optional[ActionPlan]:
        if action_id != 'query_logs':
            return None
        return ActionPlan(search_command(
            since=kwargs.get('since'), priority=priority_of(kwargs.get('priority')),
            unit=str(kwargs.get('unit') or ''), text=str(kwargs.get('text') or ''),
            limit=int(kwargs.get('limit') or self.max_entries)), timeout=60)

    def interpret_action(self, action_id: str, result: CmdResult, **kwargs) -> CollectResult:
        failure = search_failure(result)
        if failure:
            return CollectResult(success=False, metadata={'content': failure})
        text = str(kwargs.get('text') or '')
        entries = [entry for entry in parse_entries(result.stdout) if matches_text(entry, text)]
        return CollectResult(success=True, metadata={'entries': json.dumps(entries)})

    # ===== Page =====

    def _count_color(self, value: Optional[float]) -> Optional[str]:
        return None if value is None else level_for(value, self.warning, self.threshold)

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'errors_card': {'metric': 'errors_new', 'title': 'NEW ERRORS', 'format': 'int',
                            'color': self._count_color},
            'warnings_card': {'metric': 'warnings_new', 'title': 'NEW WARNINGS', 'format': 'int'},
        }

    def rows(self) -> List[List[str]]:
        return [['log_search']]

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'errors_chart': {'metric': 'errors_new', 'title': 'ERRORS PER POLL'}}

    def render_ui(self, context: str = 'page'):
        from x_monitor.core.ui.layout import PluginLayout, make_inline_layout
        from x_monitor.core.ui.spec import generic_render
        from x_monitor.core.ui.views.logs import render_log_search

        rows = self.UI_SPEC['layout']
        layout = PluginLayout(self.config, rows if context == 'page' else make_inline_layout(rows))
        generic_render(self, context, layout=layout)
        if context == 'page':
            with layout.cell('log_search'):
                render_log_search(self.engine, [self], show_host=False)
