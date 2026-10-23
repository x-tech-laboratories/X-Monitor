"""The schedules view: every monitor's scheduled and triggered actions in one table, with each one's next run and how its last run went."""

import json
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple

from x_monitor.core.contracts import EngineLike
from x_monitor.core.coordination.monitor_graph import find_monitor
from ..components import STATUS_BADGES, offload, on_data_event, page_header, refresh_rows, table_block, table_heading, table_wrap
from ..tables import data_table
from .plugin_detail import action_names

_COLUMNS = [
    {'name': 'monitor', 'label': 'Monitor', 'field': 'monitor', 'align': 'left'},
    {'name': 'action', 'label': 'Action', 'field': 'action', 'align': 'left'},
    {'name': 'cron', 'label': 'When', 'field': 'cron', 'align': 'left'},
    {'name': 'next', 'label': 'Next run', 'field': 'next', 'align': 'left'},
    {'name': 'last', 'label': 'Last run', 'field': 'last', 'align': 'left'},
    {'name': 'outcome', 'label': 'Outcome', 'field': 'outcome', 'align': 'left'},
]

# The outcome is a badge like a monitor's state, and a row that has not run yet leaves the cell empty.
_OUTCOME_SLOT = '''
    <q-td :props="props">
        <span v-if="props.row.outcome" class="halon-badge" :class="props.row.outcome_badge"
              :title="props.row.message">{{ props.row.outcome }}</span>
    </q-td>
'''

_WHEN = '%a %d %b %H:%M'


def _action_label(names: Dict[str, str], action: str, args: Dict[str, Any]) -> str:
    """The action as its button names it, or its id in words when it has no button of its own, followed by any arguments the schedule passes."""
    label = names.get(action) or action.replace('_', ' ').capitalize()
    if args:
        label += ' (' + ', '.join(f"{key}: {value}" for key, value in sorted(args.items())) + ')'
    return label


def _last_run(raw: Optional[str]) -> Dict[str, Any]:
    """The stored record of an entry's last run, or an empty one when it has not run or the record is unreadable."""
    try:
        record = json.loads(raw) if raw else {}
    except (json.JSONDecodeError, ValueError):
        return {}
    return record if isinstance(record, dict) else {}


def _with_paths(roots: Iterable[Any]) -> Iterator[Tuple[Any, str]]:
    """Every monitor under the roots once, with the names of the groups above it and its own, since names repeat across hosts."""
    seen = set()

    def walk(plugins: Iterable[Any], path: Tuple[str, ...]):
        for plugin in plugins:
            if id(plugin) in seen:
                continue
            seen.add(id(plugin))
            here = path + (plugin.name,)
            yield plugin, ' › '.join(here)
            yield from walk(getattr(plugin, 'children', None) or [], here)

    yield from walk(roots, ())


def _last_run_cells(raw: Optional[str]) -> Dict[str, Any]:
    """The last run, outcome and badge cells of a row, from an entry's stored record."""
    last = _last_run(raw)
    ran = last.get('at')
    return {
        'last': f"{datetime.fromtimestamp(ran):{_WHEN}}" if ran else 'not yet',
        'outcome': ('Started' if last.get('ok') else 'Failed') if ran else '',
        'outcome_badge': STATUS_BADGES['online' if last.get('ok') else 'failed'] if ran else '',
        'message': last.get('message', ''),
    }


def schedule_rows(roots: Iterable[Any], get_setting: Callable[[str], Optional[str]], now: datetime) -> List[Dict[str, Any]]:
    """One row per scheduled or triggered action anywhere under the roots, soonest next run first and triggered ones last."""
    rows = []
    for plugin, path in _with_paths(roots):
        entries = getattr(plugin, 'scheduled_actions', None) or []
        triggered = getattr(plugin, 'triggered_actions', None) or []
        if not entries and not triggered:
            continue
        names = action_names(plugin.all_actions())
        for index, entry in enumerate(entries):
            upcoming = entry.cron.next_after(now)
            rows.append({
                'id': f"{plugin.id}:{index}",
                'monitor_id': plugin.id,
                'monitor': path,
                'action': _action_label(names, entry.action, entry.args),
                'cron': entry.cron.expression,
                'next': f"{upcoming:{_WHEN}}" if upcoming else 'never',
                'next_epoch': upcoming.timestamp() if upcoming else float('inf'),
                **_last_run_cells(get_setting(entry.result_key(plugin.id))),
            })
        for index, entry in enumerate(triggered):
            rows.append({
                'id': f"{plugin.id}:trigger:{index}",
                'monitor_id': plugin.id,
                'monitor': path,
                'action': _action_label(names, entry.action, entry.args),
                'cron': entry.describe().capitalize(),
                'next': 'on that event',
                'next_epoch': float('inf'),
                **_last_run_cells(get_setting(entry.result_key(plugin.id))),
            })
    rows.sort(key=lambda row: (row['next_epoch'], row['monitor'].lower()))
    return rows


def render_schedules(engine: EngineLike, switch_view: Callable):
    """Renders the schedules view: one row per scheduled action, and a click opens its monitor."""
    page_header('Schedules', 'Every action a monitor runs on its own, soonest first; click a row to open its monitor')

    with table_block():
        heading = table_heading()
        with table_wrap():
            table = data_table(columns=_COLUMNS, filter_into=heading, row_key='id',
                               pagination=50).classes('w-full').props('flat color=secondary')
            table.add_slot('body-cell-outcome', _OUTCOME_SLOT)

    def open_monitor(e):
        row = e.args[1] if isinstance(e.args, list) and len(e.args) > 1 else {}
        plugin = find_monitor(engine, row.get('monitor_id')) if row else None
        if plugin is not None:
            switch_view('plugin', plugin)

    table.on('rowClick', open_monitor)

    async def refresh():
        rows = await offload(schedule_rows)(engine.plugins, engine.db.get_setting, datetime.now())
        refresh_rows(table, rows)

    on_data_event(refresh)
