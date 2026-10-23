"""A container monitor that aggregates its child monitors. It issues no
requests of its own: each cycle it re-reads the children's latest statuses
from the read-only data view and takes the worst as its own, counting a child
with no status yet as unavailable. A poll of the group from the dashboard
polls every descendant first, then folds their fresh statuses. Config: layout (compose individual descendant
widgets into the group's own grid) plus the grid_min_width default and the
per-child grid_* sizing keys; without a layout it renders one collapsible
card per child, persisting the expansion state as a setting."""

import asyncio
import json
import logging
from typing import Any, Dict, Iterator, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import CollectResult, Status
from x_monitor.core.ui.spec_types import UISpec
from x_monitor.core.coordination.monitor_graph import child_label

log = logging.getLogger(__name__)

# Group-provided pseudo-widget: a status card for a child that has none of its own.
STATUS_WIDGET = 'status'


def _child_cell_style(child_config: Dict[str, Any], default_min_width: str) -> str:
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


def spec_with_titles(spec: Optional[UISpec], titles: Dict[str, str]) -> Optional[UISpec]:
    """Pure: copy a child's UI_SPEC with the group's per-widget title overrides applied."""
    if spec is None or not titles:
        return spec
    patched = dict(spec)
    for key in ('cards', 'charts'):
        section = patched.get(key)
        if section:
            patched[key] = {
                name: ({**widget, 'title': titles[name]} if name in titles else widget)
                for name, widget in section.items()
            }
    if 'chart' in patched and 'chart' in titles:
        patched['chart'] = {**patched['chart'], 'title': titles['chart']}
    return patched


class Group(Plugin):
    def parse_results(self, results: List[Any]) -> CollectResult:
        """A group issues no requests; each cycle it re-reads live child
        status from the Database Engine (via the read-only data view) and
        folds it into a worst-case aggregate status."""
        statuses = self.data.latest_statuses()
        return CollectResult(status=self._aggregate_status(statuses))

    def _aggregate_status(self, statuses: Dict[str, str]) -> str:
        return Status.worst(statuses.get(child.id, 'unavailable') for child in self.children)

    async def run_cycle(self) -> bool:
        """A poll of the group polls every descendant first, so the aggregate folds fresh child statuses."""
        outcomes = await asyncio.gather(*(child.run_cycle() for child in self.children),
                                        return_exceptions=True)
        for child, outcome in zip(self.children, outcomes):
            if isinstance(outcome, BaseException):
                log.error(f"{child.name}: poll from group {self.name!r} failed: {outcome}")
        return await super().run_cycle()

    def _descendants(self) -> Iterator[Any]:
        """Every monitor under this group once each, depth-first, so a layout can address a nested group's children."""
        from x_monitor.core.coordination.monitor_graph import iter_monitors
        yield from iter_monitors(self.children)

    def _setting_key(self) -> str:
        return f'group_expanded_{self.id}'

    @property
    def _expanded(self) -> Dict[str, bool]:
        # Lazy so it reads through the engine-injected data view, which isn't
        # available at construction time.
        cached = self.__dict__.get('_expanded_cache')
        if cached is None:
            raw = self.data.get_setting(self._setting_key())
            try:
                cached = json.loads(raw) if raw else {}
            except (ValueError, TypeError):
                cached = {}
            self.__dict__['_expanded_cache'] = cached
        return cached

    def _save_expanded(self):
        self.engine.set_setting(self._setting_key(), json.dumps(self._expanded))

    def render_ui(self, context: str = 'page'):
        """Render the configured composite grid, or the default one-card-per-child layout without one."""
        layout_rows = self.config.get('layout')
        if isinstance(layout_rows, list) and layout_rows:
            self._render_composite(layout_rows)
        else:
            self._render_cards()

    # ------------------------------------------------------------------
    # Composite layout — the group's own grid of its descendants' widgets
    # ------------------------------------------------------------------

    def _render_composite(self, layout_rows: List[Any]):
        """Render individual descendant widgets into the group's own rows, addressed as '<child_id>.<widget>'."""
        from x_monitor.core.ui.components import offload, on_data_event
        from x_monitor.core.ui.layout import CompositeLayout
        from x_monitor.core.ui.spec import generic_render

        grid = CompositeLayout(layout_rows)
        statuses = self.data.latest_statuses()
        status_labels: List[Tuple[str, Any]] = []

        for child in self._descendants():
            if grid.hosts_child(child.id):
                with grid.cell(child.id):
                    self._section_title(grid.config_for(child.id).get('title'))
                    child.render_ui(context='inline')

            widgets = grid.widgets_for(child.id)
            status_cfg = widgets.pop(STATUS_WIDGET, None)
            if status_cfg is not None:
                with grid.cell(f'{child.id}.{STATUS_WIDGET}'):
                    status_labels.append(
                        (child.id, self._status_card(child, statuses, status_cfg))
                    )

            if not widgets:
                continue

            spec = getattr(child, 'UI_SPEC', None)
            if spec is None:
                log.warning(
                    "Group %s: %s has a hand-written UI and cannot have its widgets placed "
                    "individually — reference it as '%s' to render it whole",
                    self.id, child.id, child.id,
                )
                continue

            titles = {name: cfg['title'] for name, cfg in widgets.items() if cfg.get('title')}
            generic_render(child, context='inline',
                           spec=spec_with_titles(spec, titles),
                           layout=grid.view(child.id))

        if status_labels:
            async def _refresh_statuses():
                from x_monitor.core.ui.components import show_state
                live = await offload(self.data.latest_statuses)()
                for child_id, label in status_labels:
                    state = live.get(child_id, 'unavailable')
                    label.text = state.upper()
                    show_state(label, state)
            on_data_event(_refresh_statuses)

        for ref in grid.unclaimed():
            log.warning("Group %s: layout references unknown widget %r", self.id, ref)

    def _section_title(self, title: Optional[str]):
        """Label a whole-child cell, which has no widget title of its own to override."""
        if title:
            from x_monitor.core.ui.components import section_title
            section_title(title)

    def _status_card(self, child: Any, statuses: Dict[str, str], cfg: dict):
        """The group's own status card for a child, since not every plugin declares one."""
        from x_monitor.core.ui.components import info_card, show_state

        state = statuses.get(child.id, 'unavailable')
        label = info_card(cfg.get('title') or child.name.upper(), state.upper())
        show_state(label, state)
        return label

    # ------------------------------------------------------------------
    # Card layout — one collapsible card per child, the default
    # ------------------------------------------------------------------

    def _render_cards(self):
        """Render the default layout: one collapsible status-dotted card per child in a wrapping flex row."""
        from nicegui import ui

        min_card_width = self.config.get('grid_min_width', '320px')
        with ui.element('div').style(
            'display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-5); width: 100%;'
        ):
            statuses = self.data.latest_statuses()
            for child in self.children:
                self._render_child_card(child, statuses, min_card_width)

    def _render_child_card(self, child: Any, statuses: Dict[str, str], min_card_width: str):
        """One collapsible card: a header with the child's status dot, and a body that lazily renders the child's UI on first expand."""
        from nicegui import ui
        from x_monitor.core.ui.theme import STATUS_COLORS
        from x_monitor.core.ui.components import card

        child_status = statuses.get(child.id, 'unavailable')
        child_color = STATUS_COLORS.get(child_status, STATUS_COLORS['unavailable'])
        is_open = self._expanded.get(child.id, False)

        with ui.element('div').style(_child_cell_style(child.config, min_card_width)):
            with card('w-full h-full overflow-hidden', padding=False):
                header_row, chevron = self._card_header(child, child_color, is_open)
                body = ui.column().classes('halon-panel-body').style('min-width: 0')
                body.set_visibility(is_open)
                if is_open:
                    with body:
                        child.render_ui(context='inline')

            header_row.on('click', self._make_toggle(child, body, chevron, rendered=is_open))

    def _card_header(self, child: Any, child_color: str, is_open: bool):
        """The clickable card header row: expand chevron, status dot and child name."""
        from nicegui import ui

        with ui.row().classes(
            'w-full no-wrap halon-panel-header halon-row-hover cursor-pointer select-none'
        ) as header_row:
            chevron = ui.icon('chevron_right').classes('halon-chevron')
            _set_open(chevron, is_open)
            ui.element('div').classes('halon-status-dot').style(f'background: {child_color}')
            ui.label(child_label(self, child)).classes('halon-title-row flex-1')
        return header_row, chevron

    def _make_toggle(self, child: Any, body: Any, chevron: Any, rendered: bool):
        """The click handler that flips a card open or shut, persists the state, and renders the child's UI the first time it opens."""
        def _toggle(e=None):
            nonlocal rendered
            self._expanded[child.id] = not self._expanded.get(child.id, False)
            open_now = self._expanded[child.id]
            body.set_visibility(open_now)
            _set_open(chevron, open_now)
            self._save_expanded()
            if open_now and not rendered:
                with body:
                    child.render_ui(context='inline')
                rendered = True

        return _toggle
