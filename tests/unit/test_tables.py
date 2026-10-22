"""Multi-column sorting and filtering shared by every dashboard table."""

import pytest
from nicegui import ui
from nicegui.testing import User

from x_monitor.core.ui.tables import data_table, filter_rows, next_sort_keys, set_rows, sort_rows, tree_rows

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)

COLUMNS = [
    {'name': 'host', 'label': 'Host', 'field': 'host'},
    {'name': 'status', 'label': 'Status', 'field': 'status'},
    {'name': 'size', 'label': 'Size', 'field': 'size', 'sort_field': 'size_bytes'},
    {'name': 'actions', 'label': '', 'field': 'actions', 'sortable': False},
]

ROWS = [
    {'host': 'host10', 'status': 'online', 'size': '2 KB', 'size_bytes': 2048},
    {'host': 'host9', 'status': 'failed', 'size': '900 B', 'size_bytes': 900},
    {'host': 'host2', 'status': 'online', 'size': '', 'size_bytes': None},
]


# ===== Row ordering =====

def test_sort_rows_uses_the_first_key_then_the_next():
    ordered = sort_rows(ROWS, [('status', False), ('host', True)], COLUMNS)
    assert [r['host'] for r in ordered] == ['host9', 'host10', 'host2']


def test_sort_rows_orders_numbers_inside_text_naturally():
    assert [r['host'] for r in sort_rows(ROWS, [('host', False)], COLUMNS)] == ['host2', 'host9', 'host10']


def test_sort_rows_uses_the_raw_sort_field_and_keeps_empty_cells_last_both_ways():
    assert [r['host'] for r in sort_rows(ROWS, [('size', False)], COLUMNS)] == ['host9', 'host10', 'host2']
    assert [r['host'] for r in sort_rows(ROWS, [('size', True)], COLUMNS)] == ['host10', 'host9', 'host2']


def test_sort_rows_copes_with_numbers_and_text_in_one_column():
    rows = [{'v': 'abc'}, {'v': 3}, {'v': None}, {'v': 1.5}]
    assert [r['v'] for r in sort_rows(rows, [('v', False)], [{'name': 'v', 'field': 'v'}])] == [1.5, 3, 'abc', None]


def test_filter_rows_needs_every_word_somewhere_in_the_fields():
    assert [r['host'] for r in filter_rows(ROWS, 'ONLINE host1', ['host', 'status'])] == ['host10']
    assert filter_rows(ROWS, '  ', ['host']) == ROWS


# ===== Header clicks =====

def test_a_plain_click_steps_one_column_from_ascending_to_descending_to_off():
    keys = next_sort_keys([], 'host', add=False)
    assert keys == [('host', False)]
    keys = next_sort_keys(keys, 'host', add=False)
    assert keys == [('host', True)]
    assert next_sort_keys(keys, 'host', add=False) == []


def test_a_plain_click_on_another_column_replaces_a_multi_sort():
    assert next_sort_keys([('host', False), ('status', True)], 'size', add=False) == [('size', False)]


def test_a_shift_click_adds_flips_then_drops_a_column_and_keeps_the_rest():
    keys = next_sort_keys([('host', False)], 'status', add=True)
    assert keys == [('host', False), ('status', False)]
    keys = next_sort_keys(keys, 'status', add=True)
    assert keys == [('host', False), ('status', True)]
    assert next_sort_keys(keys, 'status', add=True) == [('host', False)]


# ===== Tree tables =====

TREE_COLUMNS = [{'name': 'name', 'label': 'Name', 'field': 'name'}, {'name': 'cpu', 'label': 'CPU', 'field': 'cpu'}]

TREE_ROWS = [
    {'id': 1, 'parent': None, 'name': 'init', 'cpu': 9},
    {'id': 2, 'parent': 1, 'name': 'shell', 'cpu': 1},
    {'id': 3, 'parent': 1, 'name': 'browser', 'cpu': 8},
    {'id': 4, 'parent': 3, 'name': 'tab', 'cpu': 7},
    {'id': 5, 'parent': 99, 'name': 'orphan', 'cpu': 0},
]


def _tree(sort_keys=(), collapsed=(), term=''):
    return [(r['name'], r['_depth']) for r in tree_rows(TREE_ROWS, 'id', 'parent', list(sort_keys), TREE_COLUMNS,
                                                         set(collapsed), term, ['name'])]


def test_tree_rows_nest_each_row_under_its_parent_and_a_missing_parent_makes_a_root():
    assert _tree() == [('init', 0), ('shell', 1), ('browser', 1), ('tab', 2), ('orphan', 0)]


def test_tree_rows_sort_siblings_within_their_parent():
    assert _tree(sort_keys=[('cpu', True)]) == [('init', 0), ('browser', 1), ('tab', 2), ('shell', 1), ('orphan', 0)]


def test_tree_rows_leave_out_what_sits_under_a_collapsed_row():
    rows = tree_rows(TREE_ROWS, 'id', 'parent', [], TREE_COLUMNS, {3}, '', ['name'])
    assert [r['name'] for r in rows] == ['init', 'shell', 'browser', 'orphan']
    browser = rows[2]
    assert (browser['_has_children'], browser['_expanded']) == (True, False)
    assert rows[1]['_has_children'] is False


def test_tree_rows_filter_keeps_each_match_with_its_ancestors_even_when_collapsed():
    assert _tree(collapsed={1, 3}, term='tab') == [('init', 0), ('browser', 1), ('tab', 2)]


def test_tree_rows_copy_the_rows_they_mark():
    tree_rows(TREE_ROWS, 'id', 'parent', [], TREE_COLUMNS, set())
    assert '_depth' not in TREE_ROWS[0]


# ===== A real table =====

async def test_a_data_table_sorts_on_header_clicks_and_filters_on_typing(user: User):
    tables = []

    @ui.page('/')
    def _page():
        tables.append(data_table(columns=COLUMNS))
        set_rows(tables[0], ROWS)

    await user.open('/')
    table = tables[0]
    assert [c['x_sortable'] for c in table.columns] == [True, True, True, False]
    assert not any(c['sortable'] for c in table.columns)

    user.find(ui.table).trigger('sort_click', {'name': 'status', 'add': False})
    user.find(ui.table).trigger('sort_click', {'name': 'host', 'add': True})
    user.find(ui.table).trigger('sort_click', {'name': 'host', 'add': True})
    assert [r['host'] for r in table.rows] == ['host9', 'host10', 'host2']
    assert [(c['sort_rank'], c['sort_descending']) for c in table.columns[:2]] == [(2, True), (1, False)]

    user.find(ui.input).type('online')
    assert [r['host'] for r in table.rows] == ['host10', 'host2']

    # Fresh rows from a refresh keep the sort and the filter the user chose.
    set_rows(table, ROWS + [{'host': 'host11', 'status': 'online', 'size': '', 'size_bytes': None}])
    assert [r['host'] for r in table.rows] == ['host11', 'host10', 'host2']


async def test_a_tree_table_collapses_and_opens_a_branch(user: User):
    tables = []

    @ui.page('/')
    def _page():
        tables.append(data_table(columns=TREE_COLUMNS, row_key='id', tree={'parent_field': 'parent'}))
        set_rows(tables[0], TREE_ROWS)

    await user.open('/')
    table = tables[0]
    assert [r['name'] for r in table.rows] == ['init', 'shell', 'browser', 'tab', 'orphan']

    user.find(ui.table).trigger('tree_toggle', 3)
    assert [r['name'] for r in table.rows] == ['init', 'shell', 'browser', 'orphan']

    # A refresh keeps the branch closed.
    set_rows(table, TREE_ROWS)
    assert [r['name'] for r in table.rows] == ['init', 'shell', 'browser', 'orphan']

    user.find(ui.table).trigger('tree_toggle', 3)
    assert [r['name'] for r in table.rows] == ['init', 'shell', 'browser', 'tab', 'orphan']
