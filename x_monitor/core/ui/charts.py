"""Chart widgets a UI_SPEC can ask for in place of plain value cards: gauges, multi-series
history charts, meters, status tiles, uptime strips and share bars.

Everything except the history chart is ordinary DOM painted with Halon's CSS variables, so it
follows the client's scheme with no repaint. The history chart is ECharts, which paints to a
canvas, so it takes literal colors from ``theme.palette()`` like ``history_chart`` does.
"""

from typing import Callable, List, Optional, Sequence

from nicegui import ui

from x_monitor.core.ui import theme
from x_monitor.core.ui.components import LABEL_CLASS, VALUE_CLASS, card, offload
from x_monitor.core.ui.theme import STATUS_COLORS

# ============================================================================
# Shared geometry
# ============================================================================

# A gauge's arc opens at the bottom and sweeps this many degrees clockwise from its left end.
GAUGE_SWEEP_DEGREES = 270

# How many past readings an uptime strip draws, one cell each.
STRIP_CELLS = 60

# The colors a widget may name by word instead of by status.
NAMED_COLORS = {
    'accent': theme.ACCENT,
    'series-1': 'var(--series-1)',
    'series-2': 'var(--series-2)',
    'series-3': 'var(--series-3)',
    'neutral': theme.TEXT_TERTIARY,
}

TRACK_COLOR = theme.SURFACE_SECONDARY


def fill_percent(value: Optional[float], maximum: float = 100.0) -> float:
    """How full a bar or gauge is, as a percentage clamped to 0–100; no reading is empty."""
    if value is None or not maximum:
        return 0.0
    return max(0.0, min(100.0, value / maximum * 100.0))


def color_for(name: Optional[str], default: str = theme.ACCENT) -> str:
    """The CSS color for a status name or a named color, falling back to the accent."""
    if name in STATUS_COLORS:
        return STATUS_COLORS[name]
    return NAMED_COLORS.get(name, default)


def gauge_style(percent: float, color: str) -> str:
    """The conic gradient that draws a gauge's arc, filled to `percent` of its sweep."""
    filled = GAUGE_SWEEP_DEGREES * percent / 100.0
    start = 180 + (360 - GAUGE_SWEEP_DEGREES) / 2
    return (f'background: conic-gradient(from {start:.0f}deg, {color} 0deg {filled:.1f}deg, '
            f'{TRACK_COLOR} {filled:.1f}deg {GAUGE_SWEEP_DEGREES}deg, '
            f'transparent {GAUGE_SWEEP_DEGREES}deg)')


def strip_states(values: Sequence[Optional[float]], up_above: float = 0.5,
                 cells: int = STRIP_CELLS) -> List[str]:
    """One state per strip cell, oldest first: online above `up_above`, failed at or below it,
    unavailable where there is no reading yet."""
    states = ['online' if v is not None and v > up_above else
              'unavailable' if v is None else 'failed' for v in values][-cells:]
    return ['unavailable'] * (cells - len(states)) + states


def up_share(states: Sequence[str]) -> Optional[float]:
    """The share of measured cells that were up, as a percentage, or None before any reading."""
    measured = [s for s in states if s != 'unavailable']
    if not measured:
        return None
    return 100.0 * sum(s == 'online' for s in measured) / len(measured)


def strip_style(states: Sequence[str]) -> str:
    """A hard-stop gradient drawing one cell per state with a hairline gap between cells."""
    width = 100.0 / len(states)
    gap = min(0.4, width * 0.25)
    stops = []
    for index, state in enumerate(states):
        left, right = index * width, (index + 1) * width - gap
        color = TRACK_COLOR if state == 'unavailable' else STATUS_COLORS[state]
        stops.append(f'{color} {left:.2f}% {right:.2f}%, transparent {right:.2f}% {right + gap:.2f}%')
    return f'background: linear-gradient(to right, {", ".join(stops)})'


def share_percents(values: Sequence[Optional[float]]) -> List[float]:
    """Each part's share of the whole, as percentages; all zero while there is nothing to share."""
    parts = [max(0.0, v or 0.0) for v in values]
    total = sum(parts)
    if not total:
        return [0.0] * len(parts)
    return [100.0 * p / total for p in parts]


# ============================================================================
# Gauge card
# ============================================================================

def render_gauge(page, title: str, metric_name: str, formatter: Callable,
                 color_rule: Optional[Callable], maximum: float = 100.0,
                 caption: Optional[str] = None):
    """A stat panel with its label and value laid out like any other, and a small arc beside them
    filled by the metric's share of `maximum`, colored by the card's status rule or the accent."""
    with card('halon-stat halon-gauge-card flex-1 min-w-[12rem]'):
        with ui.row().classes('halon-gauge-row no-wrap'):
            with ui.column().classes('halon-gauge-text'):
                ui.label(title).classes(LABEL_CLASS)
                value_label = ui.label(formatter(None)).classes(f'{VALUE_CLASS} halon-gauge-value')
                caption_label = ui.label(caption or '').classes('halon-caption')
                caption_label.set_visibility(bool(caption))
            arc = ui.element('div').classes('halon-gauge-arc')
    arc.style(gauge_style(0, theme.ACCENT))
    last = [None]

    def update():
        value = page.model.metrics.get(metric_name)
        if value == last[0]:
            return
        last[0] = value
        state = color_rule(value) if color_rule else None
        value_label.text = formatter(value)
        arc.style(gauge_style(fill_percent(value, maximum), color_for(state)))

    return update


# ============================================================================
# Share bar card
# ============================================================================

def render_share(page, title: str, parts: List[dict], formatter: Callable):
    """One bar split into the parts' shares of their total, with each part's value printed in
    the legend beneath, since a share alone never says how many."""
    with card('halon-stat halon-share-card flex-1 min-w-[16rem] w-full'):
        ui.label(title).classes(LABEL_CLASS)
        with ui.element('div').classes('halon-share'):
            segments = [ui.element('div').classes('halon-share-part')
                        .style(f'background: {color_for(p.get("color"), NAMED_COLORS["series-1"])}; flex-grow: 0')
                        for p in parts]
        with ui.row().classes('halon-legend'):
            legends = []
            for p in parts:
                with ui.element('span').classes('halon-legend-item'):
                    ui.element('span').classes('halon-legend-swatch').style(
                        f'background: {color_for(p.get("color"), NAMED_COLORS["series-1"])}')
                    legends.append(ui.label(f'{p["label"]} {formatter(None)}'))
    last = [None]

    def update():
        values = [page.model.metrics.get(p['metric']) for p in parts]
        if values == last[0]:
            return
        last[0] = values
        for segment, share in zip(segments, share_percents(values)):
            segment.style(f'flex-grow: {share:.2f}')
        for legend, p, value in zip(legends, parts, values):
            legend.text = f'{p["label"]} {formatter(value)}'

    return update


# ============================================================================
# Uptime strip card
# ============================================================================

def render_strip(page, title: str, plugin_id: str, rows: List[dict],
                 up_above: float = 0.5, cells: int = STRIP_CELLS):
    """The last `cells` readings of each row's 0/1 metric as a row of up and down cells, with
    the share of them that were up printed beside it; several rows share one panel, each
    labeled."""
    labeled = len(rows) > 1 or bool(rows and rows[0].get('label'))
    drawn = []
    with card('w-full', title=title):
        with ui.element('div').classes('halon-strip-rows'):
            for row in rows:
                with ui.row().classes('halon-strip-row no-wrap'):
                    if labeled:
                        ui.label(row.get('label', row['metric'])).classes('halon-strip-label')
                    strip = ui.element('div').classes('halon-strip')
                    share_label = ui.label('--').classes('halon-strip-share')
                drawn.append((row['metric'], strip, share_label, [None]))

    def read():
        return [[m.value for m in page.plugin.data.metric_history(plugin_id, metric, limit=cells)]
                for metric, _, _, _ in drawn]

    async def update():
        for (_, strip, share_label, last), values in zip(drawn, await offload(read)()):
            states = strip_states(values, up_above, cells)
            if states == last[0]:
                continue
            last[0] = states
            strip.style(strip_style(states))
            share = up_share(states)
            share_label.text = '--' if share is None else f'{share:.1f}% up'
            strip.props(f'aria-label="{share_label.text} over the last {cells} checks" role="img"')

    page.on_refresh(update)


# ============================================================================
# Meters and tiles for repeated items
# ============================================================================

def meter_row(label: str, value_text: str, percent: float, color: str,
              marker: Optional[float] = None):
    """One labeled 6px meter: the label and its printed value above, the fill below, and an
    optional tick at the warning level."""
    with ui.element('div').classes('halon-meter-row'):
        with ui.row().classes('halon-meter-head no-wrap'):
            ui.label(label).classes('halon-meter-label')
            ui.label(value_text).classes('halon-meter-value')
        with ui.element('div').classes('halon-meter'):
            ui.element('div').classes('halon-meter-fill').style(
                f'width: {percent:.1f}%; background: {color}')
            if marker is not None:
                ui.element('div').classes('halon-meter-marker').style(f'left: {marker:.1f}%')


def status_tile(label: str, value_text: str, state: Optional[str]):
    """One item as a small tile: a status dot and its name, with its value as the caption."""
    color = STATUS_COLORS.get(state or 'unavailable', STATUS_COLORS['unavailable'])
    with ui.element('div').classes('halon-tile').style(f'--halon-tile-color: {color}'):
        with ui.row().classes('halon-tile-head no-wrap'):
            ui.element('span').classes('halon-tile-dot')
            ui.label(label).classes('halon-tile-label')
        ui.label(value_text).classes('halon-caption')


# ============================================================================
# Multi-series history chart
# ============================================================================

SERIES_STYLES = ('lines', 'stack', 'mirror')


def series_options(style: str, labels: List[str]) -> dict:
    """The ECharts options for a multi-series chart before any data or colors arrive.
    'stack' piles the series as filled areas; 'mirror' draws the second series below the axis."""
    series = []
    for index, label in enumerate(labels):
        entry = {'name': label, 'type': 'line', 'smooth': True, 'showSymbol': False, 'data': []}
        if style == 'stack':
            entry.update(stack='total', areaStyle={'opacity': 0.35})
        elif style == 'mirror' or index == 0:
            entry['areaStyle'] = {'opacity': 0.15}
        series.append(entry)
    options = {
        'tooltip': {'trigger': 'axis'},
        'legend': {'data': labels, 'top': 0, 'right': 0, 'icon': 'roundRect',
                   'itemWidth': 10, 'itemHeight': 4},
        'grid': {'left': 4, 'right': 8, 'top': 28, 'bottom': 4, 'containLabel': True},
        'xAxis': {'type': 'category', 'data': []},
        'yAxis': {'type': 'value', 'splitLine': {'show': False}},
        'series': series,
    }
    if style == 'mirror':
        # The lower series is stored negated so it hangs below the axis; labels show its size.
        options['yAxis']['axisLabel'] = {':formatter': 'value => Math.abs(value)'}
        options['tooltip'][':valueFormatter'] = 'value => Math.abs(value)'
    return options


def align_series(histories: List[List[tuple]]) -> tuple:
    """Line several metric histories up on the first one's timestamps, newest last, padding a
    shorter history at its old end with gaps."""
    if not histories or not histories[0]:
        return [], [[] for _ in histories]
    times = [stamp for stamp, _ in histories[0]]
    columns = []
    for history in histories:
        values = [value for _, value in history][-len(times):]
        columns.append([None] * (len(times) - len(values)) + values)
    return times, columns


def series_chart(page, title: str, plugin_id: str, series: List[dict],
                 style: str = 'lines', limit: int = 30):
    """Several metrics' recent history on one chart, repainted on push and scheme flips."""
    if style not in SERIES_STYLES:
        raise ValueError(f'chart style {style!r} is not one of {SERIES_STYLES}')
    labels = [s.get('label', s['metric']) for s in series]
    with card('w-full', title=title):
        chart = ui.echart(series_options(style, labels)).classes('w-full h-64')

    def repaint(colors):
        chart.options['textStyle'] = {'fontFamily': colors.get('font', 'sans-serif')}
        chart.options['legend']['textStyle'] = {'color': colors['text_secondary']}
        for entry, color in zip(chart.options['series'], colors['series']):
            entry['color'] = color
        for axis in ('xAxis', 'yAxis'):
            chart.options[axis]['axisLine'] = {'lineStyle': {'color': colors['border']}}
            chart.options[axis].setdefault('axisLabel', {})['color'] = colors['text_secondary']
        chart.update()

    theme.on_scheme_change(repaint)

    def read():
        histories = [[(m.timestamp.strftime('%H:%M:%S'), m.value)
                      for m in page.plugin.data.metric_history(plugin_id, s['metric'], limit=limit)]
                     for s in series]
        times, columns = align_series(histories)
        if style == 'mirror' and len(columns) > 1:
            columns[1] = [None if v is None else -v for v in columns[1]]
        return times, columns

    async def update():
        times, columns = await offload(read)()
        current = [entry['data'] for entry in chart.options['series']]
        if times == chart.options['xAxis']['data'] and columns == current:
            return
        chart.options['xAxis']['data'] = times
        for entry, column in zip(chart.options['series'], columns):
            entry['data'] = column
        chart.update()

    page.on_refresh(update)
    return chart


# ============================================================================
# Spec dispatch
# ============================================================================

# Card kinds this module renders, by the value of a card spec's 'kind'.
CARD_KINDS = ('gauge', 'share', 'strip')


def card_metric_names(card_spec: dict) -> List[str]:
    """The metrics a chart card reads from the page model on every refresh."""
    kind = card_spec.get('kind')
    if kind == 'gauge':
        return [card_spec['metric']]
    if kind == 'share':
        return [p['metric'] for p in card_spec['parts']]
    return []


def render_chart_card(plugin, page, widget_name: str, card_spec: dict,
                      formatter: Callable, color_rule: Optional[Callable]) -> Optional[Callable]:
    """Render a card whose spec names a chart kind, returning its refresh update if it has one."""
    kind = card_spec['kind']
    title = card_spec['title']
    if kind == 'gauge':
        return render_gauge(page, title, card_spec['metric'], formatter, color_rule,
                            maximum=card_spec.get('max', 100.0), caption=card_spec.get('caption'))
    if kind == 'share':
        return render_share(page, title, card_spec['parts'], formatter)
    if kind == 'strip':
        rows = card_spec.get('rows') or [{'metric': card_spec['metric']}]
        render_strip(page, title, plugin.id, rows,
                     up_above=card_spec.get('up_above', 0.5),
                     cells=card_spec.get('cells', STRIP_CELLS))
        return None
    raise KeyError(f'UI_SPEC card {widget_name!r} has unknown kind {kind!r}; expected one of {CARD_KINDS}')
