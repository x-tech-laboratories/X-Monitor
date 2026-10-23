"""Desktop notifications an agent raises itself while X-Monitor is out of reach.

The system agent runs the host's monitors but has no desktop session, and the
notify-only agent in the user's session only hears from the server. So the
system agent serves NOTIFY frames on a local socket, and the desktop agent
follows that socket as well as the server. While the server is unreachable,
the system agent sends each status change of its monitors there; once the
server is back, notifications come from the server as usual."""

import asyncio
import logging
import os
from typing import Any, Callable, Dict, Optional, Set

from x_monitor_agent import protocol as proto

log = logging.getLogger(__name__)

# How long a desktop agent waits before trying the system agent's socket again.
_RETRY_SECONDS = 5.0

# The statuses a local notification is raised for, and the ones whose end is reported as a recovery.
_PROBLEMS = ('failed', 'warning')


class LocalNotifier:
    """Serves NOTIFY and DISMISS frames, one JSON line each, to every desktop agent connected to a local socket."""

    def __init__(self, path: str):
        self.path = path
        self._server: Optional[asyncio.AbstractServer] = None
        self._writers: Set[asyncio.StreamWriter] = set()

    async def start(self) -> None:
        """Listen on the socket, replacing one a previous run left behind."""
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        self._server = await asyncio.start_unix_server(self._serve, path=self.path)
        # Desktop agents run as the desktop's user, so the socket is open to every local user; it only carries notifications out.
        os.chmod(self.path, 0o666)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        try:
            await reader.read()
        finally:
            self._writers.discard(writer)
            writer.close()

    async def send(self, frame: Dict[str, Any]) -> None:
        """Hand one frame to every connected desktop agent; one that has gone away is dropped."""
        line = (proto.encode(frame) + "\n").encode()
        for writer in list(self._writers):
            try:
                writer.write(line)
                await writer.drain()
            except (ConnectionError, OSError):
                self._writers.discard(writer)

    def close(self) -> None:
        if self._server is not None:
            self._server.close()
            self._server = None


async def follow(path: str, handle: Callable[[Dict[str, Any]], Any]) -> None:
    """Pass every frame the system agent serves on `path` to `handle`, reconnecting whenever the socket is not there."""
    while True:
        try:
            reader, writer = await asyncio.open_unix_connection(path)
        except (FileNotFoundError, ConnectionError, OSError):
            await asyncio.sleep(_RETRY_SECONDS)
            continue
        try:
            async for line in reader:
                frame = proto.decode(line.decode())
                if frame.get('t') in (proto.NOTIFY, proto.DISMISS):
                    await handle(frame)
        except (ConnectionError, OSError, ValueError) as e:
            log.debug(f"local notifications from {path} ended: {e}")
        finally:
            writer.close()
        await asyncio.sleep(_RETRY_SECONDS)


class OfflineAlerts:
    """Turns status changes of the agent's own monitors into local notifications, but only while the server is out of reach."""

    def __init__(self, notifier: LocalNotifier, engine: Callable[[], Any],
                 connected: Callable[[], bool], agent_id: str):
        self.notifier = notifier
        self._engine = engine
        self._connected = connected
        self.agent_id = agent_id
        self._last: Dict[str, str] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._tasks: Set[asyncio.Task] = set()

    def start(self) -> Callable[[], None]:
        """Watch the agent's status writes; returns the callable that stops watching."""
        # Imported here so a desktop agent never loads the engine's modules.
        from x_monitor.core.state import changes
        self._loop = asyncio.get_running_loop()

        def on_change(kind: str, plugin_id: Optional[str]) -> None:
            if kind == changes.STATUS and plugin_id:
                self._loop.call_soon_threadsafe(self.observe, plugin_id)

        return changes.CHANGES.subscribe(on_change)

    def observe(self, plugin_id: str) -> None:
        """Note a monitor's new status, notifying when it changed while the server cannot be reached."""
        engine = self._engine()
        if engine is None:
            return
        status = engine.db.latest_status(plugin_id)
        previous = self._last.get(plugin_id)
        self._last[plugin_id] = status
        if self._connected() or previous is None or previous == status:
            return
        frame = self.frame(plugin_id, self._name(engine, plugin_id), previous, status)
        if frame is not None:
            task = asyncio.ensure_future(self.notifier.send(frame))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    def frame(self, plugin_id: str, name: str, previous: str, status: str) -> Optional[Dict[str, Any]]:
        """The notification for one change, or None when the change is not worth one."""
        note = f"Seen on {self.agent_id} while X-Monitor was out of reach"
        if status in _PROBLEMS:
            urgency = 'critical' if status == 'failed' else 'normal'
            return proto.notify(f"{name} is {status}", note, urgency, key=f"local:{plugin_id}")
        if previous in _PROBLEMS:
            return proto.notify(f"{name} recovered", note, 'low', key=f"local:{plugin_id}")
        return None

    @staticmethod
    def _name(engine: Any, plugin_id: str) -> str:
        return next((p.name for p in engine.all_monitors() if p.id == plugin_id), plugin_id)
