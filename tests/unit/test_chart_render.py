"""The chart widgets built from a UI_SPEC inside a real NiceGUI client: a gauge, a share bar,
an uptime strip, a multi-series chart, and meters and tiles over repeated items."""

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.connectors.types import CollectResult
from x_monitor.core.ui import spec
from x_monitor.core.ui.theme import STATUS_COLORS
from x_monitor.plugins.cpu import Cpu

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)

CHART_SPEC = {
    'layout': [['gauge', 'share'], ['strip'], ['strips'], ['bars', 'tiles'], ['lines']],
    'cards': {
        'gauge': {'kind': 'gauge', 'metric': 'cpu_pct', 'title': 'CPU', 'format': 'percent1',
                  'color': {'warning': 70, 'threshold': 85}},
        'share': {'kind': 'share', 'title': 'QUERIES', 'format': 'int',
                  'parts': [{'metric': 'allowed', 'label': 'Allowed'},
                            {'metric': 'blocked', 'label': 'Blocked', 'color': 'warning'}]},
        'strip': {'kind': 'strip', 'metric': 'up', 'title': 'AVAILABILITY', 'cells': 4},
        'strips': {'kind': 'strip', 'title': 'CHECKS', 'cells': 4,
                   'rows': [{'metric': 'ssh_up', 'label': 'SSH'}, {'metric': 'api_up', 'label': 'API'}]},
        'bars': {'title': 'SPACE USED', 'repeat': {
            'source': 'metrics_prefix', 'metrics_prefix': 'fs_', 'metrics_suffix': '_pct',
            'container': 'bars', 'item_format': 'percent0', 'bar_marker': 85}},
        'tiles': {'title': 'DISKS', 'repeat': {
            'source': 'metrics_prefix', 'metrics_prefix': 'disk_', 'metrics_suffix': '_ok',
            'container': 'tiles', 'item_format': 'int',
            'item_color_by': lambda item: 'online' if item['value'] else 'failed'}},
    },
    'charts': {
        'lines': {'title': 'LOAD', 'style': 'lines',
                  'series': [{'metric': 'load_1', 'label': '1m'}, {'metric': 'load_5', 'label': '5m'}]},
    },
}


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Cpu, {"name": "probe", "id": "probe", "ssh_config": {"host": "test.host"}})


@pytest.fixture
def render_page(plugin):
    built = {}

    @ui.page('/')
    def _page():
        from nicegui import context
        built['page'] = spec.generic_render(plugin, spec=CHART_SPEC, start=False)
        built['client'] = context.client

    return built


async def _ticked(user: User, built: dict):
    await user.open('/')
    await built['page']._tick()
    return built


def _by_class(built: dict, css_class: str) -> list:
    return [e for e in built['client'].elements.values() if css_class in e._classes]


def _texts(built: dict, css_class: str) -> list:
    return [e.text for e in _by_class(built, css_class)]


class TestGauge:
    async def test_the_value_is_printed_inside_the_arc(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'cpu_pct': 78.0}, status='warning'))
        built = await _ticked(user, render_page)
        assert _texts(built, 'halon-gauge-value') == ['78.0%']

    async def test_the_arc_takes_the_status_color_and_fills_its_share(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'cpu_pct': 78.0}, status='warning'))
        built = await _ticked(user, render_page)
        arc = _by_class(built, 'halon-gauge-arc')[0]
        assert STATUS_COLORS['warning'] in arc._style['background']
        assert '210.6deg' in arc._style['background']

    async def test_the_value_is_styled_like_any_other_stat(self, user: User, render_page):
        built = await _ticked(user, render_page)
        assert 'halon-value' in _by_class(built, 'halon-gauge-value')[0]._classes

    async def test_the_panel_is_a_stat_panel_so_it_matches_its_neighbours(self, user: User, render_page):
        built = await _ticked(user, render_page)
        assert 'halon-stat' in _by_class(built, 'halon-gauge-card')[0]._classes

    async def test_no_reading_leaves_the_arc_empty(self, user: User, render_page):
        built = await _ticked(user, render_page)
        assert _texts(built, 'halon-gauge-value') == ['-- %']
        assert '0.0deg' in _by_class(built, 'halon-gauge-arc')[0]._style['background']


class TestShare:
    async def test_each_part_grows_to_its_share(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'allowed': 3.0, 'blocked': 1.0}, status='online'))
        built = await _ticked(user, render_page)
        grows = [e._style['flex-grow'] for e in _by_class(built, 'halon-share-part')]
        assert grows == ['75.00', '25.00']

    async def test_the_title_is_a_stat_label_rather_than_a_header_strip(self, user: User, render_page):
        built = await _ticked(user, render_page)
        panel = _by_class(built, 'halon-share-card')[0]
        assert 'halon-stat' in panel._classes
        assert 'QUERIES' not in _texts(built, 'halon-card-title')
        assert 'QUERIES' in _texts(built, 'halon-label')

    async def test_the_legend_prints_every_parts_value(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'allowed': 3.0, 'blocked': 1.0}, status='online'))
        built = await _ticked(user, render_page)
        legend = [e.text for e in built['client'].elements.values()
                  if getattr(e, 'text', None) in ('Allowed 3', 'Blocked 1')]
        assert sorted(legend) == ['Allowed 3', 'Blocked 1']


class TestStrip:
    async def test_the_up_share_counts_only_measured_checks(self, user: User, plugin, render_page):
        for up in (1.0, 0.0, 1.0):
            plugin.storage.apply(CollectResult(metrics={'up': up}, status='online'))
        built = await _ticked(user, render_page)
        assert _texts(built, 'halon-strip-share')[0] == '66.7% up'

    async def test_a_down_check_is_drawn_in_the_failed_color(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'up': 0.0}, status='failed'))
        built = await _ticked(user, render_page)
        assert STATUS_COLORS['failed'] in _by_class(built, 'halon-strip')[0]._style['background']

    async def test_a_single_strip_carries_no_row_label(self, user: User, render_page):
        built = await _ticked(user, render_page)
        assert _texts(built, 'halon-strip-label') == ['SSH', 'API']

    async def test_each_row_of_a_panel_reads_its_own_metric(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'up': 1.0, 'ssh_up': 1.0, 'api_up': 0.0}, status='failed'))
        built = await _ticked(user, render_page)
        assert _texts(built, 'halon-strip-share') == ['100.0% up', '100.0% up', '0.0% up']


class TestRepeatPanels:
    async def test_each_item_is_a_meter_filled_to_its_value(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'fs_root_pct': 41.0, 'fs_storage_pct': 78.0},
                                           status='online'))
        built = await _ticked(user, render_page)
        assert _texts(built, 'halon-meter-label') == ['root', 'storage']
        assert _texts(built, 'halon-meter-value') == ['41%', '78%']
        widths = [e._style['width'] for e in _by_class(built, 'halon-meter-fill')]
        assert widths == ['41.0%', '78.0%']

    async def test_a_meter_draws_its_warning_tick(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'fs_root_pct': 41.0}, status='online'))
        built = await _ticked(user, render_page)
        assert _by_class(built, 'halon-meter-marker')[0]._style['left'] == '85.0%'

    async def test_each_item_is_a_tile_in_its_state_color(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'disk_sda_ok': 1.0, 'disk_sdb_ok': 0.0},
                                           status='failed'))
        built = await _ticked(user, render_page)
        tiles = _by_class(built, 'halon-tile')
        assert [t._style['--halon-tile-color'] for t in tiles] == [
            STATUS_COLORS['online'], STATUS_COLORS['failed']]
        assert _texts(built, 'halon-tile-label') == ['sda', 'sdb']

    async def test_the_panel_carries_the_cards_title(self, user: User, plugin, render_page):
        built = await _ticked(user, render_page)
        titles = _texts(built, 'halon-card-title')
        assert 'SPACE USED' in titles and 'DISKS' in titles


class TestSeriesChart:
    async def test_every_series_is_drawn_on_the_first_ones_timestamps(self, user: User, plugin, render_page):
        for one, five in ((0.5, 0.4), (0.7, 0.45)):
            plugin.storage.apply(CollectResult(metrics={'load_1': one, 'load_5': five}, status='online'))
        built = await _ticked(user, render_page)
        chart = next(e for e in built['client'].elements.values() if type(e).__name__ == 'EChart')
        series = chart.options['series']
        assert [s['name'] for s in series] == ['1m', '5m']
        assert [s['data'] for s in series] == [[0.5, 0.7], [0.4, 0.45]]
        assert len(chart.options['xAxis']['data']) == 2
