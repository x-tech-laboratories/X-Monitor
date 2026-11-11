"""The log search: journal entries from one or many hosts, read live from each host's journal monitor, in one table that sorts, filters and groups."""

import asyncio
import json
from typing import Any, Callable, Dict, Iterable, List, Sequence, Tuple

from nicegui import ui

from x_monitor.core.contracts import EngineLike
from x_monitor.core.coordination.monitor_graph import iter_monitors
from x_monitor.plugins.journal import Journal, PRIORITY_NAMES, entry_time
from ..components import action_button, page_header, table_block, table_heading, table_wrap
from ..tables import data_table

# ============================================================================
# Choices
# ============================================================================

SINCE_OPTIONS = {
    '15m': 'Last 15 minutes', '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last day',
    '7d': 'Last week', 'boot': 'This boot', '': 'Everything kept',
}

PRIORITY_OPTIONS = {
    3: 'Errors and worse', 4: 'Warnings and worse', 5: 'Notices and worse',
    6: 'Info and worse', 7: 'Everything',
}

LIMIT_OPTIONS = {100: '100 per host', 500: '500 per host', 1000: '1000 per host', 5000: '5000 per host'}

GROUP_OPTIONS = {'': 'No grouping', 'host': 'Group by host', 'unit': 'Group by unit', 'priority': 'Group by priority'}

# The badge each priority is drawn with; notices and below that are not info stay neutral.
_PRIORITY_BADGES = {0: 'halon-badge-danger', 1: 'halon-badge-danger', 2: 'halon-badge-danger',
                    3: 'halon-badge-danger', 4: 'halon-badge-warning', 5: 'halon-badge-info'}

_PRIORITY_SLOT = '''
    <q-td :props="props">
        <span v-if="props.row.priority_name" class="halon-badge" :class="props.row.priority_badge">
            {{ props.row.priority_name }}
        </span>
    </q-td>
'''

_FILTER_FIELDS = ['time', 'host', 'unit', 'priority_name', 'message']

# ============================================================================
# Rows
# ============================================================================

def journal_monitors(roots: Iterable[Any]) -> List[Journal]:
    """Every journal monitor under the roots, once each, in config order."""
    return [plugin for plugin in iter_monitors(roots) if isinstance(plugin, Journal)]


def entry_rows(results: Sequence[Tuple[Any, List[Dict[str, Any]]]]) -> List[Dict[str, Any]]:
    """One row per entry from every monitor's search, newest first."""
    rows = []
    for plugin, entries in results:
        for index, entry in enumerate(entries):
            priority = int(entry.get('priority', 6))
            rows.append({
                'key': f"{plugin.id}:{entry.get('cursor') or index}",
                'monitor_id': plugin.id,
                'epoch': float(entry.get('epoch') or 0),
                'time': entry_time(float(entry.get('epoch') or 0)),
                'host': plugin.target,
                'unit': entry.get('unit') or entry.get('identifier') or '',
                'priority': priority,
                'priority_name': PRIORITY_NAMES[min(max(priority, 0), 7)],
                'priority_badge': _PRIORITY_BADGES.get(priority, ''),
                'message': entry.get('message', ''),
            })
    rows.sort(key=lambda row: row['epoch'], reverse=True)
    return rows


def _group_value(row: Dict[str, Any], group_by: str) -> str:
    if group_by == 'priority':
        return row['priority_name']
    return row.get(group_by) or '(none)'


def grouped_rows(rows: List[Dict[str, Any]], group_by: str) -> List[Dict[str, Any]]:
    """The rows under one parent row per value of the grouping field, the most recently active group first."""
    if not group_by:
        return rows
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(_group_value(row, group_by), []).append(row)
    if group_by == 'priority':
        order = sorted(groups, key=PRIORITY_NAMES.index)
    else:
        order = list(groups)

    flat = []
    for value in order:
        members = groups[value]
        worst = min(member['priority'] for member in members)
        parent = f"group:{value}"
        flat.append({
            'key': parent, 'parent': None, 'group': f"{value} ({len(members)})",
            'epoch': members[0]['epoch'], 'time': members[0]['time'], 'host': '', 'unit': '',
            'priority': worst, 'priority_name': '', 'priority_badge': '', 'message': '',
        })
        flat.extend({**member, 'parent': parent, 'group': ''} for member in members)
    return flat


def summary_text(entry_count: int, host_count: int, failures: List[Tuple[str, str]]) -> str:
    """One line saying how many entries came from how many hosts, and which hosts could not be searched."""
    text = f"{entry_count} entr{'y' if entry_count == 1 else 'ies'} from {host_count} host{'' if host_count == 1 else 's'}"
    if failures:
        text += '. Not searched: ' + '; '.join(f"{host} ({error})" for host, error in failures)
    return text


def search_kwargs(since: Any, priority: Any, unit: Any, text: Any, limit: Any) -> Dict[str, Any]:
    """The Query Logs action's arguments from the search bar's values."""
    return {'since': since or '', 'priority': priority if priority is not None else 7,
            'unit': str(unit or '').strip(), 'text': str(text or '').strip(), 'limit': int(limit or 500)}


async def run_search(engine: EngineLike, monitors: Sequence[Journal],
                     kwargs: Dict[str, Any]) -> Tuple[List[Tuple[Any, List[Dict[str, Any]]]], List[Tuple[str, str]]]:
    """Every monitor's search at once, as the entries each returned and the hosts that failed with why."""
    outcomes = await asyncio.gather(*(engine.dispatch_action(plugin, 'query_logs', **kwargs) for plugin in monitors),
                                    return_exceptions=True)
    results, failures = [], []
    for plugin, outcome in zip(monitors, outcomes):
        if isinstance(outcome, BaseException):
            failures.append((plugin.target, str(outcome) or type(outcome).__name__))
            continue
        success, metadata = outcome
        metadata = metadata or {}
        if not success:
            failures.append((plugin.target, str(metadata.get('content') or 'the search failed').strip()))
            continue
        try:
            results.append((plugin, json.loads(metadata.get('entries') or '[]')))
        except ValueError:
            failures.append((plugin.target, 'the reply could not be read'))
    return results, failures


# ============================================================================
# Widgets
# ============================================================================

def _columns(show_host: bool, grouped: bool) -> List[Dict[str, Any]]:
    columns = []
    if grouped:
        columns.append({'name': 'group', 'label': 'Group', 'field': 'group', 'align': 'left', 'sortable': False})
    columns.append({'name': 'time', 'label': 'Time', 'field': 'time', 'align': 'left',
                    'classes': 'whitespace-nowrap'})
    if show_host:
        columns.append({'name': 'host', 'label': 'Host', 'field': 'host', 'align': 'left'})
    columns += [
        {'name': 'unit', 'label': 'Unit', 'field': 'unit', 'align': 'left'},
        {'name': 'priority', 'label': 'Priority', 'field': 'priority', 'align': 'left'},
        {'name': 'message', 'label': 'Message', 'field': 'message', 'align': 'left',
         'classes': 'halon-cell-wrap font-mono', 'sortable': False},
    ]
    return columns


def render_log_search(engine: EngineLike, monitors: Sequence[Journal], show_host: bool = True):
    """The search bar and results table over these journal monitors; a search runs on each monitor's host at once."""
    first = monitors[0] if monitors else None
    default_limit = first.max_entries if len(monitors) == 1 else 500
    state: Dict[str, Any] = {'rows': [], 'summary': 'Pick filters and press Search'}

    with table_block():
        with ui.row().classes('w-full items-center gap-3'):
            hosts = None
            if show_host and len(monitors) > 1:
                hosts = ui.select({plugin.id: plugin.target for plugin in monitors}, multiple=True,
                                  value=[plugin.id for plugin in monitors]) \
                    .props('outlined dense options-dense').classes('w-64')
            since = ui.select(SINCE_OPTIONS, value='1h').props('outlined dense options-dense').classes('w-40')
            priority = ui.select(PRIORITY_OPTIONS, value=6).props('outlined dense options-dense').classes('w-44')
            unit = ui.input(placeholder='Unit, e.g. nginx.service').props('outlined dense clearable').classes('w-56')
            text = ui.input(placeholder='Text in the entry').props('outlined dense clearable').classes('flex-1 min-w-[12rem]')
            limit = ui.select({**LIMIT_OPTIONS, default_limit: f"{default_limit} per host"}, value=default_limit) \
                .props('outlined dense options-dense').classes('w-36')
            group_options = GROUP_OPTIONS if show_host else {key: label for key, label in GROUP_OPTIONS.items() if key != 'host'}
            group = ui.select(group_options, value='').props('outlined dense options-dense').classes('w-44')
            search = action_button('Search', icon='search', weight='filled')
        heading = table_heading()
        results = ui.column().classes('w-full')

    def show() -> None:
        heading.clear()
        results.clear()
        with heading:
            ui.label(state['summary']).classes('halon-lede flex-1 min-w-0')
        grouped = bool(group.value)
        with results, table_wrap():
            table = data_table(columns=_columns(show_host, grouped), filter_into=heading, row_key='key',
                               filter_fields=_FILTER_FIELDS, pagination=100,
                               tree={'parent_field': 'parent', 'column': 'group'} if grouped else None) \
                .classes('w-full').props('flat color=secondary')
            table.add_slot('body-cell-priority', _PRIORITY_SLOT)
        shown = grouped_rows(state['rows'], group.value or '')
        controls = table.x_controls
        if grouped:
            controls.collapsed = {row['key'] for row in shown if row.get('parent') is None}
        controls.set_rows(shown)

    async def run():
        chosen = [plugin for plugin in monitors if hosts is None or plugin.id in (hosts.value or [])]
        if not chosen:
            state['rows'], state['summary'] = [], 'Pick at least one host'
            show()
            return
        search.props('loading')
        try:
            found, failures = await run_search(
                engine, chosen, search_kwargs(since.value, priority.value, unit.value, text.value, limit.value))
        finally:
            search.props(remove='loading')
        state['rows'] = entry_rows(found)
        state['summary'] = summary_text(len(state['rows']), len(found), failures)
        show()

    search.on_click(run)
    unit.on('keydown.enter', run)
    text.on('keydown.enter', run)
    group.on_value_change(lambda _: show())
    show()


def render_logs(engine: EngineLike, switch_view: Callable):
    """Renders the logs view: one search over the journal of every host that has a journal monitor."""
    page_header('Logs', "Search every host's journal at once; each search reads the hosts live")
    monitors = journal_monitors(engine.plugins)
    if not monitors:
        ui.label('No journal monitors are configured. Add a monitor of type "journal" for each host to search.') \
            .classes('halon-lede')
        return
    render_log_search(engine, monitors, show_host=True)
