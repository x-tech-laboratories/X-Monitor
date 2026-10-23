"""Runs a monitor's commands on the host X-Monitor itself runs on, which is how an agent runs the monitors it is handed."""

from typing import Tuple

from x_monitor_agent import executor

LOCAL_EXEC_TIMEOUT = 60.0


class LocalConnection:
    """A transport with the same execute() shape as SSHConnection and AgentConnection, running each command as a local process."""

    def __init__(self, host: str):
        self.host = host

    async def execute(self, command: str, timeout: float = LOCAL_EXEC_TIMEOUT) -> Tuple[int, str, str]:
        """Run one command here, mapping any failure to (-1, "", message) like the other transports."""
        return await executor.run(command, timeout)

    def close(self) -> None:
        """Nothing to close: each command is its own process."""
