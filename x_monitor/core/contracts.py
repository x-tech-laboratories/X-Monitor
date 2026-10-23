"""Shared interface contracts used across module boundaries.

Types that belong to a single subsystem live with that subsystem (e.g.
CollectResult in connectors/types.py). This module holds only the
contracts that cross subsystem boundaries and would otherwise be
duck-typed identically in multiple places — see docs/develop.md's "Interface
contracts" section for the rationale behind each one.
"""

from typing import (
    Any, Awaitable, Callable, Dict, List, Optional, Protocol, Tuple, TypedDict,
    Union, runtime_checkable,
)

# A callback that may be a plain sync function or one returning an
# awaitable — both are valid everywhere NiceGUI invokes a callback, since
# `helpers.should_await` (or an equivalent check) decides at the call site
# whether to await the result. Reused by PluginPage._tick, _CallbackTick._tick
# and on_data_event.
RefreshCallback = Callable[[], Union[None, Awaitable[None]]]


class TransportConnection(Protocol):
    """The two-member surface SSHConnection and AgentConnection share — the
    invariant the whole transport-swap design rests on. ExecContext holds one
    of these and no plugin ever learns which."""

    host: str

    async def execute(self, command: str,
                      timeout: Optional[float] = None) -> Tuple[int, str, str]: ...


@runtime_checkable
class MetricsSource(Protocol):
    """The narrow, read-only slice of DatabaseManager that anything
    reporting metrics externally (Prometheus/InfluxDB exporters, the
    public REST API) actually needs. Neither exporter should require the
    rest of DatabaseManager's write/job/setting surface."""

    def latest_metrics(self) -> List[Dict[str, Any]]: ...

    def latest_statuses(self) -> Dict[str, str]: ...


@runtime_checkable
class PushablePlugin(Protocol):
    """The extension surface a push-monitor plugin exposes beyond the base
    Plugin ABC. Only x_monitor.plugins.push.Push implements this today;
    core/ui/api.py's /api/push route narrows a generic Plugin to this
    Protocol (via isinstance, since Protocol supports runtime_checkable
    structural checks) instead of importing the concrete Push class."""

    token: Optional[str]

    def record_push(self, status: str, msg: Optional[str] = None, value: Optional[float] = None,
                    source: Optional[str] = None) -> bool: ...


class ActionButtonSpec(TypedDict, total=False):
    """One entry in Plugin.get_actions()'s return list — the generic
    "custom action button" system rendered by main_dashboard.py's plugin
    detail header. Distinct from spec.py's ButtonSpec (a UI_SPEC-embedded
    button rendered inline in the page body via render_buttons); this one
    is always rendered in the fixed header regardless of UI_SPEC. With
    kind 'toggle' it is a toggle button instead: it is pressed while the latest
    value of `metric` is on, and clicking it runs `on_action_id` or `off_action_id`.
    A `confirm` text asks the user first and runs the action only on a yes.
    A `job` names the kind of job the action launches, so the header fills it
    while that job runs, greys it out while another runs, and shows Cancel."""
    action_id: str
    name: str
    icon: str
    variant: str
    kind: str
    metric: str
    on_action_id: str
    off_action_id: str
    confirm: str
    job: str


@runtime_checkable
class EngineLike(Protocol):
    """The surface of XMonitorEngine that the UI layer (main_dashboard.py,
    api.py) and Plugin.run_action/run_cycle actually call.
    Exists so those modules can be typed against a narrow contract instead
    of the concrete XMonitorEngine, and so a test double only needs to satisfy
    this shape rather than XMonitorEngine's full constructor/internals."""

    @property
    def db(self) -> Any: ...

    @property
    def ready(self) -> bool: ...

    @property
    def plugins(self) -> List[Any]: ...

    @property
    def config_loader(self) -> Any: ...

    @property
    def notifications(self) -> Any: ...

    async def run(self) -> None: ...

    def shutdown(self) -> None: ...

    async def dispatch_action(self, plugin: Any, action_id: str, **kwargs) -> tuple: ...

    async def http_fetch(self, request: Any) -> Any: ...

    async def run_cycle_now(self, plugin: Any) -> bool: ...

    def last_collected(self, plugin_id: str) -> float: ...

    def cycle_timing(self, plugin_id: str) -> Any: ...

    def log_levels(self) -> Dict[str, str]: ...

    def known_loggers(self) -> List[str]: ...

    def set_log_level(self, logger: Optional[str], level: Optional[str],
                      source: str = 'runtime') -> Dict[str, str]: ...

    @property
    def monitors_version(self) -> int: ...

    async def reload_config(self, source: str = 'api') -> Any: ...

    def set_setting(self, key: str, value: str) -> None: ...

    def apply(self, plugin: Any, result: Any) -> None: ...
