"""The events view: a filterable table of recent engine events."""

from typing import Callable
from nicegui import ui
from x_monitor.core.contracts import EngineLike
from ..components import LEVEL_CELL_SLOT, feed_columns, page_header, table_block, table_heading, table_wrap, on_data_event, offload, refresh_rows
from ..tables import data_table

_EVENT_COLUMNS = feed_columns(target_label='Target',
                              sortable=('timestamp', 'level', 'target'),
                              message_classes='halon-cell-wrap')

# How many events the view reads; older ones are reachable only through the API.
_EVENT_LIMIT = 500



def _render_filter_bar():
    """Renders the level/target/search filters above the table and returns them with their heading line."""
    with table_heading() as heading:
        level_sel = ui.select(
            {None: 'All levels', 'ERROR': 'Error', 'WARNING': 'Warning', 'INFO': 'Info'},
            value=None,
        ).props('outlined dense options-dense').classes('w-40')
        target_in = ui.input(placeholder='Filter by target').props('outlined dense clearable').classes('w-56')
        search_in = ui.input(placeholder='Search messages').props('outlined dense clearable').classes('flex-1')
    return heading, level_sel, target_in, search_in


def render_events(engine: EngineLike, switch_view: Callable):
    """Renders the events view: filter inputs over a level-colored event table."""
    page_header('Events', f'The most recent {_EVENT_LIMIT} events from every monitor')

    ev_filter = {'level': None, 'target': None, 'search': None}

    with table_block():
        heading, level_sel, target_in, search_in = _render_filter_bar()
        with table_wrap():
            events_table = data_table(columns=_EVENT_COLUMNS, filter_into=heading, row_key='timestamp',
                                      pagination=25).classes('w-full').props('flat color=secondary')
            events_table.add_slot('body-cell-level', LEVEL_CELL_SLOT)

    async def refresh_events():
        rows = await offload(engine.db.recent_events)(
            limit=_EVENT_LIMIT,
            level=ev_filter['level'],
            target=(ev_filter['target'] or None),
            search=(ev_filter['search'] or None),
        )
        refresh_rows(events_table, rows)

    async def _on_level(e):
        ev_filter['level'] = e.value
        await refresh_events()

    async def _on_target(e):
        ev_filter['target'] = (e.value or '').strip() or None
        await refresh_events()

    async def _on_search(e):
        ev_filter['search'] = (e.value or '').strip() or None
        await refresh_events()

    level_sel.on_value_change(_on_level)
    target_in.on_value_change(_on_target)
    search_in.on_value_change(_on_search)

    on_data_event(refresh_events, run_now=False)
