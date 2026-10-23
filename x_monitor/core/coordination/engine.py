"""Coordination Engine.

The application's central coordinator. It owns the other engines — Settings
(config loader), Database, Connector (agent / SSH / HTTP / DNS / ICMP),
Exporter — and the plugin registry, and drives the per-monitor polling loop.
Plugins stay pure: they declare Commands/ActionPlans/CollectResults and this
engine (and the sub-engines it owns) performs all IO and persistence.

Collection has two paths. The polling loop runs each monitor's declared
requests on its own `interval`, as it always has. Alongside it, monitors on an
agent-backed target can subscribe to event streams the agent watches locally
and pushes the instant they change; those arrive through _on_agent_event and
are persisted the same way, without waiting for the next cycle. A third loop
runs each monitor's scheduled actions at the times its `schedule` names, and
every stored cycle is checked against the monitor's `triggers`.

The class is named ``XMonitorEngine`` for continuity (``core/contracts.py``'s
``EngineLike`` and the test suite reference it); "Coordination Engine" is its
role in the architecture.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import inspect
import os
import random
import signal
import sys
import time
import uuid
import weakref
from dataclasses import dataclass, replace
from typing import Any, List, Optional, Dict, Set

from peewee import OperationalError

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import ActionPlan, CmdResult, CollectResult, DispatchResult, Status, unreachable
from x_monitor.core.coordination.cycle_stats import CycleStats, CycleTiming
from x_monitor.core.coordination.data_view import PluginDataView
from x_monitor.core.coordination.monitor_graph import Link, iter_monitors, resolve_links
from x_monitor.core.coordination.plugin_loader import PluginLoader, parse_plugin_paths
from x_monitor.core.coordination.reload import (
    ReloadResult, restart_required, same_monitor, section_changed,
)
from x_monitor.core.coordination.action_jobs import ActionJobs
from x_monitor.core.coordination.jobs import JobsGateway
from x_monitor.core.settings.config_file import ConfigFileManager as XMonitorConfig
from x_monitor.core.state import changes
from x_monitor.core.state.changes import CHANGES
from x_monitor.core.settings.log_levels import LogLevels
from x_monitor.core.database.database import DatabaseManager as XMonitorDatabase
from x_monitor.core.exporters import ExporterEngine
from x_monitor.core.notifications import NotificationEngine
from x_monitor.core.connectors import ConnectorEngine, ExecContext
from x_monitor.core.connectors.ssh_connector import measure_channel_wait

log = logging.getLogger(__name__)

STARTUP_JITTER_SECONDS = 3.0

# How often the config file is checked for changes.
CONFIG_POLL_SECONDS = 3.0


_TARGET_HOST_KEYS = ('target_host', 'scan_host')
"""Config keys naming a host a monitor works on from elsewhere, whose agent is asked to stay awake for the cycle."""


def bare_host(value: Any) -> str:
    """Reduce `user@host:port` to the lowercase host name an agent entry is keyed by."""
    host = str(value or '').strip().lower().rsplit('@', 1)[-1]
    return host.split(':', 1)[0] if host.count(':') == 1 else host


def seconds_to_clock_slot(interval: int, offset: int, now: float) -> float:
    """Seconds from `now` until UTC time is next `offset` past a multiple of `interval`."""
    return (offset - now) % interval

_PRUNE_CHECK_SECONDS = 60

# Cron times are whole minutes, so checking twice a minute never misses one.
_SCHEDULE_CHECK_SECONDS = 30


def _settle(plugin: Plugin, results: List[Any], result: CollectResult) -> CollectResult:
    """A cycle that never reached its host is unavailable, whatever the plugin made of the empty results."""
    if plugin.AVAILABILITY or not results or not all(map(unreachable, results)):
        return result
    if result.status == str(Status.UNAVAILABLE):
        return result
    return replace(result, status=str(Status.UNAVAILABLE))


def _sooner_cycle(plugin: Plugin) -> Optional[float]:
    """Seconds until the plugin wants its next cycle when sooner than its interval, or None; a crash in the plugin reads as None."""
    try:
        return plugin.next_cycle_in()
    except Exception as e:
        log.error(f"{plugin.name}: next_cycle_in failed: {e}")
        return None


@dataclass
class _Node:
    """One monitor or link in a tree being built, with its children kept apart until the tree is put in place."""
    plugin: Any
    children: List["_Node"]


def _walk(nodes: List[_Node]):
    """Every monitor node in a built tree, skipping links, which only point at a monitor defined elsewhere."""
    for node in nodes:
        if isinstance(node.plugin, Link):
            continue
        yield node
        yield from _walk(node.children)


def _shape(plugins: List[Plugin]) -> tuple:
    """The tree's structure as nested ids and link labels, to tell whether a reload moved anything."""
    return tuple((p.id, tuple(sorted((getattr(p, 'links', None) or {}).items(), key=str)), _shape(p.children))
                 for p in plugins)


@dataclass
class _ReloadPlan:
    """A new config that parsed and validated, ready to put in place."""
    config: XMonitorConfig
    loader: PluginLoader
    nodes: List[_Node]


class XMonitorEngine:
    def __init__(self, config_path: str, db_path_override: Optional[str] = None,
                 handle_signals: bool = False):
        self.config_loader = XMonitorConfig(config_path)
        self.config = self.config_loader.data
        self._plugin_loader = PluginLoader(
            parse_plugin_paths(self.config_loader.plugin_paths, self.config_loader.path.parent))
        self._log_levels = LogLevels()
        self._log_levels.configure(self.config_loader.log_level, self.config_loader.log_levels)
        # Only the real process takes over signals; an engine built in a test leaves them alone.
        self._handle_signals = handle_signals
        self._signals_installed: List[int] = []
        self.plugins: List[Plugin] = []
        self.log_retention_days = self.config_loader.log_retention_days
        self.metric_retention_days = self.config_loader.metric_retention_days
        self.metric_downsample_days = self.config_loader.metric_downsample_days
        self._cycle_timings = self.config_loader.cycle_timings
        # Minus infinity, not 0: time.monotonic() counts from boot, so 0 would hold off the first prune for an hour after a reboot.
        self._last_prune = float('-inf')
        self._collecting: Dict[str, bool] = {}
        # Each polled monitor's loop task, so a reload can stop one monitor without touching the rest.
        self._monitor_tasks: Dict[str, "asyncio.Task"] = {}
        # Instances a reload replaced or removed; a cycle still in flight for one writes nothing.
        self._retired: "weakref.WeakSet[Plugin]" = weakref.WeakSet()
        self._reload_lock = asyncio.Lock()
        # Goes up whenever a reload changes the monitor tree, so a page can tell it is showing an old one.
        self.monitors_version = 0
        self._config_digest = self.config_loader.digest
        self._db_path_overridden = bool(db_path_override)
        self._last_collected: Dict[str, float] = {}
        self._cycle_stats = CycleStats()
        # The loop holds only weak references to tasks, so every background
        # task is anchored here until it finishes.
        self._tasks: set = set()
        # Engine-owned per-plugin IO/persistence, keyed by plugin id. Pure
        # plugins never hold these; the engine wires them in setup_modules and
        # uses them on the collection/action paths. _exec_contexts holds each plugin's
        # ExecContext handle (the connection itself lives in self.connectors).
        self._exec_contexts: Dict[str, "ExecContext"] = {}
        # Monitors reachable by a pushed event, keyed by the stream id the
        # agent will send back (which is the plugin's own id).
        self._event_targets: Dict[str, Plugin] = {}
        # Of those, the streams that stand in for a poll rather than
        # supplementing one, so an event on them marks the monitor collected.
        self._collection_streams: Set[str] = set()
        # State keys of the scheduled actions now running, so a slow one is never started twice.
        self._scheduled_running: Set[str] = set()
        # Each trigger's state by its key, read once from the settings store and written back when it changes.
        self._trigger_states: Dict[str, Dict[str, Any]] = {}
        if db_path_override:
            self.db_path = db_path_override
        else:
            self.db_path = self.config_loader.database_settings.get('path', 'x-monitor.db')
        # False until load_state() has restored the store; nothing may write to it before then.
        self.ready = False
        self._early_agents: Set[str] = set()
        try:
            self.db = XMonitorDatabase(
                self.db_path,
                write_batch_seconds=self.config_loader.write_batch_seconds,
                buffers=self.config_loader.buffer_sizes,
                hydrate=False,
            )
        except OperationalError as e:
            log.critical(f"Failed to initialize database: {e}. Exiting.")
            sys.exit(1)

        self.exporters = ExporterEngine(self.db, self.config_loader.exporters)
        self.connectors = ConnectorEngine()
        self.connectors.agents.configure(self.config_loader.agents)
        self.connectors.agents.set_event_sink(self._on_agent_event)
        self.connectors.agents.set_connect_sink(self._on_agent_connected)
        self.action_jobs = ActionJobs(self)
        self.notifications = NotificationEngine(
            self.db, self.config_loader.notifications, self.connectors.agents
        )

    def _wire_plugin(self, plugin: Plugin, plugin_cfg: Dict) -> None:
        """Build the engine-owned IO for a plugin and hand it the read-only data
        view. Keeps pure plugins free of db/network. Persistence needs no
        per-plugin object: the engine holds the plugin's (target, id, name) and
        writes via db.apply_result on the collection/action path."""
        net = self.connectors.exec_context(plugin_cfg, collect_timeout=plugin.timeout)
        # The transport resolves the effective target host; keep the plugin's
        # target in sync so its labels/reads match what's collected, unless the
        # plugin is about some other host than the one it collects on.
        plugin.target = plugin.display_target or net.target
        self._exec_contexts[plugin.id] = net
        plugin.bind(PluginDataView(self.db, plugin.id))

        async def _cancel_exec(command: str, agent: Optional[str] = None, _net=net):
            from x_monitor.core.connectors.types import ActionPlan
            plan = ActionPlan(command, agent=agent)
            await self.connectors.execute(self._action_context(_net, plan), plan)

        plugin.jobs = JobsGateway(self.db, plugin, cancel_exec=_cancel_exec)
        if net.is_agent:
            self._wire_subscriptions(plugin, net)

    def _is_event_driven(self, plugin: Plugin) -> bool:
        """Whether this monitor's agent collects for it, so the engine runs no
        polling loop. Only ever true on an agent target: over SSH the streams
        are never registered and the poll stays the only collection path."""
        net = self._exec_context_for(plugin)
        if net is None or not net.is_agent:
            return False
        # A plugin's broken event_driven() must not stop scheduling; treat it as polled.
        try:
            return bool(plugin.event_driven())
        except Exception as e:
            log.error(f"{plugin.name}: event_driven() failed: {e}")
            return False

    def _wire_subscriptions(self, plugin: Plugin, net: "ExecContext") -> None:
        """Register a plugin's declared event streams with its agent, so the
        agent starts watching them the moment it connects. Streams are keyed by
        the plugin id, which is how an inbound event finds its way back here."""
        # A plugin's broken subscriptions() must not stop the engine wiring the rest.
        try:
            specs = plugin.subscriptions()
        except Exception as e:
            log.error(f"{plugin.name}: subscriptions() failed: {e}")
            return
        if not specs:
            return
        for spec in specs:
            net.conn.register_stream(spec)
            self._event_targets[spec.id] = plugin
            if spec.kind == 'sample':
                self._collection_streams.add(spec.id)
        log.info(
            f"{plugin.name}: subscribed to {len(specs)} agent event stream(s) "
            f"on {net.conn.agent_id!r}"
        )

    def _on_agent_event(self, agent_id: str, stream_id: str,
                        timestamp: float, payload: Dict) -> None:
        """Apply one pushed event. Runs on the agent's socket task, off the
        polling schedule entirely — this is the path that makes detection
        latency independent of a monitor's `interval`.

        The plugin's parse_event() is pure and the write is the same batched
        db.apply_result the polling cycle uses, so an event costs one parse and
        one buffered write with no IO of its own."""
        # The agent pushes again on its next interval, so dropping this loses nothing that hydration would not then overwrite.
        if not self.ready:
            return
        plugin = self._event_targets.get(stream_id)
        if plugin is None:
            log.debug(f"agent {agent_id!r}: event for unknown stream {stream_id!r}")
            return
        # A sample stream is this monitor's whole collection path, so its event
        # is what records the cycle the suppressed polling loop never runs.
        # Recorded before the parse, matching the poll's own finally: the mark
        # means a cycle arrived, not that it carried usable data.
        if stream_id in self._collection_streams:
            self._last_collected[plugin.id] = time.monotonic()
        # A plugin's broken parse_event() must not kill the agent's socket task.
        try:
            result = plugin.parse_event(stream_id, payload, timestamp)
        except Exception as e:
            log.error(f"{plugin.name}: parse_event failed for {stream_id!r}: {e}")
            return
        if result is not None:
            self._apply(plugin, result)
            self._check_triggers(plugin, result, time.time())

    def _on_agent_connected(self, agent_id: str) -> None:
        """Collect every monitor on an agent as soon as that agent dials in.

        Monitors start their schedule when X-Monitor does, but an agent takes a
        moment to connect, so a monitor's first cycle normally runs before its
        transport exists and records a failure. Without this the monitor stays
        wrong until its next tick — a full hour for the hourly SMART and ZFS
        checks after every restart, which is long enough to be mistaken for a
        real fault.

        Runs on the agent's socket task, so each cycle is a separate task
        rather than blocking the handshake. An agent that connects while the
        store is still loading is collected once it has loaded."""
        if not self.ready:
            self._early_agents.add(agent_id)
            return
        monitors = [p for p in self.all_monitors()
                    if getattr(self._exec_context_for(p), 'conn', None) is not None
                    and getattr(self._exec_context_for(p).conn, 'agent_id', None) == agent_id]
        if not monitors:
            return
        log.info(
            f"agent {agent_id!r} connected: collecting its {len(monitors)} monitor(s) now"
        )
        for plugin in monitors:
            self._spawn(self._collect_on_connect(plugin))

    async def _collect_on_connect(self, plugin: Plugin) -> None:
        # A failed warm-up cycle is only logged; the monitor's normal schedule retries.
        try:
            await self.run_cycle_now(plugin)
        except Exception as e:
            log.error(f"{plugin.name}: collection on agent connect failed: {e}")

    def _apply(self, plugin: Plugin, result) -> None:
        """Persist a plugin's CollectResult. The engine owns the write path and
        supplies the plugin's identity; pure plugins hold no writer."""
        self.db.apply_result(plugin.target, plugin.id, plugin.name, result)

    def _exec_context_for(self, plugin: Plugin):
        return self._exec_contexts.get(plugin.id)

    async def _run_io(self, fn):
        """Run a plugin's io_call()/IoActionPlan closure off the event loop
        (or await it if it's a coroutine function). Engine-owned so pure
        plugins never do their own thread offloading."""
        if inspect.iscoroutinefunction(fn):
            return await fn()
        return await asyncio.to_thread(fn)

    def _apply_ssh_defaults(self, plugin_cfg: Dict, defaults: Optional[Dict] = None) -> Dict:
        defaults = self.config_loader.ssh_defaults if defaults is None else defaults
        if not defaults or 'ssh_config' not in plugin_cfg:
            return plugin_cfg

        merged = dict(plugin_cfg)
        merged['ssh_config'] = {**defaults, **plugin_cfg['ssh_config']}
        return merged

    def _effective_config(self, plugin_cfg: Dict, ssh_defaults: Dict,
                          inherited_agent: Optional[str]) -> Dict:
        """A monitor's config as its plugin sees it: ssh_defaults merged in and its group's agent inherited."""
        cfg = self._apply_ssh_defaults(plugin_cfg, ssh_defaults)
        if inherited_agent and not cfg.get('agent'):
            cfg = {**cfg, 'agent': inherited_agent}
        return cfg

    def _build_tree(self, plugins_cfg: List[Dict], loader: PluginLoader, ssh_defaults: Dict,
                    keep: Dict[str, Plugin], errors: List[str], on_new=None,
                    inherited_agent: Optional[str] = None) -> List[_Node]:
        """Construct the monitors a config declares, reusing a running instance from `keep` wherever its config is unchanged.

        Nothing here touches the running tree: a kept group's new children are
        only recorded in its node, and put in place by _place. A `ref:` entry
        becomes a link node, resolved to the monitor it names once the whole tree is built."""
        nodes = []
        for plugin_cfg in plugins_cfg:
            if 'ref' in plugin_cfg:
                nodes.append(_Node(Link(str(plugin_cfg['ref']), plugin_cfg.get('name')), []))
                continue
            name = plugin_cfg.get('name')
            p_type = plugin_cfg.get('type')
            cfg = self._effective_config(plugin_cfg, ssh_defaults, inherited_agent)
            # One bad plugin config or module must not stop the rest from loading.
            try:
                cls = loader.resolve(p_type)
                existing = keep.get(cfg.get('id', name))
                if existing is not None and same_monitor(existing, cfg, cls):
                    plugin = existing
                else:
                    plugin = cls(name, cfg)
                    if on_new is not None:
                        on_new(plugin)
                    log.info(f"Loaded plugin '{name}' of type '{p_type}'")
            except Exception as e:
                errors.append(f"'{name}' ({p_type}): {e}")
                continue
            children = []
            if 'children' in cfg:
                children = self._build_tree(cfg['children'], loader, ssh_defaults, keep, errors,
                                            on_new=on_new, inherited_agent=cfg.get('agent'))
            nodes.append(_Node(plugin, children))
        return nodes

    @staticmethod
    def _attach(nodes: List[_Node]) -> List[Any]:
        """Give every monitor in a built tree its children, returning the roots with links still unresolved."""
        for node in nodes:
            if isinstance(node.plugin, Link):
                continue
            node.plugin.links = {}
            node.plugin.children = XMonitorEngine._attach(node.children)
        return [node.plugin for node in nodes]

    @staticmethod
    def _place(nodes: List[_Node]) -> List[Plugin]:
        """Put a built tree in place: attach every monitor's children, then swap each link for the monitor it names."""
        return resolve_links(XMonitorEngine._attach(nodes))

    def _wire_new(self, plugin: Plugin) -> None:
        plugin.engine = self
        self._wire_plugin(plugin, plugin.config)

    def setup_modules(self) -> List[Plugin]:
        """Build and wire the monitor tree config.yaml declares, skipping any monitor that fails to load."""
        errors: List[str] = []
        nodes = self._build_tree(self.config_loader.plugins, self._plugin_loader,
                                 self.config_loader.ssh_defaults, {}, errors, on_new=self._wire_new)
        for error in errors:
            log.error(f"Failed to load plugin {error} — this monitor will not run")
        self.plugins = self._place(nodes)
        log.info(f"Plugin registry built with {len(self.plugins)} root-level monitors.")
        self._warn_on_duplicate_ids()
        self._wire_self_monitor()
        return self.plugins

    def all_monitors(self) -> List[Plugin]:
        """Every monitor in the tree, once each, parents before children."""
        return list(iter_monitors(self.plugins))

    def _warn_on_duplicate_ids(self):
        seen = {}
        duplicates = {}
        # A linked monitor is the same instance in every place, so only separate definitions can collide.
        for p in self.all_monitors():
            if p.id in seen:
                duplicates.setdefault(p.id, [seen[p.id]]).append(p.name)
            else:
                seen[p.id] = p.name

        for dup_id, names in duplicates.items():
            log.error(
                f"Duplicate monitor id {dup_id!r} used by {len(names)} monitors "
                f"({', '.join(sorted(set(names)))}). Their status, metrics and logs "
                f"will overwrite each other — give each an explicit unique `id`."
            )
            self.db.insert_event(
                "ERROR",
                f"[x_monitor_core] Duplicate monitor id {dup_id!r} used by: "
                f"{', '.join(sorted(set(names)))}",
                "x_monitor_core",
            )

    def _wire_self_monitor(self):
        try:
            from x_monitor.plugins.x_monitor_self import XMonitorSelfPlugin
        except ImportError as e:
            log.debug(f"Self-monitoring plugin unavailable: {e}")
            return
        XMonitorSelfPlugin.engine = self

    def _start_exporters(self):
        self.exporters.start(lambda: self._flatten(self.plugins))

    @staticmethod
    def _flatten(plugins: List[Plugin]):
        return iter_monitors(plugins)

    async def _run_cycle(self, plugin: Plugin) -> bool:
        """The collection loop: all async/IO lives here; the plugin's
        requests()/parse_results() (and io_call() for the sequential-local-IO
        case) are pure and touched only from here.

        A plugin declares a heterogeneous request list (SSH Commands, HTTP,
        DNS, ICMP); the Connector Engine routes and executes them, and the
        plugin's pure parse_results() turns the results into a CollectResult
        the Database Engine persists. The rare plugin with genuinely
        sequential/conditional local IO uses io_call() instead."""
        started = time.perf_counter()
        io_fn = plugin.io_call()
        if io_fn is not None:
            io_result = await self._run_io(io_fn)
            collected = time.perf_counter()
            result = plugin.parse_results([io_result])
            did_io = True
            wait_seconds = 0.0
        else:
            requests = plugin.requests()
            net = self._exec_context_for(plugin)
            with measure_channel_wait() as wait:
                results = await self.connectors.dispatch(net, requests) if requests else []
            collected = time.perf_counter()
            wait_seconds = wait.seconds
            result = _settle(plugin, results, plugin.parse_results(results))
            did_io = bool(requests)
        parsed = time.perf_counter()
        if plugin in self._retired:
            return False
        self._apply(plugin, result)
        self._react(plugin, result)
        self._check_triggers(plugin, result, time.time())
        if did_io:
            self._cycle_stats.record(plugin.id, parsed - started, wait_seconds)
            if self._cycle_timings:
                self._record_cycle_timing(plugin, started, collected, parsed)
        return True

    def _record_cycle_timing(self, plugin: Plugin, started: float,
                             collected: float, parsed: float) -> None:
        """Record where a cycle's wall clock went, split so that transport cost
        and parse cost are separable rather than one opaque total."""
        self.db.insert_metric(plugin.target, plugin.id,
                              "cycle_collect_seconds", collected - started)
        self.db.insert_metric(plugin.target, plugin.id,
                              "cycle_parse_seconds", parsed - collected)

    async def run_cycle_now(self, plugin: Plugin) -> bool:
        """Single-flight wrapper for out-of-band (dashboard-poll-triggered)
        collection, sharing the same reentrancy guard as the scheduler."""
        if self._collecting.get(plugin.id):
            log.debug(f"{plugin.name}: previous collection still running, skipping poll-triggered cycle")
            return False
        self._collecting[plugin.id] = True
        try:
            async with self._targets_held_awake(plugin):
                return await self._run_cycle(plugin)
        finally:
            self._last_collected[plugin.id] = time.monotonic()
            self._collecting[plugin.id] = False

    def _target_agents(self, plugin: Plugin) -> List[Any]:
        """The connected agents on the hosts a monitor works on remotely, other than the one it runs on."""
        config = getattr(plugin, 'config', None) or {}
        hosts = {bare_host(config.get(key)) for key in _TARGET_HOST_KEYS if config.get(key)}
        if not hosts:
            return []
        own = getattr(self._exec_context_for(plugin), 'conn', None)
        return [conn for conn in self.connectors.agents.all
                if conn is not own and conn.is_connected and bare_host(conn.host) in hosts]

    @contextlib.asynccontextmanager
    async def _targets_held_awake(self, plugin: Plugin):
        """Keep the hosts a monitor scans or acts on from elsewhere awake while its task runs."""
        targets = self._target_agents(plugin)
        key = f"{plugin.id}:{uuid.uuid4().hex}"
        for conn in targets:
            await conn.inhibit(key, True)
        try:
            yield
        finally:
            for conn in targets:
                await conn.inhibit(key, False)

    def last_collected(self, plugin_id: str) -> float:
        """Monotonic time of a monitor's last finished cycle, 0.0 if none yet."""
        return self._last_collected.get(plugin_id, 0.0)

    def cycle_timing(self, plugin_id: str) -> Optional[CycleTiming]:
        """A monitor's recent cycle durations and SSH channel wait, None before its first cycle that did IO."""
        return self._cycle_stats.get(plugin_id)

    async def dispatch_action(self, plugin: Plugin, action_id: str, **kwargs) -> DispatchResult:
        """Run one action with the hosts it works on held awake; see _dispatch_action."""
        async with self._targets_held_awake(plugin):
            return await self._dispatch_action(plugin, action_id, **kwargs)

    async def _dispatch_action(self, plugin: Plugin, action_id: str, **kwargs) -> DispatchResult:
        """Returns (success, metadata). metadata is the applied CollectResult's
        .metadata dict when one was applied (e.g. carrying 'content' for
        read-style dialog actions), else None. Plain bool outcomes (the
        common write/dispatch case) return (bool, None)."""
        from x_monitor.core.connectors.types import (
            CollectResult, HttpRequest, DnsQuery, PingRequest, IoActionPlan,
        )

        net = self._exec_context_for(plugin)

        def _finish(outcome):
            return self.finish_action(plugin, outcome)

        custom = plugin.custom_action(action_id)
        if custom is not None:
            plan = custom.plan()
            if plan.detached:
                return await self.action_jobs.launch(plugin, action_id, plan, self._action_context(net, plan),
                                                     custom.interpret, kwargs)
            result = await self.connectors.execute(self._action_context(net, plan), plan)
            return _finish(custom.interpret(result))

        plan = plugin.plan_action(action_id, **kwargs)
        if plan is None:
            return False, None
        if isinstance(plan, CollectResult):
            self._apply(plugin, plan)
            return plan.success, (plan.metadata or None)
        if isinstance(plan, IoActionPlan):
            io_result = await self._run_io(plan.call)
            return _finish(plugin.interpret_action(action_id, io_result, **kwargs))
        if isinstance(plan, (HttpRequest, DnsQuery, PingRequest)):
            result = (await self.connectors.dispatch(net, [plan]))[0]
            return _finish(plugin.interpret_action(action_id, result, **kwargs))
        # Default: an ActionPlan — a short SSH command, on another monitor's transport when it names one.
        if plan.via:
            net = self._exec_contexts.get(plan.via)
            if net is None:
                missing = CmdResult(-1, "", f"No monitor {plan.via!r} to run this through")
                return _finish(plugin.interpret_action(action_id, missing, **kwargs))
        if plan.detached:
            return await self.action_jobs.launch(
                plugin, action_id, plan, self._action_context(net, plan),
                lambda result: plugin.interpret_action(action_id, result, **kwargs), kwargs)
        result = await self.connectors.execute(self._action_context(net, plan), plan)
        return _finish(plugin.interpret_action(action_id, result, **kwargs))

    def finish_action(self, plugin: Plugin, outcome) -> DispatchResult:
        """Persist an action's outcome when it is a CollectResult, and return it as (success, metadata)."""
        if isinstance(outcome, CollectResult):
            self._apply(plugin, outcome)
            return outcome.success, (outcome.metadata or None)
        return bool(outcome), None

    def job_context(self, plugin: Plugin, agent: Optional[str] = None):
        """The connection a job of this monitor runs over, or None when the monitor has none."""
        net = self._exec_context_for(plugin)
        if net is None:
            return None
        return self._action_context(net, ActionPlan('', agent=agent)) if agent else net

    def _action_context(self, net, plan):
        """The connection an ActionPlan runs over: the monitor's own target, or
        another agent's host when the plan names one."""
        if not plan.agent:
            return net
        return ExecContext(conn=self.connectors.agents.require(plan.agent),
                           collect_timeout=net.collect_timeout)

    def _react(self, plugin: Plugin, result: CollectResult) -> None:
        """Run the action a plugin asks for in reaction to the status its cycle just recorded, as its own task."""
        if result.status is None:
            return
        # A plugin's broken on_status() must not fail the cycle that already persisted.
        try:
            reaction = plugin.on_status(result.status, time.monotonic())
        except Exception as e:
            log.error(f"{plugin.name}: on_status() failed: {e}")
            return
        if reaction:
            action_id, kwargs = reaction
            self._spawn(self._run_reaction(plugin, action_id, kwargs))

    async def _run_reaction(self, plugin: Plugin, action_id: str, kwargs: Dict[str, Any]) -> None:
        # The action logs its own outcome; a crash in it is only logged, so the next cycle can ask again.
        try:
            await self.dispatch_action(plugin, action_id, **kwargs)
        except Exception as e:
            log.error(f"{plugin.name}: automatic {action_id!r} failed: {e}")

    def set_setting(self, key: str, value: str) -> None:
        """UI-triggered setting write (e.g. a group's expand/collapse state)
        the Database Engine persists. Pure plugins read settings via their
        data view and route the occasional write back through the engine."""
        self.db.set_setting(key, value)

    def apply(self, plugin: Plugin, result) -> None:
        """Persist a CollectResult a plugin produced outside the collection
        cycle (e.g. push.record_push from the REST endpoint). The plugin holds
        no writer of its own; the engine owns the write path."""
        self._apply(plugin, result)

    async def http_fetch(self, request):
        """Run one HttpRequest through the shared HttpConnector. For the rare
        plugin whose HTTP is genuinely sequential/dependent (a login POST for a
        session token, then a data GET using it) — expressed as an async
        io_call() closure that awaits this. The flat requests() list can't
        express request-to-request dependencies; this keeps that IO on the
        engine-owned connector instead of a plugin opening its own session."""
        return await self.connectors.http.fetch(request)

    async def _monitor_loop(self, plugin: Plugin):
        offset = getattr(plugin, "offset", None)
        if offset is None:
            await asyncio.sleep(random.uniform(0, STARTUP_JITTER_SECONDS))
        else:
            await asyncio.sleep(seconds_to_clock_slot(plugin.interval, offset, time.time()))
        next_due = time.monotonic()
        early = False
        while True:
            # A failing plugin cycle must not kill its polling loop; the next tick retries.
            try:
                await self.run_cycle_now(plugin)
            except Exception as e:
                log.error(f"Plugin execution error ({plugin.name}): {e}")
            # A clock-pinned monitor re-reads the wall clock each cycle, so a suspend or a slow cycle never shifts its slot.
            if offset is not None:
                wait = seconds_to_clock_slot(plugin.interval, offset, time.time())
                wait = wait if wait >= 1 else wait + plugin.interval
            else:
                # interval is the period, not the gap: sleep to the next due time
                # so a slow cycle does not stretch the schedule, and re-anchor
                # rather than burst when a cycle overruns the whole period.
                # An early cycle leaves the due time where it was.
                if not early:
                    next_due += plugin.interval
                now = time.monotonic()
                if next_due <= now:
                    next_due = now + plugin.interval
                wait = next_due - now
            sooner = _sooner_cycle(plugin)
            early = sooner is not None and sooner < wait
            await asyncio.sleep(sooner if early else wait)

    async def _schedule_loop(self):
        while True:
            # A broken schedule check must not end the loop; the next pass retries.
            try:
                self._start_due_schedules(time.time())
            except Exception as e:
                log.error(f"Scheduled action check failed: {e}")
            await asyncio.sleep(_SCHEDULE_CHECK_SECONDS)

    def _start_due_schedules(self, now: float) -> None:
        """Start every scheduled action whose next run has come, recording it as handled first.

        A schedule seen for the first time is only recorded, so it first runs
        at its next time rather than at once. Recording before the run means a
        restart never repeats it, and runs missed while X-Monitor was down collapse
        into one run when it returns."""
        for plugin in self._flatten(self.plugins):
            for entry in plugin.scheduled_actions:
                key = entry.state_key(plugin.id)
                if key in self._scheduled_running:
                    continue
                handled = self.db.get_setting(key)
                if handled is not None and not entry.due(float(handled), now):
                    continue
                self.db.set_setting(key, str(int(now)))
                if handled is None:
                    continue
                self._scheduled_running.add(key)
                self._spawn(self._run_scheduled(plugin, entry, key))

    async def _run_scheduled(self, plugin: Plugin, entry, key: str) -> None:
        """Run one scheduled action through the same path as its button, and record the outcome on the monitor and for the Schedules view."""
        label = f"Scheduled {entry.action} ({entry.cron.expression})"
        started = int(time.time())
        success = False
        try:
            success, _ = await self.dispatch_action(plugin, entry.action, **entry.args)
            log = (f"{label} ran", 'INFO') if success else (f"{label} failed", 'ERROR')
        # A failing action must not end the task silently; its error goes to the monitor's log.
        except Exception as e:
            log = (f"{label} failed: {e}", 'ERROR')
        finally:
            self._scheduled_running.discard(key)
        self.db.set_setting(entry.result_key(plugin.id),
                            json.dumps({'at': started, 'ok': bool(success), 'message': log[0]}))
        self._apply(plugin, CollectResult(logs=[log]))

    def _check_triggers(self, plugin: Plugin, result: CollectResult, now: float) -> None:
        """Start every triggered action whose condition this cycle has held long enough, recording it as run first.

        Recording before the run means a restart never repeats it for the same
        episode, and the entry runs again only after its condition clears."""
        for entry in getattr(plugin, 'triggered_actions', None) or []:
            key = entry.state_key(plugin.id)
            # A broken condition must not fail the cycle that already persisted, nor the other entries.
            try:
                state = self._trigger_state(key)
                new_state, fire = entry.step(state, entry.condition.holds(result), now)
                if new_state != state:
                    self._trigger_states[key] = new_state
                    self.db.set_setting(key, json.dumps(new_state))
            except Exception as e:
                log.error(f"{plugin.name}: trigger for {entry.action!r} failed: {e}")
                continue
            if fire:
                self._spawn(self._run_triggered(plugin, entry))

    def _trigger_state(self, key: str) -> Dict[str, Any]:
        """A trigger's state, read from the settings store the first time and kept in memory after."""
        if key not in self._trigger_states:
            try:
                stored = json.loads(self.db.get_setting(key) or '{}')
            except (json.JSONDecodeError, ValueError):
                stored = {}
            self._trigger_states[key] = stored if isinstance(stored, dict) else {}
        return self._trigger_states[key]

    async def _run_triggered(self, plugin: Plugin, entry) -> None:
        """Run one triggered action through the same path as its button, and record the outcome on the monitor and for the Schedules view."""
        label = f"Triggered {entry.action} ({entry.describe()})"
        started = int(time.time())
        success = False
        try:
            success, _ = await self.dispatch_action(plugin, entry.action, **entry.args)
            line = (f"{label} ran", 'INFO') if success else (f"{label} failed", 'ERROR')
        # A failing action must not end the task silently; its error goes to the monitor's log.
        except Exception as e:
            line = (f"{label} failed: {e}", 'ERROR')
        self.db.set_setting(entry.result_key(plugin.id),
                            json.dumps({'at': started, 'ok': bool(success), 'message': line[0]}))
        self._apply(plugin, CollectResult(logs=[line]))

    async def _prune_loop(self):
        while True:
            self._maybe_prune_logs()
            await asyncio.sleep(_PRUNE_CHECK_SECONDS)

    def _spawn(self, coro) -> "asyncio.Task":
        """Create a background task anchored in self._tasks for its lifetime."""
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def log_levels(self) -> Dict[str, str]:
        """The root log level plus every logger given a level of its own."""
        return self._log_levels.levels()

    def known_loggers(self) -> List[str]:
        """The names of X-Monitor's loggers, for picking one to change."""
        return self._log_levels.known_loggers()

    def set_log_level(self, logger: Optional[str], level: Optional[str],
                      source: str = 'runtime') -> Dict[str, str]:
        """Change one logger's level now, or the root's when logger is empty; no level makes a named logger inherit again."""
        return self._log_levels.set_level(logger, level, source=source)

    def _install_signal_handlers(self) -> None:
        """SIGHUP reloads config.yaml; SIGUSR1 and SIGUSR2 step logging more verbose or quieter, for when the dashboard is unreachable."""
        loop = asyncio.get_running_loop()
        handlers = {
            signal.SIGUSR1: lambda: self._log_levels.step(more_verbose=True, source='SIGUSR1'),
            signal.SIGUSR2: lambda: self._log_levels.step(more_verbose=False, source='SIGUSR2'),
            signal.SIGHUP: lambda: self._spawn(self.reload_config('SIGHUP')),
        }
        for signum, handler in handlers.items():
            # A loop that cannot take signal handlers (not the main thread, not Unix) just goes without.
            try:
                loop.add_signal_handler(signum, handler)
                self._signals_installed.append(signum)
            except (NotImplementedError, RuntimeError, ValueError) as e:
                log.warning(f"Cannot handle {signal.Signals(signum).name}: {e}")

    def _remove_signal_handlers(self) -> None:
        # The loop may already be closed at shutdown, in which case it dropped the handlers itself.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        for signum in self._signals_installed:
            if loop is not None:
                loop.remove_signal_handler(signum)
        self._signals_installed = []

    def shutdown(self) -> None:
        """Stop background tasks, close every transport, and flush pending
        writes to SQLite; registered as the UI server's shutdown hook."""
        self._remove_signal_handlers()
        for task in list(self._tasks):
            task.cancel()
        self.exporters.stop()
        self.notifications.stop()
        self.connectors.close()
        self.db.stop_downsampling()
        self.db.flush()
        log.info("X-Monitor Engine shut down cleanly.")

    def load_state(self) -> None:
        """Restores the store from the database and records the restart; blocking, so run() calls it off the event loop."""
        started = time.monotonic()
        self.db.hydrate()
        self.db.insert_event("INFO", "X-Monitor Engine initialized.", "x_monitor_core")
        orphaned = self.db.reconcile_orphaned_jobs()
        if orphaned:
            log.warning(f"Marked {orphaned} orphaned job(s) as failed after restart")
        log.info(f"Saved state loaded in {time.monotonic() - started:.1f}s")

    async def run(self):
        if not self.ready:
            await asyncio.get_running_loop().run_in_executor(None, self.load_state)
            self.ready = True
            for agent_id in sorted(self._early_agents):
                self._on_agent_connected(agent_id)
            self._early_agents.clear()
        log.info("X-Monitor Engine started...")

        self.db.insert_event("INFO", "X-Monitor Engine started polling loop.", "x_monitor_core")

        self._start_exporters()
        # Broken notification settings must not stop monitoring.
        try:
            self.notifications.start(self.plugins)
        except Exception as e:
            log.error(f"Failed to start notifications — none will be sent: {e}")

        monitors = self.all_monitors()
        polled = [p for p in monitors if not self._is_event_driven(p)]
        pushed = len(monitors) - len(polled)
        log.info(
            f"Starting {len(polled)} independent monitor schedule(s); "
            f"{pushed} collect on their agent."
        )
        for plugin in polled:
            self._monitor_tasks[plugin.id] = self._spawn(self._monitor_loop(plugin))

        if any(p.scheduled_actions for p in monitors):
            self._spawn(self._schedule_loop())
        self._spawn(self._prune_loop())
        self._spawn(self.action_jobs.run())
        self._spawn(self._watch_config())
        if self._handle_signals:
            self._install_signal_handlers()

    def _maybe_prune_logs(self, interval: float = 3600.0):
        # Nothing to prune if both retention windows are disabled (0/negative).
        if (self.log_retention_days <= 0 and self.metric_retention_days <= 0
                and self.metric_downsample_days <= 0):
            return
        now = time.monotonic()
        if now - self._last_prune < interval:
            return
        self._last_prune = now
        # A failed prune must not kill the prune loop; the next hourly pass retries.
        try:
            # Logs and jobs share the log-retention window; metrics and status
            # history use their own (metric_retention_days, which defaults to
            # log_retention_days when unset). Each prune_* is a no-op when its
            # window is <= 0, so the two schedules are independent.
            self.db.prune_logs(self.log_retention_days)
            self.db.prune_jobs(self.log_retention_days)
            self.db.prune_metrics(self.metric_retention_days)
            self.db.prune_status(self.metric_retention_days)
            self.db.downsample_metrics(self.metric_downsample_days)
        except Exception as e:
            log.error(f"Retention prune failed: {e}")

    # --- Config reload ---

    async def reload_config(self, source: str = 'api') -> ReloadResult:
        """Re-read config.yaml and apply it in place, or keep the running config and report why not.

        Monitors whose effective config is unchanged keep running untouched;
        removed ones stop, added ones start, and changed ones are replaced.
        Reloads run one at a time, and each records a summary event."""
        async with self._reload_lock:
            result = ReloadResult(source)
            if not self.ready:
                result.ok, result.error = False, 'X-Monitor is still starting'
                return result
            # Anything wrong with the new file must leave the running config exactly as it was.
            try:
                plan = await asyncio.to_thread(self._plan_reload)
            except Exception as e:
                result.ok, result.error = False, str(e)
                self._record_reload(result)
                return result
            await self._apply_reload(plan, result)
            self._record_reload(result)
            return result

    def _plan_reload(self) -> _ReloadPlan:
        """Parse the config file and construct every monitor it declares, raising on the first sign it cannot apply whole."""
        config = XMonitorConfig(str(self.config_loader.path), strict=True)
        loader = PluginLoader(parse_plugin_paths(config.plugin_paths, config.path.parent))
        keep = {p.id: p for p in self._flatten(self.plugins)}
        errors: List[str] = []
        nodes = self._build_tree(config.plugins, loader, config.ssh_defaults, keep, errors)
        if errors:
            raise ValueError(f"monitor {'; '.join(errors)}")
        ids = [node.plugin.id for node in _walk(nodes)]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        if duplicates:
            raise ValueError(f"duplicate monitor id(s) {', '.join(duplicates)} — give each an explicit unique `id`")
        return _ReloadPlan(config, loader, nodes)

    async def _apply_reload(self, plan: _ReloadPlan, result: ReloadResult) -> None:
        old = {p.id: p for p in self._flatten(self.plugins)}
        new = {node.plugin.id: node.plugin for node in _walk(plan.nodes)}
        result.added = sorted(i for i in new if i not in old)
        result.removed = sorted(i for i in old if i not in new)
        result.changed = sorted(i for i in new if i in old and new[i] is not old[i])
        old_config, old_shape = self.config, _shape(self.plugins)

        agents = await self._retire([old[i] for i in result.removed + result.changed])

        self.config_loader, self.config = plan.config, plan.config.data
        self._plugin_loader, self._config_digest = plan.loader, plan.config.digest
        self._apply_settings(old_config)

        fresh = [new[i] for i in result.added + result.changed]
        for plugin in fresh:
            # Wiring builds no IO, so it does not fail in practice; if it does, only that monitor stays down.
            try:
                self._wire_new(plugin)
            except Exception as e:
                log.error(f"{plugin.name}: could not be wired after reload — it will not run: {e}")
                continue
            net = self._exec_context_for(plugin)
            if net is not None and net.is_agent:
                agents.add(net.conn)
        self.plugins = self._place(plan.nodes)

        closed = self.connectors.close_unused(ctx.conn for ctx in self._exec_contexts.values())
        if closed:
            log.info(f"Closed {closed} SSH connection(s) no monitor uses any more")
        await asyncio.gather(*(conn.push_subscriptions() for conn in agents))
        for plugin in fresh:
            if plugin.id in self._exec_contexts and not self._is_event_driven(plugin):
                self._monitor_tasks[plugin.id] = self._spawn(self._monitor_loop(plugin))

        tree_changed = bool(result.added or result.removed or result.changed) or _shape(self.plugins) != old_shape
        if tree_changed or section_changed(old_config, self.config, 'notifications'):
            self._restart_notifications()
        if section_changed(old_config, self.config, 'exporters'):
            self.exporters.stop()
            self.exporters = ExporterEngine(self.db, self.config_loader.exporters)
            self._start_exporters()
        result.restart_required = restart_required(old_config, self.config, self._db_path_overridden)
        if tree_changed:
            self.monitors_version += 1
            CHANGES.publish(changes.MONITORS)

    async def _retire(self, plugins: List[Plugin]) -> Set[Any]:
        """Stop monitors a reload removes or replaces, returning the agents whose stream sets changed."""
        tasks, agents = [], set()
        for plugin in plugins:
            self._retired.add(plugin)
            task = self._monitor_tasks.pop(plugin.id, None)
            if task is not None:
                task.cancel()
                tasks.append(task)
            net = self._exec_contexts.pop(plugin.id, None)
            for stream_id in [s for s, target in self._event_targets.items() if target is plugin]:
                del self._event_targets[stream_id]
                self._collection_streams.discard(stream_id)
                if net is not None and net.is_agent:
                    net.conn.unregister_stream(stream_id)
                    agents.add(net.conn)
        await asyncio.gather(*tasks, return_exceptions=True)
        for plugin in plugins:
            self._collecting.pop(plugin.id, None)
            self._last_collected.pop(plugin.id, None)
            self._cycle_stats.forget(plugin.id)
        # The agent keeps a stream whose id it already runs, so retired streams leave first and a changed one restarts.
        await asyncio.gather(*(conn.push_subscriptions() for conn in agents))
        return agents

    def _apply_settings(self, old_config: Dict) -> None:
        """Apply the global settings a reload can change in place."""
        self.log_retention_days = self.config_loader.log_retention_days
        self.metric_retention_days = self.config_loader.metric_retention_days
        self.metric_downsample_days = self.config_loader.metric_downsample_days
        self._cycle_timings = self.config_loader.cycle_timings
        old_logging, new_logging = old_config.get('logging') or {}, self.config.get('logging') or {}
        if (old_logging.get('level'), old_logging.get('levels')) != (new_logging.get('level'), new_logging.get('levels')):
            self._log_levels.configure(self.config_loader.log_level, self.config_loader.log_levels)
        if section_changed(old_config, self.config, 'agents'):
            self.connectors.agents.configure(self.config_loader.agents)

    def _restart_notifications(self) -> None:
        # Deliveries already under way finish; only the watching moves to the new rules.
        self.notifications.stop(cancel_deliveries=False)
        self.notifications = NotificationEngine(
            self.db, self.config_loader.notifications, self.connectors.agents
        )
        # Broken notification settings must not stop monitoring.
        try:
            self.notifications.start(self.plugins)
        except Exception as e:
            log.error(f"Failed to start notifications after reload — none will be sent: {e}")

    def _record_reload(self, result: ReloadResult) -> None:
        if not result.ok:
            level = "ERROR"
        elif result.restart_required:
            level = "WARNING"
        else:
            level = "INFO"
        log.log(logging.getLevelName(level), result.summary())
        self.db.insert_event(level, f"[x_monitor_core] {result.summary()}", "x_monitor_core")

    def _config_fingerprint(self) -> Optional[tuple]:
        """What the config path points at and when it last changed; a re-pointed symlink or a replaced file changes it."""
        try:
            real = os.path.realpath(self.config_loader.path)
            stat = os.stat(real)
        except OSError:
            return None
        return real, stat.st_ino, stat.st_mtime_ns, stat.st_size

    def _config_file_digest(self) -> Optional[str]:
        try:
            return hashlib.sha256(self.config_loader.path.read_bytes()).hexdigest()
        except OSError:
            return None

    async def _watch_config(self) -> None:
        """Reload when config.yaml changes: checked every few seconds, and applied once it has held still for one check."""
        seen = pending = None
        while True:
            await asyncio.sleep(CONFIG_POLL_SECONDS)
            current = self._config_fingerprint()
            if current is None or current == seen:
                pending = None
                continue
            if current != pending:
                pending = current
                continue
            seen, pending = current, None
            if self._config_file_digest() == self._config_digest:
                continue
            # A failed reload is already reported; the watcher keeps watching.
            try:
                await self.reload_config('file change')
            except Exception as e:
                log.error(f"Config reload after a file change failed: {e}")
