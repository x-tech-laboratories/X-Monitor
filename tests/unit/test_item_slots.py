"""A list of drawn items that refills its widgets in place, redrawing only when the number of items changes."""

import pytest
from nicegui import context, ui
from nicegui.testing import User

from x_monitor.core.ui.components import ItemSlots

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)


def draw_label():
    label = ui.label().classes('probe-item')

    def show(item):
        label.text = item

    return show


@pytest.fixture
def render_page():
    built = {}

    @ui.page('/')
    def _page():
        built['slots'] = ItemSlots(ui.element('div'), draw_label, empty_text='Nothing yet')
        built['client'] = context.client

    return built


def _items(built: dict) -> list:
    return [e for e in built['client'].elements.values() if 'probe-item' in e._classes]


def _captions(built: dict) -> list:
    return [e.text for e in built['client'].elements.values() if 'halon-caption' in e._classes]


async def test_each_item_gets_a_widget_filled_from_it(user: User, render_page):
    await user.open('/')
    render_page['slots'].show(['a', 'b'])
    assert [e.text for e in _items(render_page)] == ['a', 'b']


async def test_new_values_refill_the_same_widgets(user: User, render_page):
    await user.open('/')
    render_page['slots'].show(['a', 'b'])
    ids = [e.id for e in _items(render_page)]

    render_page['slots'].show(['c', 'd'])

    assert [e.id for e in _items(render_page)] == ids
    assert [e.text for e in _items(render_page)] == ['c', 'd']


async def test_another_number_of_items_redraws_the_list(user: User, render_page):
    await user.open('/')
    render_page['slots'].show(['a', 'b'])
    render_page['slots'].show(['a', 'b', 'c'])
    assert [e.text for e in _items(render_page)] == ['a', 'b', 'c']


async def test_no_items_shows_the_empty_text(user: User, render_page):
    await user.open('/')
    render_page['slots'].show([])
    assert _captions(render_page) == ['Nothing yet']

    render_page['slots'].show(['a'])
    assert _captions(render_page) == []
    assert [e.text for e in _items(render_page)] == ['a']
