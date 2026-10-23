"""generic_render building a real card, inside a real NiceGUI client.

Every other spec test asserts on the UI_SPEC dict or on a resolved rule; this
one renders one and colors it, so a card's inline thresholds are proven against
the widgets a viewer actually gets rather than against the dict describing them.
"""

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.connectors.types import CollectResult
from x_monitor.core.ui import spec
from x_monitor.core.ui.theme import STATUS_COLORS
from x_monitor.plugins.cpu import Cpu

# The user fixture only — nicegui.testing.plugin also pulls in its selenium Screen plugin.
pytest_plugins = ['nicegui.testing.user_plugin']

# No app main file to auto-import: the page under test is declared in this module.
pytestmark = pytest.mark.nicegui_main_file(None)


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Cpu, {"name": "probe", "id": "probe", "warning": 70, "threshold": 85,
                             "ssh_config": {"host": "test.host"}})


@pytest.fixture
def render_page(plugin):
    """Serve the plugin's declarative UI at '/', handing the test its PluginPage.

    `start=False` keeps the page off the client's refresh scheduler, so the test
    ticks it itself and nothing fires between assertions.
    """
    built = {}
    # The CPU page draws a gauge, so a plain metric card with the plugin's own thresholds is declared here.
    metric_card_spec = {
        'layout': [['cpu_card']],
        'cards': {'cpu_card': {'metric': 'cpu_pct', 'title': 'CPU', 'format': 'percent1',
                               'color': {'warning': plugin.warning, 'threshold': plugin.threshold}}},
    }

    @ui.page('/')
    def _page():
        from nicegui import context
        built['page'] = spec.generic_render(plugin, spec=metric_card_spec, start=False)
        built['client'] = context.client

    return built


async def _ticked(user: User, built: dict, page_path: str = '/'):
    """Open the page, run one refresh, and let the bindings settle.

    A colored card has two halves: the value arrives through a NiceGUI binding
    and the color is set by the refresh callback. Stepping the binding loop by
    hand keeps both readable in the same assertion without sleeping on its timer.
    """
    from nicegui import binding
    await user.open(page_path)
    await built['page']._tick()
    binding._refresh_step()
    return built


def _cpu_label(built: dict):
    """The CPU card's value label — the one bound to the cpu_pct metric."""
    from nicegui.elements.label import Label
    labels = [e for e in built['client'].elements.values()
              if isinstance(e, Label) and '%' in (e.text or '')]
    assert labels, "no formatted percentage label was rendered"
    return labels[0]


class TestInlineThresholdColoring:
    async def test_a_reading_under_the_warning_renders_online(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'cpu_pct': 12.0}, status='online'))
        built = await _ticked(user, render_page)
        label = _cpu_label(built)
        assert label.text == '12.0%'
        assert STATUS_COLORS['online'] in label._style['color']

    async def test_a_reading_past_the_threshold_renders_failed(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'cpu_pct': 97.5}, status='failed'))
        built = await _ticked(user, render_page)
        label = _cpu_label(built)
        assert label.text == '97.5%'
        assert STATUS_COLORS['failed'] in label._style['color']

    async def test_a_reading_between_the_bounds_renders_warning(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'cpu_pct': 78.0}, status='warning'))
        built = await _ticked(user, render_page)
        assert STATUS_COLORS['warning'] in _cpu_label(built)._style['color']

    async def test_a_reading_past_the_threshold_tints_the_card(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'cpu_pct': 97.5}, status='failed'))
        built = await _ticked(user, render_page)
        from x_monitor.core.ui.components import card_of
        assert 'halon-card--failed' in card_of(_cpu_label(built))._classes

    async def test_a_reading_under_the_warning_leaves_the_card_plain(self, user: User, plugin, render_page):
        plugin.storage.apply(CollectResult(metrics={'cpu_pct': 12.0}, status='online'))
        built = await _ticked(user, render_page)
        from x_monitor.core.ui.components import card_of
        classes = card_of(_cpu_label(built))._classes
        assert 'halon-card--failed' not in classes and 'halon-card--warning' not in classes

    async def test_no_reading_leaves_the_card_uncolored(self, user: User, render_page):
        built = await _ticked(user, render_page)
        label = _cpu_label(built)
        assert label.text == '-- %'
        assert 'color' not in label._style


def _bar_fills(built: dict) -> list:
    """Every per-core bar's fill element, in render order."""
    return [e for e in built['client'].elements.values() if 'halon-meter-fill' in e._classes]


@pytest.fixture
def cores_page(plugin):
    """Serve only the CPU page's per-core panel, as the plugin's own UI_SPEC declares it."""
    built = {}
    cores_spec = {'layout': [['cores']], 'cards': {'cores': plugin.UI_SPEC['cards']['cores']}}

    @ui.page('/')
    def _page():
        from nicegui import context
        built['page'] = spec.generic_render(plugin, spec=cores_spec, start=False)
        built['client'] = context.client

    return built


class TestPerCoreBars:
    async def test_each_core_gets_a_bar_filled_to_its_share(self, user: User, plugin, cores_page):
        plugin.storage.apply(CollectResult(
            metrics={'cpu_pct': 50.0}, status='online',
            snapshot=[{'label': '0', 'value': 20.0}, {'label': '1', 'value': 90.0}]))
        built = await _ticked(user, cores_page)
        assert [f._style['width'] for f in _bar_fills(built)] == ['20.0%', '90.0%']

    async def test_a_busy_core_is_filled_with_the_failed_color(self, user: User, plugin, cores_page):
        plugin.storage.apply(CollectResult(
            metrics={'cpu_pct': 50.0}, status='online',
            snapshot=[{'label': '0', 'value': 10.0}, {'label': '1', 'value': 99.0}]))
        built = await _ticked(user, cores_page)
        idle, busy = _bar_fills(built)
        assert STATUS_COLORS['online'] in idle._style['background']
        assert STATUS_COLORS['failed'] in busy._style['background']

    async def test_no_snapshot_renders_no_bars(self, user: User, cores_page):
        built = await _ticked(user, cores_page)
        assert _bar_fills(built) == []


class TestFormInputs:
    async def test_select_checkbox_and_text_fields(self, user: User):
        from types import SimpleNamespace
        from nicegui.elements.checkbox import Checkbox
        from nicegui.elements.input import Input
        from nicegui.elements.select import Select
        from x_monitor.core.ui.components import _form_input
        plugin = SimpleNamespace(entries={'0001': 'Linux', '0003': 'Windows'}, chosen='0003')
        built = {}

        @ui.page('/form')
        def _page():
            built['select'] = _form_input(plugin, {'name': 'entry', 'options_attr': 'entries',
                                                   'default_attr': 'chosen'})
            built['fallback'] = _form_input(plugin, {'name': 'p', 'options': ['a', 'b'], 'default': 'z'})
            built['checkbox'] = _form_input(plugin, {'name': 'reboot', 'type': 'checkbox'})
            built['text'] = _form_input(plugin, {'name': 'path', 'default': '/etc'})

        await user.open('/form')
        assert isinstance(built['select'], Select) and built['select'].value == '0003'
        assert built['fallback'].value == 'a'
        assert isinstance(built['checkbox'], Checkbox) and built['checkbox'].value is False
        assert isinstance(built['text'], Input) and built['text'].value == '/etc'


class TestHostControlPage:
    async def test_renders_its_cards_buttons_and_boot_table(self, user: User, make_plugin):
        from nicegui.elements.button import Button
        from nicegui.elements.table import Table
        from x_monitor.core.connectors.types import CmdResult
        from x_monitor.plugins.host_control import HostControl
        control = make_plugin(HostControl, {"name": "host1 control", "id": "host1-control",
                                            "allow": ["reboot", "next_boot"],
                                            "ssh_config": {"host": "host1"}})
        boot = ('loader=efi\n@@entries\nBootOrder: 0001\n'
                'Boot0001* Linux Boot Manager\tHD(1)\nBoot0003* Windows Boot Manager\tHD(1)\n')
        control.storage.apply(control.parse([CmdResult(0, "backend=none", ""), CmdResult(0, boot, ""),
                                             CmdResult(0, "mem", "")]))
        built = {}

        @ui.page('/control')
        def _page():
            from nicegui import context
            built['page'] = spec.generic_render(control, start=False)
            built['client'] = context.client

        await _ticked(user, built, '/control')
        await user.should_see('Linux Boot Manager')
        elements = list(built['client'].elements.values())
        labels = [e.text for e in elements if isinstance(e, Button) and getattr(e, 'text', '')]
        assert 'Reboot' in labels and 'Next Boot' in labels
        assert 'Shut Down' not in labels
        table = next(e for e in elements if isinstance(e, Table)
                     and any(c['name'] == 'next' for c in e.columns))
        assert [r['id'] for r in table.rows] == ['0001', '0003']


@pytest.fixture
def self_page(make_plugin):
    """The self-monitor's page, whose timings table colors cells with a callable rule."""
    from x_monitor.plugins.x_monitor_self import XMonitorSelfPlugin
    plugin = make_plugin(XMonitorSelfPlugin, {"name": "x-monitor", "id": "x-monitor"})
    built = {'plugin': plugin}

    @ui.page('/self')
    def _page():
        from nicegui import context
        built['page'] = spec.generic_render(plugin, start=False)
        built['client'] = context.client

    yield built
    XMonitorSelfPlugin.engine = None


class TestCallableCellColors:
    async def test_the_table_sent_to_the_browser_carries_no_function(self, user: User, self_page):
        from nicegui import json
        self_page['plugin'].storage.snapshot([
            {'id': 'crawl', 'name': 'crawl', 'interval': 10, 'last': 6.0, 'avg': 6.0, 'max': 6.0,
             'wait': 0.0, 'share': 60.0, 'slow': True}])
        built = await _ticked(user, self_page, '/self')
        tables = [e for e in built['client'].elements.values() if isinstance(e, ui.table)
                  and any(col['name'] == 'avg' for col in e._props['columns'])]
        assert tables, "the timings table was not rendered"
        table = tables[0]
        assert all('cell_color_by' not in col for col in table._props['columns'])
        json.dumps(table._props)
        assert table.rows[0]['_color_name'] == STATUS_COLORS['warning']
