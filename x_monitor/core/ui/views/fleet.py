"""The fleet sections of the overview: a tile per host, reachability strips, backup ages,
deployments and vulnerability findings. Each section appears only when the fleet has monitors of
its kind, and each is built by a pure function over monitors and readings so it can be tested
without a page."""

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from nicegui import ui

from x_monitor.core.coordination.monitor_graph import iter_monitors, restates_children
from x_monitor.plugins.base.plugin_helpers import format_age

from .. import charts
from ..components import LABEL_CLASS, ItemSlots, card, offload, on_data_event
from ..theme import STATUS_COLORS

# ============================================================================
# Which monitors feed which section
# ============================================================================

# The 0/1 metric each reachability monitor type records, which its strip draws.
UP_METRICS = {
    'uptime': 'up',
    'http': 'probe_ok',
    'mosquitto': 'roundtrip_ok',
    'dns_record': 'resolved',
    'push': 'reported_up',
}

STATUS_ORDER = ('online', 'info', 'warning', 'failed', 'unavailable')

# Worst first, so a host takes the most severe state among its monitors.
STATUS_SEVERITY = ('failed', 'warning', 'unavailable', 'info', 'online')

# A backup meter is full at twice its monitor's max age, so the max age sits at its middle.
BACKUP_SCALE = 2.0

LatestMetric = Callable[[str, str], Optional[float]]
MetricHistory = Callable[[str, str, int], List[Optional[float]]]


def primary_roots(engine: Any) -> list:
    """The roots of the monitor tree, one host tile each."""
    return list(engine.plugins)


def monitor_type(monitor: Any) -> str:
    """A monitor's plugin type from its config."""
    return monitor.config.get('type', 'unknown')


def leaves_with_paths(root: Any) -> List[Tuple[Any, List[str]]]:
    """Every monitor under a root once each, leaving out plain groups, with the names of the parents between them."""
    found, seen = [], set()

    def walk(node, path):
        for child in node.children:
            if id(child) in seen:
                continue
            seen.add(id(child))
            if not restates_children(child):
                found.append((child, path))
            walk(child, path + [child.name])

    if not restates_children(root):
        found.append((root, []))
    walk(root, [])
    return found


def worst_status(states: List[str]) -> str:
    """The most severe of these states, or unavailable when there are none."""
    for name in STATUS_SEVERITY:
        if name in states:
            return name
    return 'unavailable'


# ============================================================================
# Building each section from monitors and readings
# ============================================================================

@dataclass
class HostTile:
    id: str
    name: str
    state: str
    caption: str
    counts: Dict[str, int] = field(default_factory=dict)


def build_host_tiles(roots: list, statuses: Dict[str, str]) -> List[HostTile]:
    """One tile per top-level group: its worst state, how many monitors it holds and how many
    of them are failing or warning."""
    tiles = []
    for root in roots:
        leaf_states = [statuses.get(leaf.id, 'unavailable') for leaf, _ in leaves_with_paths(root)]
        counts = {name: leaf_states.count(name) for name in STATUS_ORDER}
        total = len(leaf_states)
        trouble = [f'{counts[name]} {name}' for name in ('failed', 'warning') if counts[name]]
        caption = ' · '.join([f"{total} monitor{'' if total == 1 else 's'}", *trouble])
        tiles.append(HostTile(root.id, root.name, worst_status(leaf_states), caption, counts))
    return tiles


@dataclass
class StripRow:
    id: str
    host: str
    name: str
    metric: str


def build_strip_rows(roots: list) -> List[StripRow]:
    """One strip per reachability monitor, in host order, each named by the monitor."""
    rows, seen = [], set()
    for root in roots:
        for leaf, _ in leaves_with_paths(root):
            metric = UP_METRICS.get(monitor_type(leaf))
            if metric and leaf.id not in seen:
                seen.add(leaf.id)
                rows.append(StripRow(leaf.id, root.name, leaf.name, metric))
    return rows


@dataclass
class BackupRow:
    id: str
    label: str
    value_text: str
    percent: float
    state: str


def build_backup_rows(roots: list, statuses: Dict[str, str], latest: LatestMetric,
                      now: float) -> List[BackupRow]:
    """One meter per borg repository of the time since its newest archive, full at twice the
    monitor's max age, labeled by host and the groups that name the repository."""
    rows = []
    for root in roots:
        for leaf, path in leaves_with_paths(root):
            if monitor_type(leaf) != 'borg':
                continue
            label = ' › '.join([*path[-1:], leaf.name])
            newest = latest(leaf.id, 'last_backup_epoch')
            max_age = float(getattr(leaf, 'max_age', 86400) or 86400)
            if newest is None:
                rows.append(BackupRow(leaf.id, f'{root.name} · {label}', 'No archive yet', 0.0,
                                      statuses.get(leaf.id, 'unavailable')))
                continue
            age = max(0.0, now - newest)
            rows.append(BackupRow(leaf.id, f'{root.name} · {label}', format_age(int(age)),
                                  charts.fill_percent(age, max_age * BACKUP_SCALE),
                                  statuses.get(leaf.id, 'unavailable')))
    return rows


@dataclass
class DeployTile:
    id: str
    name: str
    state: str
    caption: str


def build_deploy_tiles(roots: list, statuses: Dict[str, str], latest: LatestMetric) -> List[DeployTile]:
    """One tile per NixOS deployment: its generation and whether it is in sync, drifting or
    waiting on a reboot."""
    tiles = []
    for root in roots:
        for leaf, _ in leaves_with_paths(root):
            if monitor_type(leaf) != 'nixos_upgrade':
                continue
            generation = latest(leaf.id, 'generation')
            parts = [f'gen {int(generation)}'] if generation is not None else []
            if latest(leaf.id, 'reboot_required'):
                parts.append('reboot pending')
            up_to_date = latest(leaf.id, 'up_to_date')
            if up_to_date is not None:
                parts.append('in sync' if up_to_date else 'drift')
            tiles.append(DeployTile(leaf.id, leaf.name, statuses.get(leaf.id, 'unavailable'),
                                    ' · '.join(parts) or 'not checked yet'))
    return tiles


@dataclass
class FindingRow:
    id: str
    name: str
    vulnerable: float
    suspected: float
    noted: float
    text: str


def build_finding_rows(roots: list, latest: LatestMetric) -> List[FindingRow]:
    """One bar per vulnerability scan, split into vulnerable, likely and noted findings."""
    rows = []
    for root in roots:
        for leaf, _ in leaves_with_paths(root):
            if monitor_type(leaf) != 'vuln_scan':
                continue
            counts = [latest(leaf.id, name) or 0.0 for name in ('vulnerable', 'suspected', 'noted')]
            ports = latest(leaf.id, 'open_ports')
            text = ' · '.join(f'{int(c)}' for c in counts)
            if ports is not None:
                text += f' · {int(ports)} open ports'
            rows.append(FindingRow(leaf.id, root.name, *counts, text))
    return rows


# ============================================================================
# Drawing each section
# ============================================================================

FINDING_COLORS = (STATUS_COLORS['failed'], STATUS_COLORS['warning'], charts.color_for('neutral'))


def draw_host_tile(open_host: Callable[[str], None]) -> Callable[[HostTile], None]:
    """A clickable host tile with a small bar of its monitors by state under the caption; returns the
    function that fills it from a HostTile."""
    shown = {}
    tile, show = charts.draw_status_tile()
    tile.classes('halon-host-tile cursor-pointer').on('click', lambda _e: open_host(shown['id']))
    with tile:
        with ui.element('div').classes('halon-share halon-host-share'):
            parts = {name: ui.element('div').classes('halon-share-part') for name in STATUS_ORDER}

    def fill(host: HostTile) -> None:
        shown['id'] = host.id
        show(host.name, host.caption, host.state)
        for name, part in parts.items():
            color = charts.TRACK_COLOR if name == 'unavailable' else STATUS_COLORS[name]
            part.style(f'flex-grow: {host.counts.get(name, 0)}; background: {color}')
            part.set_visibility(bool(host.counts.get(name)))

    return fill


def draw_finding_row() -> Callable[[FindingRow], None]:
    """One labeled bar of a scan's findings, with the counts printed beside it; returns the function
    that fills it from a FindingRow."""
    with ui.row().classes('halon-strip-row no-wrap'):
        name = ui.label().classes('halon-strip-label')
        with ui.element('div').classes('halon-share halon-finding-bar'):
            parts = [ui.element('div').classes('halon-share-part').style(f'background: {color}')
                     for color in FINDING_COLORS]
            clean = ui.element('div').classes('halon-share-part').style(
                f'flex-grow: 1; background: {STATUS_COLORS["online"]}')
        text = ui.label().classes('halon-strip-share')

    def fill(row: FindingRow) -> None:
        counts = (row.vulnerable, row.suspected, row.noted)
        name.text = row.name
        for part, count in zip(parts, counts):
            part.style(f'flex-grow: {count}')
            part.set_visibility(bool(count))
        clean.set_visibility(not any(counts))
        text.text = row.text

    return fill


def _legend(entries: List[Tuple[str, str]]):
    """A row of colored keys for a section whose shapes carry color."""
    with ui.row().classes('halon-legend'):
        for name, color in entries:
            with ui.element('span').classes('halon-legend-item'):
                ui.element('span').classes('halon-legend-swatch').style(f'background: {color}')
                ui.label(name)


def draw_backup_meter() -> Callable[[BackupRow], None]:
    """One backup's meter, in the accent while healthy and in its state's color otherwise; returns the
    function that fills it from a BackupRow."""
    show = charts.draw_meter_row(100.0 / BACKUP_SCALE)

    def fill(row: BackupRow) -> None:
        color = STATUS_COLORS[row.state] if row.state in ('warning', 'failed') else charts.color_for(None)
        show(row.label, row.value_text, row.percent, color)

    return fill


def draw_deploy_tile() -> Callable:
    """One deployment's tile; returns the function that fills it from a deploy tile row."""
    _, show = charts.draw_status_tile()
    return lambda tile: show(tile.name, tile.caption, tile.state)


def _render_reachability(strip_rows: List[StripRow]) -> list:
    """The reachability panel: one labeled strip per monitor under its host's name; returns the
    drawn rows for the refresh to fill."""
    drawn = []
    if not strip_rows:
        return drawn
    with card('w-full', title='Reachability'):
        with ui.element('div').classes('halon-strip-rows'):
            host = None
            for row in strip_rows:
                if row.host != host:
                    host = row.host
                    ui.label(host).classes(f'{LABEL_CLASS} halon-strip-group')
                drawn.append((row, *charts.strip_row(row.name), [None]))
    return drawn


def _render_section_boxes(types: set) -> Dict[str, Any]:
    """The backup, deployment and findings panels the fleet has monitors for, each an empty box
    the refresh fills; keyed by section name."""
    boxes = {}
    if types & {'borg', 'nixos_upgrade'}:
        with ui.row().classes('halon-grid'):
            if 'borg' in types:
                with card('flex-1 min-w-[320px]', title='Backups · time since newest archive'):
                    boxes['backups'] = ui.element('div').classes('halon-repeat-bars')
                    ui.label('A bar is half full at its max age and full at twice it.').classes('halon-caption')
            if 'nixos_upgrade' in types:
                with card('flex-1 min-w-[320px]', title='NixOS deployments'):
                    boxes['deploys'] = ui.element('div').classes('halon-repeat-tiles')
    if 'vuln_scan' in types:
        with card('w-full', title='Vulnerability findings'):
            _legend([('Vulnerable', FINDING_COLORS[0]), ('Likely', FINDING_COLORS[1]), ('Noted', FINDING_COLORS[2])])
            boxes['findings'] = ui.element('div').classes('halon-strip-rows')
    return boxes


def read_fleet(engine: Any, roots: list, sections: set, strip_rows: List[StripRow]) -> tuple:
    """Every section's rows from the latest readings, plus each strip's recent history."""
    db = engine.db
    statuses = db.latest_statuses()

    def latest(monitor_id, name):
        record = db.latest_metric(monitor_id, name)
        return record.value if record is not None else None

    builders = {
        'hosts': lambda: build_host_tiles(roots, statuses),
        'backups': lambda: build_backup_rows(roots, statuses, latest, time.time()),
        'deploys': lambda: build_deploy_tiles(roots, statuses, latest),
        'findings': lambda: build_finding_rows(roots, latest),
    }
    model = {name: build() for name, build in builders.items() if name in sections}
    histories = [[m.value for m in db.metric_history(row.id, row.metric, limit=charts.STRIP_CELLS)]
                 for row in strip_rows]
    return model, histories


def render_fleet(engine: Any, switch_view: Callable):
    """Render the fleet sections above the overview's charts and keep them current."""
    roots = primary_roots(engine)
    if not roots:
        return
    by_id = {monitor.id: monitor for monitor in iter_monitors(roots)}

    def open_host(host_id):
        if host_id in by_id:
            switch_view('plugin', by_id[host_id])

    boxes = {'hosts': ui.element('div').classes('halon-host-tiles')}
    drawn_strips = _render_reachability(build_strip_rows(roots))
    boxes.update(_render_section_boxes({monitor_type(m) for m in by_id.values()}))
    drawers = {
        'hosts': lambda: draw_host_tile(open_host),
        'backups': draw_backup_meter,
        'deploys': draw_deploy_tile,
        'findings': draw_finding_row,
    }
    slots = {name: ItemSlots(box, drawers[name]) for name, box in boxes.items()}

    async def update():
        model, histories = await offload(read_fleet)(engine, roots, set(boxes), [row for row, *_ in drawn_strips])
        for (_, strip, cell_elements, share_label, last_states), values in zip(drawn_strips, histories):
            charts.show_strip(strip, cell_elements, share_label, last_states, charts.strip_states(values))
        for name, rows in model.items():
            slots[name].show(rows)

    on_data_event(update)
