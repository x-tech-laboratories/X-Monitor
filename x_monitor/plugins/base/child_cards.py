"""The default way any monitor shows the monitors nested under it: one
collapsible card per child in a wrapping row, each with the child's status dot,
rendering the child's own UI the first time it opens. Which cards are open is
kept per parent as a setting, so it survives a page refresh."""

import json
from typing import Any, Dict

from x_monitor.core.coordination.monitor_graph import child_label

# ----------------------------------------------------------------------
# Pure helpers
# ----------------------------------------------------------------------

def child_cell_style(child_config: Dict[str, Any], default_min_width: str) -> str:
    """Pure: the flex-cell style string for one child card, from its grid_* config keys."""
    col_span = int(child_config.get('grid_col_span', 1))
    child_height = child_config.get('grid_height', None)
    child_min_width = child_config.get('grid_min_width', default_min_width)
    style = f'flex: {col_span} 1 calc({col_span} * {child_min_width}); min-width: {child_min_width};'
    if child_height:
        style += f' height: {child_height}; overflow-y: auto;'
    return style


def _set_open(chevron: Any, is_open: bool) -> None:
    """Turn a panel's chevron to point down while the panel is open."""
    chevron.classes(add='halon-chevron--open' if is_open else None,
                    remove=None if is_open else 'halon-chevron--open')


# ----------------------------------------------------------------------
# Expansion state
# ----------------------------------------------------------------------

def _setting_key(parent: Any) -> str:
    return f'group_expanded_{parent.id}'


def expanded(parent: Any) -> Dict[str, bool]:
    """Which of the parent's child cards are open, read once through its data view and cached on it."""
    cached = parent.__dict__.get('_expanded_cache')
    if cached is None:
        raw = parent.data.get_setting(_setting_key(parent))
        try:
            cached = json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            cached = {}
        parent.__dict__['_expanded_cache'] = cached
    return cached


def _save_expanded(parent: Any) -> None:
    parent.engine.set_setting(_setting_key(parent), json.dumps(expanded(parent)))


# ----------------------------------------------------------------------
# Rendering
# ----------------------------------------------------------------------

def render_child_cards(parent: Any) -> None:
    """Render one collapsible status-dotted card per child of this monitor in a wrapping flex row."""
    from nicegui import ui

    min_card_width = parent.config.get('grid_min_width', '320px')
    with ui.element('div').style(
        'display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-5); width: 100%;'
    ):
        statuses = parent.data.latest_statuses()
        for child in parent.children:
            _render_child_card(parent, child, statuses, min_card_width)


def _render_child_card(parent: Any, child: Any, statuses: Dict[str, str], min_card_width: str):
    """One collapsible card: a header with the child's status dot, and a body that lazily renders the child's UI on first expand."""
    from nicegui import ui
    from x_monitor.core.ui.theme import STATUS_COLORS
    from x_monitor.core.ui.components import card

    child_status = statuses.get(child.id, 'unavailable')
    child_color = STATUS_COLORS.get(child_status, STATUS_COLORS['unavailable'])
    is_open = expanded(parent).get(child.id, False)

    with ui.element('div').style(child_cell_style(child.config, min_card_width)):
        with card('w-full h-full overflow-hidden', padding=False):
            header_row, chevron = _card_header(parent, child, child_color, is_open)
            body = ui.column().classes('halon-panel-body').style('min-width: 0')
            body.set_visibility(is_open)
            if is_open:
                with body:
                    child.render_ui(context='inline')

        header_row.on('click', _make_toggle(parent, child, body, chevron, rendered=is_open))


def _card_header(parent: Any, child: Any, child_color: str, is_open: bool):
    """The clickable card header row: expand chevron, status dot and child name."""
    from nicegui import ui

    with ui.row().classes(
        'w-full no-wrap halon-panel-header halon-row-hover cursor-pointer select-none'
    ) as header_row:
        chevron = ui.icon('chevron_right').classes('halon-chevron')
        _set_open(chevron, is_open)
        ui.element('div').classes('halon-status-dot').style(f'background: {child_color}')
        ui.label(child_label(parent, child)).classes('halon-title-row flex-1')
    return header_row, chevron


def _make_toggle(parent: Any, child: Any, body: Any, chevron: Any, rendered: bool):
    """The click handler that flips a card open or shut, persists the state, and renders the child's UI the first time it opens."""
    def _toggle(e=None):
        nonlocal rendered
        state = expanded(parent)
        state[child.id] = not state.get(child.id, False)
        open_now = state[child.id]
        body.set_visibility(open_now)
        _set_open(chevron, open_now)
        _save_expanded(parent)
        if open_now and not rendered:
            with body:
                child.render_ui(context='inline')
            rendered = True

    return _toggle
