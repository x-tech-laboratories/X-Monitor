"""Agent connector — the server half of the X-Monitor agent transport.

An agent dials in over a WebSocket and stays connected. This module holds
the server-side view of that link:

* :class:`AgentConnection` — one connected (or currently absent) agent. Its
  ``execute()`` has the same ``(exit_code, stdout, stderr)`` shape as
  ``SSHConnection.execute()``, so the Connector Engine can hand a plugin an
  agent-backed handle and every existing plugin runs unchanged.
* :class:`AgentRegistry` — the id -> connection map, plus the event fan-out
  to whichever monitor subscribed to a stream.

An agent that is configured but not currently connected is not an error at
construction time: the connection object exists from startup and fails each
call with a clear message until the agent dials in. That keeps the monitor
schedule identical whether the target is up or down, exactly as a refused
SSH dial does today.

Unlike SSH there is no per-host session ceiling here — commands are frames
multiplexed on one socket, so concurrency is bounded only by what the target
can usefully run at once.
"""

import asyncio
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from x_monitor.core.connectors import agent_protocol as proto
from x_monitor.core.connectors.agent_protocol import StreamSpec
from x_monitor_agent import keys

log = logging.getLogger(__name__)

EXEC_TIMEOUT = 30.0
CONTROL_TIMEOUT = 60.0

_DISCONNECTED_GRACE = 0.0
"""Seconds to wait for an absent agent to reconnect before failing a call.
Zero: fail fast, because a monitor's next cycle retries anyway and a queued
command against a dead agent only delays the schedule."""


class AgentConnection:
    """One agent's server-side endpoint. Created at config load and reused for
    the process lifetime; the underlying socket comes and goes as the agent
    reconnects, and in-flight calls are failed rather than stranded when it
    drops."""

    def __init__(self, agent_id: str, host: str):
        self.agent_id = agent_id
        self.host = host
        self.hostname: Optional[str] = None
        self.version: Optional[str] = None
        self.capabilities: List[str] = []
        self.connected_at: Optional[float] = None
        self._socket: Any = None
        self._send_lock = asyncio.Lock()
        self._next_id = 0
        self._pending: Dict[int, asyncio.Future] = {}
        self._streams: Dict[str, StreamSpec] = {}

    # --- Liveness ---

    @property
    def is_connected(self) -> bool:
        return self._socket is not None

    def attach(self, socket: Any, hello: Dict[str, Any]) -> None:
        """Bind a freshly authenticated socket. A second agent claiming the
        same id replaces the first — a reconnect after a network drop often
        arrives before the old socket has been noticed as dead."""
        if self._socket is not None:
            log.warning(
                f"agent {self.agent_id!r}: replacing an existing connection "
                f"(the previous socket is assumed dead)"
            )
            self._fail_pending("Superseded by a new agent connection")
        self._socket = socket
        self.hostname = hello.get('hostname')
        self.version = hello.get('version')
        caps = hello.get('caps')
        self.capabilities = [str(c) for c in caps] if isinstance(caps, list) else []
        self.connected_at = time.time()
        log.info(
            f"agent {self.agent_id!r} connected from {self.hostname or self.host} "
            f"(version {self.version or 'unknown'})"
        )

    def detach(self, socket: Any) -> None:
        """Drop the socket if it is still the current one. The identity check
        matters: a slow teardown of a superseded socket must not unbind the
        replacement that already took its place."""
        if self._socket is not socket:
            return
        self._socket = None
        self.connected_at = None
        self._fail_pending("Agent disconnected")
        log.info(f"agent {self.agent_id!r} disconnected")

    def _fail_pending(self, reason: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_result((-1, "", reason))
        self._pending.clear()

    # --- Exec RPC (the SSHConnection-shaped surface) ---

    async def execute(self, command: str,
                      timeout: float = EXEC_TIMEOUT) -> Tuple[int, str, str]:
        """Run one command on the agent's host. Mirrors
        ``SSHConnection.execute``: any transport failure or timeout maps to
        ``(-1, "", message)`` rather than raising, so plugin parse code sees
        one uniform failure shape regardless of transport."""
        socket = self._socket
        if socket is None:
            return -1, "", f"Agent {self.agent_id!r} is not connected"

        request_id = self._next_id = self._next_id + 1
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send(proto.exec_request(request_id, command, timeout))
        except Exception as e:
            self._pending.pop(request_id, None)
            return -1, "", f"Agent send failed: {e}"

        try:
            # The agent enforces `timeout` on its side and replies with a
            # timeout result; this slightly longer wait only covers the case
            # where the agent itself stops answering, and is what stops a
            # monitor's cycle hanging on a wedged agent.
            return await asyncio.wait_for(future, timeout=timeout + 5.0)
        except asyncio.TimeoutError:
            return -1, "", f"Agent did not answer within {timeout + 5.0}s"
        finally:
            self._pending.pop(request_id, None)

    def resolve(self, request_id: int, exit_code: int, stdout: str, stderr: str) -> None:
        """Complete the call a RESULT frame belongs to. A result for an
        unknown id (a late reply to an already-timed-out call) is dropped."""
        future = self._pending.pop(request_id, None)
        if future is not None and not future.done():
            future.set_result((exit_code, stdout, stderr))

    async def _send(self, frame: Dict[str, Any]) -> None:
        socket = self._socket
        if socket is None:
            raise ConnectionError("not connected")
        async with self._send_lock:
            await socket.send_text(proto.encode(frame))

    # --- Desktop notifications ---

    async def notify(self, title: str, body: str, urgency: str = "normal",
                     url: Optional[str] = None, icon: Optional[str] = None,
                     key: Optional[str] = None, timeout: float = 0) -> None:
        """Ask the agent to show a desktop notification. Raises if it cannot be handed over."""
        self._require(proto.NOTIFY, "desktop notifications")
        await self._send(proto.notify(title, body, urgency, url, icon, key, timeout))

    async def dismiss(self, key: str) -> None:
        """Ask the agent to close the desktop notification it shows for `key`."""
        self._require(proto.DISMISS, "dismissing notifications")
        await self._send(proto.dismiss(key))

    def _require(self, capability: str, what: str) -> None:
        """Raise unless the agent is connected and supports `capability`."""
        if self._socket is None:
            raise ConnectionError(f"agent {self.agent_id!r} is not connected")
        if capability not in self.capabilities:
            raise RuntimeError(f"agent {self.agent_id!r} does not support {what} (upgrade it)")

    # --- Event streams ---

    def register_stream(self, spec: StreamSpec) -> None:
        self._streams[spec.id] = spec

    def unregister_stream(self, stream_id: str) -> None:
        self._streams.pop(stream_id, None)

    @property
    def streams(self) -> List[StreamSpec]:
        return list(self._streams.values())

    async def push_subscriptions(self) -> None:
        """Send the agent its full stream set. Always the complete set rather
        than a delta, so a reconnecting agent converges on the right state
        without the server tracking what it already knows."""
        if self._socket is None:
            return
        # A dying socket here is tolerable; the agent gets the full set again on reconnect.
        try:
            await self._send(proto.subscribe([s.to_wire() for s in self._streams.values()]))
        except Exception as e:
            log.warning(f"agent {self.agent_id!r}: could not send subscriptions: {e}")

    def close(self) -> None:
        """Match SSHConnection.close() so the Connector Engine can tear down
        either transport identically."""
        self._fail_pending("X-Monitor is shutting down")
        self._socket = None


class AgentRegistry:
    """Every configured agent, and the routing of inbound event frames.

    Connections are created eagerly from config so a plugin can be wired to an
    agent that has not dialled in yet; the plugin simply reports failed until
    it does."""

    def __init__(self):
        self._agents: Dict[str, AgentConnection] = {}
        self._public_keys: Dict[str, Ed25519PublicKey] = {}
        self._event_sink: Optional[Callable[[str, str, float, Dict[str, Any]], None]] = None
        self._connect_sink: Optional[Callable[[str], None]] = None

    def configure(self, agents_cfg: List[Dict[str, Any]]) -> None:
        """Build the connection objects from config.yaml's ``agents:`` list.
        An entry with no id is skipped with a log rather than raising, matching
        how a malformed plugin entry degrades. Called again on a config reload,
        it keeps each existing agent's connection, so monitors wired to it stay
        wired, and an agent dropped from the list loses its key and can no
        longer connect."""
        declared = set()
        for entry in agents_cfg or []:
            agent_id = entry.get('id') or entry.get('name')
            if not agent_id:
                log.error(f"agents: entry with no `id` ignored: {entry!r}")
                continue
            agent_id = str(agent_id)
            declared.add(agent_id)
            public_key = self._parse_public_key(agent_id, entry)
            if public_key is None:
                self._public_keys.pop(agent_id, None)
                log.error(
                    f"agent {agent_id!r} has no usable public_key and will refuse "
                    f"every connection"
                )
            else:
                self._public_keys[agent_id] = public_key
            host = str(entry.get('host') or agent_id)
            existing = self._agents.get(agent_id)
            if existing is not None:
                existing.host = host
                continue
            self._agents[agent_id] = AgentConnection(agent_id, host=host)
            log.info(f"Registered agent {agent_id!r}")
        for agent_id in sorted(set(self._public_keys) - declared):
            del self._public_keys[agent_id]
            log.warning(f"agent {agent_id!r} is no longer configured and can no longer connect")

    @staticmethod
    def _parse_public_key(agent_id: str, entry: Dict[str, Any]) -> Optional[Ed25519PublicKey]:
        """The entry's `public_key`, an OpenSSH ed25519 line, or None if absent or unparseable."""
        line = entry.get('public_key')
        if not line:
            return None
        try:
            return keys.load_public_key(str(line))
        except (ValueError, TypeError) as e:
            log.error(f"agent {agent_id!r}: could not parse public_key: {e}")
            return None

    def get(self, agent_id: str) -> Optional[AgentConnection]:
        return self._agents.get(agent_id)

    def require(self, agent_id: str) -> AgentConnection:
        """Return the named agent's connection, creating a placeholder for an
        unconfigured id. A plugin pointing at an agent that is missing from
        `agents:` is a config error the operator should see as a failing
        monitor with an explicit message, not a crash at startup."""
        conn = self._agents.get(agent_id)
        if conn is None:
            log.error(
                f"Monitor references agent {agent_id!r}, which is not declared "
                f"in the top-level `agents:` config — it can never connect"
            )
            conn = self._agents[agent_id] = AgentConnection(agent_id, host=agent_id)
        return conn

    def public_key_for(self, agent_id: str) -> Optional[Ed25519PublicKey]:
        return self._public_keys.get(agent_id)

    @property
    def all(self) -> List[AgentConnection]:
        return list(self._agents.values())

    # --- Event fan-out ---

    def set_event_sink(self, sink: Callable[[str, str, float, Dict[str, Any]], None]) -> None:
        """Install the callback inbound events are handed to, as
        ``(agent_id, stream_id, timestamp, payload)``. The Coordination Engine
        owns it; the registry stays free of plugin knowledge."""
        self._event_sink = sink

    def set_connect_sink(self, sink: Callable[[str], None]) -> None:
        """Install the callback fired when an agent finishes its handshake.

        Monitors on an agent start their schedule the moment X-Monitor does, but
        the agent needs a moment to dial in — so a monitor's first cycle
        usually lands before its transport exists. For a 30s monitor that is
        invisible; for an hourly one it means an hour of reporting failed after
        every restart. The Coordination Engine uses this to re-run those
        monitors as soon as the agent is actually reachable."""
        self._connect_sink = sink

    def notify_connected(self, agent_id: str) -> None:
        if self._connect_sink is None:
            return
        # The engine's connect handler must not kill the agent's socket task.
        try:
            self._connect_sink(agent_id)
        except Exception as e:
            log.error(f"agent {agent_id!r}: connect handler failed: {e}")

    def dispatch_event(self, agent_id: str, stream_id: str,
                       timestamp: float, payload: Dict[str, Any]) -> None:
        if self._event_sink is None:
            return
        # The engine's event handler must not kill the agent's socket task.
        try:
            self._event_sink(agent_id, stream_id, timestamp, payload)
        except Exception as e:
            log.error(f"agent {agent_id!r}: event handler failed for stream {stream_id!r}: {e}")

    def close(self) -> None:
        for conn in self._agents.values():
            conn.close()
