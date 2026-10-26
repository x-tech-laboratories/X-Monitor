"""The server's side of agents that run their host's monitors themselves.

For each agent configured with `run_monitors`, the server compiles a plan:
the effective config of every monitor on that agent whose plugin can run on
its own host. The agent acknowledges the plan version it runs, and from then
on those monitors are the agent's: the server no longer polls, schedules or
triggers them, applies the records the agent syncs instead, sends their
buttons down as actions, and marks them unavailable when the agent goes
quiet. Which monitors an agent has taken survives a restart in the settings
store, so an agent that is offline keeps its monitors."""

import hashlib
import json
import logging
import time
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set, Tuple

from x_monitor.core.connectors import agent_protocol as proto
from x_monitor.core.connectors.types import CollectResult
from x_monitor.core.database.database import LATE_STATUS
from x_monitor.core.sync import records
from x_monitor.plugins.base.plugin_helpers import format_duration

if TYPE_CHECKING:
    from x_monitor.core.coordination.engine import XMonitorEngine
    from x_monitor.plugins.base.plugin_base import Plugin

log = logging.getLogger(__name__)

_PLAN_SETTING = 'agent-plan:{}'
_SEQ_SETTING = 'agent-seq:{}'
_JOB_SETTING = 'agent-job:{}:{}'

# Retention for the agent's own database, which only has to outlast an offline stretch.
_AGENT_RETENTION_DAYS = 3

# How long an action sent to an agent may take to answer before the button reports a timeout.
ACTION_TIMEOUT = 300.0

# A monitor whose agent has sent nothing for this many intervals, and at least the floor, is marked unavailable.
_SILENT_INTERVALS = 3
_SILENT_FLOOR_SECONDS = 300.0


class AgentPlans:
    """Plans, acknowledgements, record sync and action routing for the agents that run monitors."""

    def __init__(self, engine: 'XMonitorEngine'):
        self.engine = engine
        # Each agent's acknowledged plan: its version and the ids of the monitors it runs.
        self._acked: Dict[str, Tuple[str, Set[str]]] = {}
        self._loaded = False
        # When each agent-run monitor last had a record, monotonic, and which are already marked silent.
        self._last_record: Dict[str, float] = {}
        self._silent: Set[str] = set()
        self._started = time.monotonic()
        # For an agent that went quiet: when, each monitor's status before it did, and the status changes its sync reports.
        self._offline_since: Dict[str, float] = {}
        self._baseline: Dict[str, str] = {}
        self._backlog: Dict[str, Dict[str, List[Tuple[datetime, str]]]] = {}

    # ===== Which monitors an agent runs =====

    def _load(self) -> None:
        """Read every agent's acknowledged plan from the settings store, once the store is ready."""
        if self._loaded or not self.engine.ready:
            return
        for conn in self.engine.connectors.agents.all:
            raw = self.engine.db.get_setting(_PLAN_SETTING.format(conn.agent_id))
            try:
                stored = json.loads(raw) if raw else None
            except (json.JSONDecodeError, ValueError):
                stored = None
            if isinstance(stored, dict):
                self._acked[conn.agent_id] = (str(stored.get('version', '')), set(stored.get('monitors') or []))
        self._loaded = True

    def runs(self, plugin: 'Plugin') -> bool:
        """Whether this monitor's agent runs it, so the server must not collect, schedule or trigger it itself."""
        self._load()
        agent_id = _agent_of(plugin)
        if not agent_id:
            return False
        conn = self.engine.connectors.agents.get(agent_id)
        if conn is None or not conn.run_monitors:
            return False
        return plugin.id in self._acked.get(agent_id, ('', set()))[1]

    def compile(self, agent_id: str) -> Tuple[str, Dict[str, Any], List[str]]:
        """The agent's plan as (version, config, monitor ids): every monitor on it whose plugin runs on its own host."""
        monitors = [p for p in self.engine.all_monitors()
                    if _agent_of(p) == agent_id and getattr(p, 'RUNS_ON_AGENT', False) and not p.children]
        config = {
            'log_retention_days': _AGENT_RETENTION_DAYS,
            'metric_retention_days': _AGENT_RETENTION_DAYS,
            'plugins': [_plan_entry(p) for p in monitors],
        }
        version = hashlib.sha256(json.dumps(config, sort_keys=True, default=str).encode()).hexdigest()[:16]
        return version, config, [p.id for p in monitors]

    async def refresh(self) -> None:
        """Send every connected agent that runs monitors its plan if it changed, as after a config reload."""
        for conn in self.engine.connectors.agents.all:
            if conn.runs_engine:
                version, config, _ = self.compile(conn.agent_id)
                if version != self._acked.get(conn.agent_id, ('', set()))[0]:
                    await conn.send_plan(version, config)

    # ===== Frames from the agent =====

    async def on_frame(self, agent_id: str, frame: Dict[str, Any]) -> None:
        """Handle a PLAN_ACK or RECORDS frame from an agent."""
        if frame.get('t') == proto.PLAN_ACK:
            await self._on_plan_ack(agent_id, str(frame.get('version') or ''))
        elif frame.get('t') == proto.RECORDS:
            batch = frame.get('records')
            await self._on_records(agent_id, batch if isinstance(batch, list) else [])

    async def _on_plan_ack(self, agent_id: str, version: str) -> None:
        """Take the monitors of the plan the agent runs, or send it the current plan when it runs another."""
        self._load()
        conn = self.engine.connectors.agents.get(agent_id)
        if conn is None or not conn.runs_engine:
            return
        current, config, monitor_ids = self.compile(agent_id)
        if version != current:
            await conn.send_plan(current, config)
            return
        self._acked[agent_id] = (version, set(monitor_ids))
        self.engine.db.set_setting(_PLAN_SETTING.format(agent_id),
                                   json.dumps({'version': version, 'monitors': monitor_ids}))
        now = time.monotonic()
        for monitor_id in monitor_ids:
            self._last_record.setdefault(monitor_id, now)
        # The agent collects these itself now, so the streams the server had it run for them go.
        for monitor_id in monitor_ids:
            conn.unregister_stream(monitor_id)
        await conn.push_subscriptions()
        log.info(f"agent {agent_id!r} runs {len(monitor_ids)} monitor(s) itself (plan {version})")

    async def _on_records(self, agent_id: str, batch: List[Any]) -> None:
        """Store a batch of the agent's records in order, skipping any already stored, then acknowledge it."""
        self._load()
        seq_key = _SEQ_SETTING.format(agent_id)
        stored = int(self.engine.db.get_setting(seq_key) or 0)
        through = stored
        for entry in batch:
            try:
                seq, kind, payload = int(entry[0]), str(entry[1]), entry[2]
            except (TypeError, ValueError, IndexError):
                continue
            if seq <= stored:
                through = max(through, seq)
                continue
            # One bad record must not stall the sync behind it.
            try:
                self._apply_record(agent_id, kind, payload)
            except Exception as e:
                log.error(f"agent {agent_id!r}: could not apply record {seq} ({kind}): {e}")
            through = max(through, seq)
        if through > stored:
            self.engine.db.set_setting(seq_key, str(through))
        conn = self.engine.connectors.agents.get(agent_id)
        if conn is not None and through:
            await conn.ack_records(through)

    def _apply_record(self, agent_id: str, kind: str, payload: Dict[str, Any]) -> None:
        """Apply one record to the server's store as if the server had made the write itself."""
        db = self.engine.db
        if kind == records.RESULT:
            _, plugin_id, plugin_name, result = records.decode_result(payload)
            plugin = self._monitor(plugin_id)
            target = plugin.target if plugin is not None else payload.get('target', agent_id)
            db.apply_result(target, plugin_id, plugin.name if plugin is not None else plugin_name, result)
            self._last_record[plugin_id] = time.monotonic()
            self._silent.discard(plugin_id)
            if result.status is not None and agent_id in self._offline_since:
                self._note_offline_status(agent_id, plugin_id, result.status, result.timestamp)
        elif kind == records.SETTING:
            db.set_setting(str(payload['key']), str(payload['value']))
        elif kind == records.JOB:
            self._apply_job(agent_id, payload)

    def _apply_job(self, agent_id: str, payload: Dict[str, Any]) -> None:
        """Mirror one step of an agent's job under a server job id of its own."""
        db = self.engine.db
        step, agent_job = payload.get('step'), payload.get('job_id')
        key = _JOB_SETTING.format(agent_id, agent_job)
        if step == records.JOB_CREATE:
            job_id = db.create_job(plugin_id=payload['plugin_id'], target=payload.get('target', agent_id),
                                   kind=payload.get('kind', 'job'), command=payload.get('command', ''),
                                   workdir=payload.get('workdir'))
            db.set_setting(key, str(job_id))
            return
        mapped = db.get_setting(key)
        if mapped is None:
            return
        job_id = int(mapped)
        if step == records.JOB_PID:
            db.set_job_pid(job_id, int(payload['pid']))
        elif step == records.JOB_PROGRESS:
            db.set_job_progress(job_id, str(payload['progress']))
        elif step == records.JOB_OUTPUT:
            db.append_job_output(job_id, payload.get('lines') or [], payload.get('stream', 'stdout'))
        elif step == records.JOB_OUTPUT_SEQ:
            db.bump_job_output_seq(job_id, int(payload['output_seq']))
        elif step == records.JOB_FINISH:
            db.finish_job(job_id, str(payload['state']), exit_code=payload.get('exit_code'),
                          error=payload.get('error'))

    # ===== What the server still does for an agent-run monitor =====

    def check_silence(self, plugin: 'Plugin') -> None:
        """Mark an agent-run monitor unavailable once its agent has sent nothing for several of its intervals."""
        limit = max(_SILENT_INTERVALS * float(plugin.interval or 60), _SILENT_FLOOR_SECONDS)
        last = self._last_record.get(plugin.id, self._started)
        if plugin.id in self._silent or time.monotonic() - last < limit:
            return
        self._silent.add(plugin.id)
        agent_id = _agent_of(plugin)
        self._offline_since.setdefault(agent_id, time.time() - (time.monotonic() - last))
        self._baseline[plugin.id] = self.engine.db.latest_status(plugin.id)
        since = datetime.fromtimestamp(time.time() - (time.monotonic() - last)).strftime('%Y-%m-%d %H:%M')
        self.engine._apply(plugin, CollectResult(
            status='unavailable',
            logs=[(f"Agent {agent_id!r} runs this monitor and has sent nothing since {since}", 'WARNING')]))

    def _note_offline_status(self, agent_id: str, plugin_id: str, status: str, when: Optional[datetime]) -> None:
        """Collect a status the agent recorded while away, and send the summary once its live records resume."""
        when = when or datetime.now()
        if datetime.now() - when > LATE_STATUS:
            changes = self._backlog.setdefault(agent_id, {}).setdefault(plugin_id, [])
            previous = changes[-1][1] if changes else self._baseline.get(plugin_id)
            if status != previous:
                changes.append((when, status))
            return
        self._send_offline_summary(agent_id)

    def _send_offline_summary(self, agent_id: str) -> None:
        """Notify once that an agent is back, listing each monitor's status changes while it was away."""
        since = self._offline_since.pop(agent_id, None)
        backlog = self._backlog.pop(agent_id, {})
        if since is None:
            return
        names = {p.id: p.name for p in self.engine.all_monitors()}
        lines = [f"{names.get(pid, pid)}: " + ", ".join(f"{status} at {when:%H:%M}" for when, status in changes)
                 for pid, changes in sorted(backlog.items(), key=lambda item: names.get(item[0], item[0])) if changes]
        statuses = {status for changes in backlog.values() for _, status in changes}
        title = f"{agent_id} is back after {format_duration(int(time.time() - since))} out of reach"
        body = "\n".join(lines) if lines else "No monitor changed status while it was out of reach."
        monitor_ids = sorted(self._acked.get(agent_id, ('', set()))[1])
        self.engine.notifications.send_summary(title, body, monitor_ids,
                                               'failed' if 'failed' in statuses else 'online')
        log.info(f"{title}: {len(lines)} monitor(s) changed status")

    async def dispatch(self, plugin: 'Plugin', action_id: str, **kwargs: Any) -> Tuple[bool, Optional[Dict[str, str]]]:
        """Run a button's action on the agent that runs the monitor, returning what the engine's dispatch returns."""
        conn = self.engine.connectors.agents.get(_agent_of(plugin))
        if conn is None:
            return False, {'content': f"No agent runs {plugin.name}"}
        success, metadata = await conn.request_action(uuid.uuid4().hex, plugin.id, action_id, kwargs, ACTION_TIMEOUT)
        # A broken absorb must not lose the action's answer.
        try:
            plugin.absorb_remote_action(action_id, metadata, **kwargs)
        except Exception as e:
            log.error(f"{plugin.name}: could not take in what {action_id} reported: {e}")
        return success, (metadata or None)

    async def poll_now(self, plugin: 'Plugin') -> bool:
        """Ask the agent for a cycle now; the result arrives as a record."""
        conn = self.engine.connectors.agents.get(_agent_of(plugin))
        if conn is None or not conn.is_connected:
            return False
        await conn.poll_now(plugin.id)
        return True

    def _monitor(self, monitor_id: str) -> Optional['Plugin']:
        return next((p for p in self.engine.all_monitors() if p.id == monitor_id), None)


def _agent_of(plugin: 'Plugin') -> str:
    """The agent a monitor runs on, or '' for one reached over SSH or run on the server."""
    return str((getattr(plugin, 'config', None) or {}).get('agent') or '')


def _plan_entry(plugin: 'Plugin') -> Dict[str, Any]:
    """A monitor's effective config as the agent's engine reads it."""
    entry = {key: value for key, value in plugin.config.items() if key != 'children'}
    entry.setdefault('id', plugin.id)
    entry.setdefault('name', plugin.name)
    return entry
