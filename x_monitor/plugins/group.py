"""A container monitor that folds its child monitors' statuses into its own.
It issues no requests of its own: each cycle it re-reads the children's latest
statuses from the read-only data view, counting a child with no status yet as
unavailable, and combines them by its `aggregate` rule (worst child by default;
best child; or online while a quorum of children is healthy). A poll of the
group from the dashboard polls every descendant first, then folds their fresh
statuses. Config: aggregate, layout (compose individual descendant widgets into
the group's own grid) plus the grid_min_width default and the per-child grid_*
sizing keys; without a layout it renders one collapsible card per child."""

import logging
from typing import Any, Dict, Iterator, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import CollectResult, Status
from x_monitor.core.settings.config_schema import PluginConfig
from x_monitor.core.ui.spec_types import UISpec

log = logging.getLogger(__name__)

# Group-provided pseudo-widget: a status card for a child that has none of its own.
STATUS_WIDGET = 'status'

WORST = 'worst'
BEST = 'best'
QUORUM = 'quorum'

# The child statuses that count toward a quorum.
HEALTHY = (Status.ONLINE, Status.INFO)


def parse_aggregate(value: Any) -> Tuple[str, int]:
    """Pure: the `aggregate` setting as (rule, quorum size), reading anything unrecognised as worst."""
    if value is None or value == WORST:
        return WORST, 0
    if value == BEST:
        return BEST, 0
    if isinstance(value, dict) and set(value) == {QUORUM}:
        try:
            size = int(value[QUORUM])
        except (TypeError, ValueError):
            size = 0
        if size >= 1:
            return QUORUM, size
    log.error(f"aggregate: expected worst, best or {{quorum: <n>}}, got {value!r}; using worst")
    return WORST, 0


def aggregate_status(rule: str, quorum: int, statuses: List[str]) -> Tuple[Status, Optional[str]]:
    """Pure: the group's status from its children's, by rule, and a line saying why when a quorum is lost."""
    if rule == BEST:
        return Status.best(statuses), None
    if rule == QUORUM:
        healthy = [s for s in statuses if Status.of(s) in HEALTHY]
        if len(healthy) >= quorum:
            return Status.ONLINE, None
        unhealthy = [s for s in statuses if Status.of(s) not in HEALTHY]
        return Status.worst(unhealthy), f"{len(healthy)} of {len(statuses)} healthy, quorum is {quorum}"
    return Status.worst(statuses), None


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
    RUNS_ON_AGENT = False
    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.aggregate, self.quorum = parse_aggregate(config.get('aggregate'))

    @property
    def restates_children(self) -> bool:
        """A worst-of group only repeats its children; a best-of or quorum verdict is news of its own."""
        return self.aggregate == WORST

    def parse_results(self, results: List[Any]) -> CollectResult:
        """A group issues no requests; each cycle it re-reads live child
        status from the Database Engine (via the read-only data view) and
        folds it by its aggregate rule."""
        status, reason = self._aggregate()
        logs = [(reason, status.log_level)] if reason else []
        return CollectResult(status=status, logs=logs)

    def _aggregate(self) -> Tuple[Status, Optional[str]]:
        return aggregate_status(self.aggregate, self.quorum, list(self.child_statuses().values()))

    def _descendants(self) -> Iterator[Any]:
        """Every monitor under this group once each, depth-first, so a layout can address a nested group's children."""
        from x_monitor.core.coordination.monitor_graph import iter_monitors
        yield from iter_monitors(self.children)

    def render_ui(self, context: str = 'page'):
        """Render the configured composite grid, or the default one-card-per-child layout without one."""
        layout_rows = self.config.get('layout')
        if isinstance(layout_rows, list) and layout_rows:
            self._render_composite(layout_rows)
        else:
            from x_monitor.plugins.base.child_cards import render_child_cards
            render_child_cards(self)

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
