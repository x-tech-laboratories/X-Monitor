"""The dashboard sidebar: resizable drawer, nav items and the monitor tree."""

import json
from typing import Any, Callable, Dict
from nicegui import ui
from x_monitor.core.contracts import EngineLike
from x_monitor.core.coordination.monitor_graph import View, child_label, find_monitor
from .theme import STATUS_COLORS
from .components import on_data_event, offload
from . import nicegui_compat as ng

# Tracks the drag on the gutter and emits 'drawer_resized' with the final width in pixels.
DRAWER_RESIZE_JS = '''
    (e) => {
        e.preventDefault();
        const drawerEl = e.target.closest('.q-drawer');
        const startX = e.clientX;
        const startWidth = drawerEl.offsetWidth;
        const onMove = (moveEvent) => {
            const newWidth = Math.min(600, Math.max(200, startWidth + (moveEvent.clientX - startX)));
            drawerEl.style.width = newWidth + 'px';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            emitEvent('drawer_resized', drawerEl.offsetWidth);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
'''

_TREE_HEADER_SLOT = '''
    <span class="flex items-center gap-2">
        <q-icon class="halon-status-dot" name="circle"
                :style="{ color: props.node.color }" size="8px" />
        {{ props.node.label }}
    </span>
'''


def _load_drawer_width(engine: EngineLike) -> int:
    """Reads the persisted drawer width, falling back to the default."""
    try:
        return int(engine.db.get_setting('drawer_width') or 248)
    except ValueError:
        return 248


def _save_drawer_width(engine: EngineLike, width: int):
    """Persists the drawer width chosen by dragging the gutter."""
    engine.db.set_setting('drawer_width', str(width))


def _views(engine: EngineLike) -> list:
    """The engine's views, or the plugin tree alone as one view for an engine that has none."""
    views = getattr(engine, 'views', None)
    return views if isinstance(views, list) and views else [View('Monitors', engine.plugins)]


def _load_view(engine: EngineLike) -> View:
    """The view the tree last showed, falling back to the primary view."""
    views = _views(engine)
    chosen = engine.db.get_setting('tree_view')
    return next((v for v in views if v.name == chosen), views[0])


def _expanded_setting(engine: EngineLike, view: View) -> str:
    """The setting holding one view's expanded nodes; the primary view keeps the original key."""
    return 'tree_expanded' if view is _views(engine)[0] else f'tree_expanded:{view.name}'


def _load_expanded(engine: EngineLike, view: View) -> list:
    """Reads the persisted set of expanded tree node keys for one view."""
    try:
        return json.loads(engine.db.get_setting(_expanded_setting(engine, view)) or '[]')
    except ValueError:
        return []


def _load_accordion(engine: EngineLike) -> bool:
    """Reads whether the tree keeps only one sibling branch open at a time."""
    return engine.db.get_setting('tree_accordion') == '1'


def branch_ids(nodes: list) -> list:
    """Lists the ids of every node that has children, depth first."""
    ids = []
    for node in nodes:
        if node.get('children'):
            ids.append(node['id'])
            ids.extend(branch_ids(node['children']))
    return ids


def failed_branch_ids(nodes: list) -> list:
    """Lists the ids of every branch that holds a failed monitor somewhere beneath it."""
    ids = []
    for node in nodes:
        children = node.get('children') or []
        if not children:
            continue
        below = failed_branch_ids(children)
        if below or any(c['color'] == STATUS_COLORS['failed'] for c in children):
            ids.append(node['id'])
            ids.extend(below)
    return ids


def build_tree_nodes(engine: EngineLike, plugins, statuses=None, parent=None, path: str = '') -> list:
    """Builds the ui.tree node dicts for the plugin hierarchy with status colors.

    A monitor linked under several groups appears once per place, so each node's
    key is its path of ids from the root, and `monitor` names the monitor it shows."""
    if statuses is None:
        statuses = engine.db.latest_statuses()
    nodes = []
    for p in plugins:
        status = statuses.get(p.id, 'unavailable')
        key = f'{path}/{p.id}' if path else p.id
        node = {
            'id': key,
            'monitor': p.id,
            'label': child_label(parent, p),
            'icon': 'circle',
            'color': STATUS_COLORS[status],
        }
        if p.children:
            node['children'] = build_tree_nodes(engine, p.children, statuses, parent=p, path=key)
        nodes.append(node)
    return nodes


def monitor_for_key(nodes: list, key: str):
    """The monitor id a tree node key points at, or None."""
    for node in nodes:
        if node['id'] == key:
            return node['monitor']
        found = monitor_for_key(node.get('children') or [], key)
        if found:
            return found
    return None


def _apply_nav_selection(nav_items: Dict[str, Any], current_view: str):
    """Marks the nav item for the current view as selected."""
    # A sidebar item is a place you are, so selection is elevation (halon-item-selected), not an accent fill.
    for view, item in nav_items.items():
        selected = current_view == view
        item.classes(add='halon-item-selected' if selected else None,
                     remove=None if selected else 'halon-item-selected')


def _render_resize_handle(engine: EngineLike):
    """Renders the drag gutter that resizes the drawer and persists the width."""
    resize_handle = ui.element('div').classes('halon-resize-gutter').style(
        'position: absolute; top: 0; right: 0; width: 6px; height: 100%; '
        'cursor: ew-resize; z-index: 2000;'
    )
    resize_handle.on('mousedown', js_handler=DRAWER_RESIZE_JS)
    ui.on('drawer_resized', lambda e: _save_drawer_width(engine, int(e.args)))


def _render_nav_items(switch_view: Callable) -> Dict[str, Any]:
    """Renders the fixed nav list and returns its items keyed by view name."""
    with ui.list().classes('w-full').props('dense'):
        return {
            'overview': ui.item('All Monitors', on_click=lambda: switch_view('overview')).props('clickable dense'),
            'events': ui.item('Events', on_click=lambda: switch_view('events')).props('clickable dense'),
        }


def _tree_tool(icon: str, tooltip: str, on_click: Callable):
    """Renders one flat icon button of the tree toolbar."""
    with ui.button(icon=icon, on_click=on_click, color=None).props('flat dense round size=sm') as button:
        ui.tooltip(tooltip)
    return button


def _render_tree_toolbar(engine: EngineLike, tree, current_view: Callable[[], View]):
    """Renders the expand, collapse, accordion and expand-failed controls above the tree."""
    def set_expanded(ids: list):
        ng.set_tree_expanded(tree, ids)
        tree.update()
        engine.db.set_setting(_expanded_setting(engine, current_view()), json.dumps(ids))

    def toggle_accordion():
        enabled = not _load_accordion(engine)
        engine.db.set_setting('tree_accordion', '1' if enabled else '')
        tree.props(add='accordion' if enabled else None, remove=None if enabled else 'accordion')
        accordion.classes(add='halon-button-active' if enabled else None,
                          remove=None if enabled else 'halon-button-active')

    with ui.row().classes('items-center gap-0 no-wrap'):
        _tree_tool('unfold_more', 'Expand all', lambda: set_expanded(branch_ids(ng.tree_nodes(tree))))
        _tree_tool('unfold_less', 'Collapse all', lambda: set_expanded([]))
        _tree_tool('error_outline', 'Expand failed', lambda: set_expanded(failed_branch_ids(ng.tree_nodes(tree))))
        accordion = _tree_tool('view_agenda', 'Accordion mode', toggle_accordion)
    if _load_accordion(engine):
        tree.props('accordion')
        accordion.classes('halon-button-active')


def _render_view_picker(engine: EngineLike, current: View, on_change: Callable[[View], None]):
    """Renders the tree's heading: the view's name, or a picker between views when there are several."""
    views = _views(engine)
    if len(views) == 1:
        ui.label(current.name).classes('halon-sidebar-label').style('padding-top: 0')
        return
    def pick(view: View):
        button.text = view.name
        on_change(view)

    with ui.button(current.name, color=None).props(
            'flat dense icon-right=arrow_drop_down').classes('halon-view-picker') as button:
        with ui.menu():
            for view in views:
                ui.menu_item(view.name, on_click=lambda v=view: pick(v))


def _render_monitor_tree(engine: EngineLike, switch_view: Callable):
    """Renders the monitor tree with its view picker, toolbar, live status dots and persisted expansion."""
    state = {'view': _load_view(engine)}

    def handle_select(e):
        if e.value:
            monitor_id = monitor_for_key(ng.tree_nodes(tree), e.value)
            target_plugin = find_monitor(engine, monitor_id) if monitor_id else None
            if target_plugin:
                switch_view('plugin', target_plugin)

    def show_view(view: View):
        state['view'] = view
        engine.db.set_setting('tree_view', view.name)
        ng.set_tree_nodes(tree, build_tree_nodes(engine, view.children))
        ng.set_tree_expanded(tree, _load_expanded(engine, view))
        tree.update()

    with ui.row().classes('w-full items-center justify-between no-wrap gap-0').style('padding-top: var(--space-5)'):
        _render_view_picker(engine, state['view'], show_view)
        toolbar = ui.row().classes('items-center no-wrap')
    tree = ui.tree(nodes=build_tree_nodes(engine, state['view'].children),
                   on_select=handle_select).classes('w-full')
    tree.add_slot('default-header', _TREE_HEADER_SLOT)
    with toolbar:
        _render_tree_toolbar(engine, tree, lambda: state['view'])

    async def refresh_tree():
        new_nodes = await offload(build_tree_nodes)(engine, state['view'].children)
        if new_nodes != ng.tree_nodes(tree):
            ng.set_tree_nodes(tree, new_nodes)
            tree.update()

    on_data_event(refresh_tree, run_now=False)

    def _save_expanded(e):
        ids = e.args if isinstance(e.args, list) else []
        engine.db.set_setting(_expanded_setting(engine, state['view']), json.dumps(ids))

    ng.set_tree_expanded(tree, _load_expanded(engine, state['view']))
    tree.update()
    tree.on('update:expanded', _save_expanded)


def render_sidebar(engine: EngineLike, switch_view: Callable):
    """Renders the left drawer and returns it with a sync_nav(current_view) callback."""
    drawer_width = _load_drawer_width(engine)
    with ui.left_drawer(value=True).classes('p-0').props(f'width={drawer_width}') as left_drawer:
        _render_resize_handle(engine)
        nav_items = _render_nav_items(switch_view)
        _render_monitor_tree(engine, switch_view)

    def sync_nav(current_view: str):
        _apply_nav_selection(nav_items, current_view)

    return left_drawer, sync_nav
