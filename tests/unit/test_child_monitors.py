"""Any monitor can hold child monitors: it polls them first, reads their statuses and shows them."""

from unittest.mock import MagicMock

from x_monitor.plugins.base.child_cards import child_cell_style
from x_monitor.plugins.base.plugin_base import Plugin


class _Parent(Plugin):
    """A monitor of no particular kind, standing in for any plugin that has children."""


def _child(child_id, order):
    async def cycle():
        order.append(child_id)
        return True
    child = MagicMock()
    child.id = child_id
    child.name = child_id
    child.run_cycle = cycle
    return child


class TestPollingAParent:
    async def test_any_monitor_polls_its_children_before_itself(self, make_plugin):
        parent = make_plugin(_Parent)
        order = []
        parent.children = [_child('a', order), _child('b', order)]
        parent.engine = MagicMock()

        async def own_cycle(plugin):
            order.append('parent')
            return True
        parent.engine.run_cycle_now = own_cycle

        assert await parent.run_cycle() is True
        assert order[-1] == 'parent' and sorted(order[:-1]) == ['a', 'b']

    async def test_a_monitor_without_children_just_polls_itself(self, make_plugin):
        parent = make_plugin(_Parent)
        parent.engine = MagicMock()

        async def own_cycle(plugin):
            return False
        parent.engine.run_cycle_now = own_cycle

        assert await parent.run_cycle() is False


class TestChildStatuses:
    def test_each_child_maps_to_its_latest_status(self, make_plugin, db_manager):
        parent = make_plugin(_Parent)
        db_manager.insert_status('a', 'failed')
        parent.children = [_child('a', []), _child('never-polled', [])]
        assert parent.child_statuses() == {'a': 'failed', 'never-polled': 'unavailable'}

    def test_a_plain_monitor_does_not_restate_its_children(self, make_plugin):
        assert make_plugin(_Parent).restates_children is False


class TestChildCellStyle:
    def test_a_child_spans_its_columns_at_the_parent_minimum_width(self):
        style = child_cell_style({'grid_col_span': 2}, '320px')
        assert style == 'flex: 2 1 calc(2 * 320px); min-width: 320px;'

    def test_a_child_height_adds_a_scrollbar(self):
        assert child_cell_style({'grid_height': '400px'}, '320px').endswith(' height: 400px; overflow-y: auto;')
