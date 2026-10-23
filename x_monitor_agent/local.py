"""The monitors an agent runs itself, from the plan file in its state directory, connected to the server or not."""

import json
import logging
import os
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Tuple

import yaml

log = logging.getLogger(__name__)

PLAN_FILE = 'plan.yaml'
PLAN_VERSION_FILE = 'plan.version'
DATABASE_FILE = 'agent.db'

# How many recent action request ids the agent remembers, so an action resent after a reconnect runs once.
_REMEMBERED_ACTIONS = 200


def plan_path(state_dir: str) -> Path:
    """Where the agent keeps the plan the server last sent it."""
    return Path(state_dir) / PLAN_FILE


class LocalRunner:
    """Owns the agent's local engine: starts it from a stored plan, applies new plans, and serves the server's sync, action and poll requests."""

    def __init__(self, agent_id: str, state_dir: str):
        self.agent_id = agent_id
        self.state_dir = Path(state_dir)
        self.engine = None
        self._actions: "OrderedDict[str, Tuple[bool, str]]" = OrderedDict()

    # ===== Plan =====

    @property
    def plan_version(self) -> str:
        """The version of the plan on disk, or '' before the server has sent one."""
        try:
            return (self.state_dir / PLAN_VERSION_FILE).read_text().strip()
        except OSError:
            return ''

    async def start(self) -> None:
        """Start the engine over the stored plan, if there is one."""
        plan = plan_path(str(self.state_dir))
        if self.engine is not None or not plan.exists():
            return
        # Imported here so an agent that has never been handed monitors does not load the engine.
        from x_monitor.core.coordination.local_engine import LocalEngine
        self.engine = LocalEngine(self.agent_id, str(plan), str(self.state_dir / DATABASE_FILE))
        self.engine.setup_modules()
        await self.engine.run()
        log.info(f"running {len(self.engine.all_monitors())} monitor(s) from {plan}")

    async def apply_plan(self, version: str, config: Dict[str, Any]) -> None:
        """Store a plan the server sent and run it, reloading the engine in place when one is already running."""
        if version and version == self.plan_version and self.engine is not None:
            return
        self.state_dir.mkdir(parents=True, exist_ok=True)
        _write_atomically(plan_path(str(self.state_dir)), yaml.safe_dump(config, sort_keys=False))
        _write_atomically(self.state_dir / PLAN_VERSION_FILE, version)
        if self.engine is None:
            await self.start()
        else:
            result = await self.engine.reload_config('plan')
            if not result.ok:
                log.error(f"could not apply plan {version}: {result.error}")

    def stop(self) -> None:
        """Stop the engine, flushing what it recorded to disk."""
        if self.engine is not None:
            self.engine.shutdown()
            self.engine = None

    # ===== Records =====

    def pending(self, after: int, limit: int = 500) -> List[List[Any]]:
        """The outbox records past `after` as [seq, kind, payload] entries, or none while no engine runs."""
        if self.engine is None:
            return []
        return [[seq, kind, payload] for seq, kind, payload in self.engine.db.pending(after=after, limit=limit)]

    def acknowledge(self, through: int) -> None:
        """Forget the records the server has stored, and drop the oldest results if the outbox has grown past its limit."""
        if self.engine is None:
            return
        self.engine.db.acknowledge(through)
        self.engine.db.trim()

    # ===== Requests from the server =====

    def _monitor(self, monitor_id: str):
        if self.engine is None:
            return None
        return next((p for p in self.engine.all_monitors() if p.id == monitor_id), None)

    async def run_action(self, request_id: str, monitor_id: str, action_id: str,
                         args: Dict[str, Any]) -> Tuple[bool, str]:
        """Run an action on one of the agent's monitors and return (success, what it reported); a repeated request id returns its first answer."""
        if request_id in self._actions:
            return self._actions[request_id]
        plugin = self._monitor(monitor_id)
        if plugin is None:
            answer = (False, f"This agent does not run monitor {monitor_id!r}")
        else:
            try:
                success, metadata = await self.engine.dispatch_action(plugin, action_id, **args)
                answer = (bool(success), _content(metadata))
            # The server asked for this action; its failure is the answer, not a reason to drop the connection.
            except Exception as e:
                answer = (False, f"{action_id} failed on the agent: {e}")
        self._actions[request_id] = answer
        while len(self._actions) > _REMEMBERED_ACTIONS:
            self._actions.popitem(last=False)
        return answer

    async def poll_now(self, monitor_id: str) -> None:
        """Run one cycle of a monitor now."""
        plugin = self._monitor(monitor_id)
        if plugin is not None:
            await self.engine.run_cycle_now(plugin)


def _content(metadata: Any) -> str:
    """The text an action reported, as the server's dialogs show it."""
    if isinstance(metadata, dict):
        content = metadata.get('content', '')
        return content if isinstance(content, str) else json.dumps(content)
    return ''


def _write_atomically(path: Path, text: str) -> None:
    """Replace a file in one step, so the engine's watcher never reads half a plan."""
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(text)
    os.replace(temporary, path)
