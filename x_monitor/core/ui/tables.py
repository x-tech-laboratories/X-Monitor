"""Tables that sort by several columns at once and filter on a typed term, done on the server so every table behaves the same."""
import hashlib
import re
from contextlib import nullcontext
from typing import Optional
from nicegui import ui


# ===== Sorting and filtering rows =====

_DIGIT_RUNS = re.compile(r'(\d+)')


def _natural_key(text: str) -> tuple:
    """Splits text into words and numbers so "host10" sorts after "host9"."""
    return tuple((0, int(part), '') if part.isdigit() else (1, 0, part)
                 for part in _DIGIT_RUNS.split(text.lower()) if part)


def _sort_value(value) -> tuple:
    """A key that orders numbers before text and puts empty cells last, whatever mix a column holds."""
    if value is None or value == '':
        return (2, ())
    if isinstance(value, (int, float)):
        return (0, (value,))
    return (1, _natural_key(str(value)))


def sort_rows(rows: list, sort_keys: list, columns: list) -> list:
    """Orders rows by each (column name, descending) pair in turn, the first pair deciding most."""
    field_by_name = {col['name']: col.get('sort_field', col.get('field', col['name'])) for col in columns}
    ordered = list(rows)
    # Python's sort is stable, so sorting by the last key first leaves the first key in charge.
    for column_name, descending in reversed(sort_keys):
        field = field_by_name.get(column_name, column_name)
        empty_rows = [row for row in ordered if row.get(field) in (None, '')]
        filled_rows = [row for row in ordered if row.get(field) not in (None, '')]
        filled_rows.sort(key=lambda row: _sort_value(row.get(field)), reverse=descending)
        ordered = filled_rows + empty_rows
    return ordered


def filter_rows(rows: list, term: str, fields: list) -> list:
    """Keeps the rows where every word of the term appears in one of the given fields."""
    words = term.lower().split()
    if not words:
        return list(rows)
    return [row for row in rows
            if all(word in ' '.join(str(row.get(f, '')) for f in fields).lower() for word in words)]


def next_sort_keys(sort_keys: list, column_name: str, add: bool) -> list:
    """The sort after a header click: a plain click sorts by that column alone, a shift-click adds it to the others.

    Clicking the same column again steps it from ascending to descending to unsorted.
    """
    current = dict(sort_keys)
    if not add:
        if list(current) == [column_name]:
            return [(column_name, True)] if not current[column_name] else []
        return [(column_name, False)]
    if column_name not in current:
        return list(sort_keys) + [(column_name, False)]
    if not current[column_name]:
        return [(name, True if name == column_name else desc) for name, desc in sort_keys]
    return [(name, desc) for name, desc in sort_keys if name != column_name]


# ===== Keying rows =====

def keyed_rows(rows: list, row_key: str) -> list:
    """Gives each row that has no key one made from its contents, so the browser keeps a row it has already drawn."""
    seen: dict = {}
    keyed = []
    for row in rows:
        if row.get(row_key) is not None:
            keyed.append(row)
            continue
        contents = repr(sorted(row.items(), key=lambda item: str(item[0])))
        digest = hashlib.blake2b(contents.encode(), digest_size=8).hexdigest()
        # Identical rows, such as one message logged twice in a second, each need their own key.
        seen[digest] = seen.get(digest, -1) + 1
        keyed.append({**row, row_key: f'{digest}-{seen[digest]}'})
    return keyed


# ===== Arranging rows as a tree =====

def tree_rows(rows: list, row_key: str, parent_field: str, sort_keys: list, columns: list,
              collapsed: set, term: str = '', filter_fields: Optional[list] = None) -> list:
    """Flattens rows into tree order, each under its parent and sorted among its siblings.

    A row whose parent is absent is a root. Rows under a collapsed key are left out, unless a
    filter term is set, which keeps every match and the ancestors leading to it.
    Each returned row is a copy marked with `_depth`, `_has_children` and `_expanded`.
    """
    by_key = {row.get(row_key): row for row in rows}
    children: dict = {}
    roots = []
    for row in rows:
        parent = row.get(parent_field)
        if parent is not None and parent in by_key and parent != row.get(row_key):
            children.setdefault(parent, []).append(row)
        else:
            roots.append(row)

    shown = None
    if term.strip():
        shown = set()
        for row in filter_rows(rows, term, filter_fields or []):
            key = row.get(row_key)
            while key in by_key and key not in shown:
                shown.add(key)
                key = by_key[key].get(parent_field)

    flat = []

    def add_level(level: list, depth: int) -> None:
        for row in sort_rows(level, sort_keys, columns):
            key = row.get(row_key)
            if shown is not None and key not in shown:
                continue
            below = children.get(key, [])
            expanded = shown is not None or key not in collapsed
            flat.append({**row, '_depth': depth, '_has_children': bool(below), '_expanded': expanded})
            if below and expanded:
                add_level(below, depth + 1)

    add_level(roots, 0)
    return flat


# ===== The table's own state =====

class TableControls:
    """The rows a table was given, plus the sort and filter applied before they reach the browser."""

    def __init__(self, table, filter_fields: list, tree_parent_field: Optional[str] = None):
        self.table = table
        self.filter_fields = filter_fields
        self.tree_parent_field = tree_parent_field
        self.collapsed: set = set()
        self.source_rows: list = []
        self.sort_keys: list = []
        self.filter_term = ''

    def visible_rows(self) -> list:
        """The source rows after the filter and then the sort, laid out as a tree when the table is one."""
        if self.tree_parent_field:
            return tree_rows(self.source_rows, self.table.row_key, self.tree_parent_field, self.sort_keys,
                             self.table.columns, self.collapsed, self.filter_term, self.filter_fields)
        rows = filter_rows(self.source_rows, self.filter_term, self.filter_fields)
        return sort_rows(rows, self.sort_keys, self.table.columns)

    def show(self) -> None:
        """Pushes the visible rows to the browser only when they changed."""
        rows = self.visible_rows()
        if rows != self.table.rows:
            self.table.rows = rows
            self.table.update()

    def set_rows(self, rows: list) -> None:
        """Takes a fresh set of rows and shows them sorted and filtered."""
        self.source_rows = keyed_rows(rows, self.table.row_key)
        self.show()

    def set_filter(self, term: Optional[str]) -> None:
        """Filters on a new term."""
        self.filter_term = (term or '').strip()
        self.show()

    def toggle_branch(self, key) -> None:
        """Collapses an open tree row or opens a collapsed one."""
        self.collapsed.symmetric_difference_update({key})
        self.show()

    def click_header(self, column_name: str, add: bool) -> None:
        """Applies one header click and marks each column with its place in the sort."""
        self.sort_keys = next_sort_keys(self.sort_keys, column_name, add)
        self._mark_columns()
        self.show()

    def _mark_columns(self) -> None:
        rank_by_name = {name: (rank, desc) for rank, (name, desc) in enumerate(self.sort_keys, start=1)}
        for col in self.table.columns:
            rank, descending = rank_by_name.get(col['name'], (0, False))
            col['sort_rank'] = rank
            col['sort_descending'] = descending
            col['sort_count'] = len(self.sort_keys)
        self.table.update()


# ===== Building a table =====

_HEADER_CELL_SLOT = '''
<q-th :props="props" :class="props.col.x_sortable ? 'cursor-pointer select-none' : ''"
      :title="props.col.x_sortable ? 'Click to sort, Shift+click to sort by several columns' : ''"
      @click="props.col.x_sortable && $parent.$emit('sort_click',
              {name: props.col.name, add: $event.shiftKey || $event.ctrlKey || $event.metaKey})">
  {{ props.col.label }}
  <q-icon v-if="props.col.sort_rank" :name="props.col.sort_descending ? 'arrow_downward' : 'arrow_upward'"
          size="14px" class="q-table__sort-icon" style="opacity: 1" />
  <sup v-if="props.col.sort_rank && props.col.sort_count > 1">{{ props.col.sort_rank }}</sup>
</q-th>
'''

# The tree column's cell: indented by depth, with a chevron that opens or closes a row that has children.
_TREE_CELL_SLOT = '''
<q-td :props="props">
  <div class="row items-center no-wrap" :style="{ paddingLeft: (props.row._depth * 1.25) + 'rem' }">
    <q-btn v-if="props.row._has_children" flat dense size="sm" class="halon-tree-toggle"
           :icon="props.row._expanded ? 'expand_more' : 'chevron_right'"
           @click.stop="$parent.$emit('tree_toggle', props.key)" />
    <span v-else class="halon-tree-leaf"></span>
    <span>{{ props.value }}</span>
  </div>
</q-td>
'''


def data_table(columns: list, rows: Optional[list] = None, filter_input: bool = True,
               filter_fields: Optional[list] = None, filter_placeholder: str = 'Filter',
               filter_into=None, tree: Optional[dict] = None, **table_kwargs) -> ui.table:
    """A ui.table whose columns sort on click, several at once with Shift, under an optional filter box.

    Columns marked 'sortable': False, such as row buttons, stay out of sorting. Feed it rows with set_rows.
    `filter_into` is the element the filter box goes in, such as the table's heading line; without it the box sits just above the table.
    `tree` (`{'parent_field', 'column'}`) nests each row under the row its parent_field names, drawn in `column` (default the first).
    """
    sortable_names = [col['name'] for col in columns if col.get('sortable', True) is not False]
    # Quasar's own single-column sort is switched off, since the server orders the rows.
    render_columns = [{**col, 'sortable': False, 'x_sortable': col['name'] in sortable_names,
                       'sort_rank': 0, 'sort_descending': False, 'sort_count': 0}
                      for col in columns]
    fields = filter_fields or [col.get('field', col['name']) for col in columns
                               if col['name'] in sortable_names]

    filter_box = None
    if filter_input:
        with filter_into if filter_into is not None else nullcontext():
            filter_box = ui.input(placeholder=filter_placeholder).props(
                'outlined dense clearable').classes('halon-table-filter')
        with filter_box.add_slot('prepend'):
            ui.icon('search')
    table = ui.table(columns=render_columns, rows=[], **table_kwargs)
    controls = TableControls(table, fields, tree_parent_field=(tree or {}).get('parent_field'))
    table.x_controls = controls
    table.add_slot('header-cell', _HEADER_CELL_SLOT)
    if tree:
        table.add_slot(f"body-cell-{tree.get('column', columns[0]['name'])}", _TREE_CELL_SLOT)
        table.on('tree_toggle', lambda e: controls.toggle_branch(e.args))
    table.on('sort_click', lambda e: controls.click_header(e.args['name'], bool(e.args.get('add'))))
    if filter_box is not None:
        filter_box.on_value_change(lambda e: controls.set_filter(e.value))
    if rows:
        controls.set_rows(rows)
    return table


def set_rows(table, rows: list) -> None:
    """Gives a table new rows, sorted and filtered when it is a data_table."""
    controls = getattr(table, 'x_controls', None)
    if controls is not None:
        controls.set_rows(rows)
        return
    rows = keyed_rows(rows, table.row_key)
    if rows != table.rows:
        table.rows = rows
        table.update()
