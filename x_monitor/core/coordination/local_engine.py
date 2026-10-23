"""The engine an agent runs: the server's own engine, over its host's monitors only, recording into a local database with an outbox."""

from x_monitor.core.coordination.engine import XMonitorEngine
from x_monitor.core.database.agent_database import AgentDatabase


class LocalEngine(XMonitorEngine):
    """Runs the monitors in a plan file the way the server runs config.yaml: polls, schedules, triggers and detached jobs.

    The plan file is an ordinary X-Monitor config holding only this agent's monitors, each naming
    this agent, so their commands run locally. The engine watches the file and reloads it in place
    when the server sends a new plan. Every write also lands in the database's outbox for the
    server to collect, whether or not the agent is connected."""

    def __init__(self, agent_id: str, plan_path: str, db_path: str, handle_signals: bool = False):
        self.local_agent = agent_id
        super().__init__(plan_path, db_path_override=db_path, handle_signals=handle_signals)

    def _open_database(self, path: str) -> AgentDatabase:
        return AgentDatabase(
            path,
            write_batch_seconds=self.config_loader.write_batch_seconds,
            buffers=self.config_loader.buffer_sizes,
            hydrate=False,
        )
