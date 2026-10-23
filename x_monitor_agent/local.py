"""The monitors an agent runs itself, from the plan file in its state directory, connected to the server or not."""

import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

PLAN_FILE = 'plan.yaml'
DATABASE_FILE = 'agent.db'


def plan_path(state_dir: str) -> Path:
    """Where the agent keeps the plan the server last sent it."""
    return Path(state_dir) / PLAN_FILE


async def start_local_engine(agent_id: str, state_dir: str):
    """Start the engine over the plan in `state_dir` and return it, or None when there is no plan yet."""
    plan = plan_path(state_dir)
    if not plan.exists():
        return None
    # Imported here so an agent that has never been handed monitors does not load the engine.
    from x_monitor.core.coordination.local_engine import LocalEngine
    engine = LocalEngine(agent_id, str(plan), str(Path(state_dir) / DATABASE_FILE))
    engine.setup_modules()
    await engine.run()
    log.info(f"running {len(engine.all_monitors())} monitor(s) from {plan}")
    return engine


def stop_local_engine(engine: Optional[object]) -> None:
    """Stop a running local engine, flushing what it recorded to disk."""
    if engine is not None:
        engine.shutdown()
