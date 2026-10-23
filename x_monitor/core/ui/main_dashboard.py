"""Dashboard shell: page routing, header and the view container."""
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote
from nicegui import app, ui
from x_monitor.core.contracts import EngineLike
from x_monitor.core.coordination.monitor_graph import find_monitor
from . import theme
from .auth import LOGOUT_PATH, AuthConfig
from .components import icon_button, on_data_event
from .sidebar import render_sidebar
from .views import render_overview, render_events, render_plugin_detail, render_schedules
from .views.notifications import open_notifications_dialog
from .views.system import render_system_menu

log = logging.getLogger(__name__)

_ICON = Path(__file__).parent / 'static' / 'icon.svg'

_navigation_state = {'switch_func': None}


def navigate_to(plugin_instance: Any):
    """Switches the dashboard to a plugin's detail view, or the overview for None."""
    if _navigation_state['switch_func']:
        if plugin_instance is None:
            _navigation_state['switch_func']('overview')
        else:
            _navigation_state['switch_func']('plugin', plugin_instance)


def view_path(view_type: str, plugin: Optional[Any] = None) -> str:
    """The address of a dashboard view, so each monitor's page can be linked to."""
    if view_type == 'events':
        return '/events'
    if view_type == 'schedules':
        return '/schedules'
    if view_type == 'plugin' and plugin is not None:
        return f"/monitor/{quote(plugin.id, safe='')}"
    return '/'


# The views switch in place, so going back re-renders the page for the address it returns to.
_RELOAD_ON_BACK = '<script>window.addEventListener("popstate", () => location.reload());</script>'


@dataclass
class DashboardState:
    """Per-client view state: what the main area shows and how to redraw it."""
    current_view: str = 'overview'
    selected_plugin: Any = None
    render_main: Optional[Callable[[], None]] = None
    sync_nav: Optional[Callable[[], None]] = None
    monitors_version: int = 0


def after_reload(engine: EngineLike, state: DashboardState) -> Optional[str]:
    """How a view catches up with a config reload: 'overview' when its monitor is gone, 'redraw' when it lists or shows monitors."""
    if state.current_view == 'plugin' and state.selected_plugin is not None:
        current = find_monitor(engine, state.selected_plugin.id)
        if current is None:
            return 'overview'
        state.selected_plugin = current
        return 'redraw'
    return 'redraw' if state.current_view == 'overview' else None


def _register_endpoints(engine: EngineLike) -> Optional[AuthConfig]:
    """Registers auth, the REST API and the agent push endpoint on the app,
    returning the auth config so the header can offer a sign-out."""
    from x_monitor.core.ui.auth import register_auth
    from x_monitor.core.ui.tokens import build_tokens
    tokens = build_tokens(engine.config_loader.auth_settings)
    auth_config = register_auth(app, engine.config_loader.auth_settings, tokens)

    # A broken API module must not stop the dashboard from starting.
    try:
        from x_monitor.core.ui.api import register_api
        register_api(app, engine, tokens)
    except Exception as e:
        log.error(f"Failed to register REST API — /api endpoints will be unavailable: {e}")

    # A broken agent endpoint must not stop the dashboard from starting.
    try:
        from x_monitor.core.ui.agent_endpoint import register_agent_endpoint
        register_agent_endpoint(app, engine.connectors.agents)
    except Exception as e:
        log.error(f"Failed to register the agent endpoint — agents will be unable to connect: {e}")

    return auth_config


def _render_account_menu(auth_config: AuthConfig):
    """Renders the signed-in account menu and its sign-out item."""
    with icon_button('account_circle', f"Signed in as {auth_config.username}"):
        with ui.menu():
            ui.label(auth_config.username).classes('halon-caption halon-menu-caption')
            ui.separator()
            ui.menu_item('Sign out', on_click=lambda: ui.navigate.to(LOGOUT_PATH))


def _render_header(engine: EngineLike, left_drawer_toggle: Callable,
                   auth_config: Optional[AuthConfig]):
    """Renders the top bar: drawer toggle, brand, notifications and the account menu."""
    with ui.header().classes('items-center'):
        icon_button('menu', 'Toggle sidebar', on_click=left_drawer_toggle)
        ui.image('/icon.svg').style('width: 16px; height: 16px; margin: 0 var(--space-2)')
        ui.label('X-Monitor').classes('halon-brand')
        ui.space()
        if engine.notifications.channels:
            icon_button('notifications', 'Notifications',
                        on_click=lambda: open_notifications_dialog(engine))
        render_system_menu(engine)
        if auth_config is not None:
            _render_account_menu(auth_config)


def _render_index(engine: EngineLike, auth_config: Optional[AuthConfig] = None,
                  view: str = 'overview', plugin: Optional[Any] = None):
    """Renders the dashboard page: header, sidebar and the switchable main view."""
    theme.install()
    ui.add_head_html(_RELOAD_ON_BACK)

    state = DashboardState(current_view=view, selected_plugin=plugin)

    def switch_view(view_type: str, plugin: Optional[Any] = None):
        path = view_path(view_type, plugin)
        if path != view_path(state.current_view, state.selected_plugin):
            ui.navigate.history.push(path)
        state.current_view = view_type
        state.selected_plugin = plugin
        if state.render_main:
            state.render_main()

    _navigation_state['switch_func'] = switch_view

    _render_header(engine, lambda: left_drawer.toggle(), auth_config)
    left_drawer, sync_nav = render_sidebar(engine, switch_view)
    state.sync_nav = lambda: sync_nav(state.current_view, state.selected_plugin)

    main_container = ui.column().classes('halon-page')

    def render_main():
        try:
            main_container.clear()
        except RuntimeError:
            return
        if state.sync_nav:
            state.sync_nav()
        with main_container:
            if state.current_view == 'overview':
                render_overview(engine, switch_view)
            elif state.current_view == 'events':
                render_events(engine, switch_view)
            elif state.current_view == 'schedules':
                render_schedules(engine, switch_view)
            else:
                render_plugin_detail(engine, switch_view, state.selected_plugin)

    state.render_main = render_main
    render_main()

    state.monitors_version = engine.monitors_version

    def follow_reload():
        if engine.monitors_version == state.monitors_version:
            return
        state.monitors_version = engine.monitors_version
        action = after_reload(engine, state)
        if action == 'overview':
            switch_view('overview')
        elif action == 'redraw':
            render_main()

    on_data_event(follow_reload, run_now=False)


def init_gui(engine: EngineLike, port: int = 8080):
    """Wires the engine into NiceGUI, registers the endpoints and starts the server."""
    app.on_startup(engine.run)
    app.on_shutdown(engine.shutdown)

    app.add_static_file(local_file=_ICON, url_path='/icon.svg')

    auth_config = _register_endpoints(engine)
    # Added last so it runs first: a starting server answers before asking anyone to log in.
    from x_monitor.core.ui.startup import StartingUpMiddleware
    app.add_middleware(StartingUpMiddleware, engine=engine)

    @ui.page('/')
    def index_page():
        _render_index(engine, auth_config)

    @ui.page('/events')
    def events_page():
        _render_index(engine, auth_config, view='events')

    @ui.page('/schedules')
    def schedules_page():
        _render_index(engine, auth_config, view='schedules')

    @ui.page('/monitor/{monitor_id}')
    def monitor_page(monitor_id: str):
        plugin = find_monitor(engine, monitor_id)
        if plugin is None:
            _render_index(engine, auth_config)
            ui.notify(f'No monitor with id {monitor_id!r}', type='warning')
        else:
            _render_index(engine, auth_config, view='plugin', plugin=plugin)

    svg = _ICON.read_text()
    ui.run(
        title='X-Monitor', favicon=svg[svg.index('<svg'):], port=port, reload=False, show=False,
    )
