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
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from x_monitor.code_version import code_version
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
        # The agent's code_version(), which must match the server's before it is handed monitors to run.
        self.code = ''
        # Set by the `agents:` entry's run_monitors: the agent runs its host's monitors itself.
        self.run_monitors = False
        self._actions: Dict[str, asyncio.Future] = {}
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
        self.code = str(hello.get('code') or '')
        self.connected_at = time.time()
        log.info(
            f"agent {self.agent_id!r} connected from {self.hostname or self.host} "
            f"(version {self.version or 'unknown'})"
        )
        # Only an agent set to run its host's monitors needs the server's code; for the rest it changes nothing.
        if self.run_monitors and not self.same_code:
            log.warning(
                f"agent {self.agent_id!r} runs different X-Monitor code ({self.code or 'unknown'}, "
                f"server {code_version()}), so its monitors stay on the server until it is updated"
            )

    @property
    def same_code(self) -> bool:
        """Whether the agent runs exactly the server's X-Monitor code, which handing it monitors requires."""
        return bool(self.code) and self.code == code_version()

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
        for future in self._actions.values():
            if not future.done():
                future.set_result((False, {'content': reason}))
        self._actions.clear()

    # --- Monitors the agent runs itself ---

    @property
    def runs_engine(self) -> bool:
        """Whether this agent may be handed monitors now: configured to, connected, able to, and on the server's own code."""
        return (self.run_monitors and self._socket is not None
                and proto.ENGINE in self.capabilities and self.same_code)

    async def send_plan(self, version: str, config: Dict[str, Any]) -> None:
        """Hand the agent the monitors it runs itself."""
        await self._send(proto.plan(version, config))

    async def ack_records(self, through: int) -> None:
        """Tell the agent every record up to `through` is stored."""
        await self._send(proto.records_ack(through))

    async def poll_now(self, monitor_id: str) -> None:
        """Ask the agent for one cycle of a monitor it runs."""
        await self._send(proto.poll_now(monitor_id))

    async def request_action(self, request_id: str, monitor_id: str, action_id: str,
                             args: Dict[str, Any], timeout: float) -> Tuple[bool, Dict[str, str]]:
        """Run an action on a monitor the agent runs and return (success, the metadata it reported); never raises."""
        if self._socket is None:
            return False, {'content': f"Agent {self.agent_id!r} is not connected, so the action cannot reach it"}
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._actions[request_id] = future
        try:
            await self._send(proto.action(request_id, monitor_id, action_id, args))
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            return False, {'content': f"Agent {self.agent_id!r} did not answer within {timeout:.0f}s"}
        except Exception as e:
            return False, {'content': f"Could not send the action to agent {self.agent_id!r}: {e}"}
        finally:
            self._actions.pop(request_id, None)

    def resolve_action(self, request_id: str, success: bool, metadata: Dict[str, str]) -> None:
        """Complete the action an ACTION_RESULT frame answers; a late answer is dropped."""
        future = self._actions.pop(request_id, None)
        if future is not None and not future.done():
            future.set_result((success, metadata))

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

    # --- Holding the host awake ---

    async def inhibit(self, key: str, hold: bool) -> None:
        """Ask the agent to hold its host awake under `key`, or let it go; an absent or older agent is skipped."""
        if self._socket is None or proto.INHIBIT not in self.capabilities:
            return
        try:
            await self._send(proto.inhibit(key, hold))
        except Exception as e:
            # A dropped socket releases every hold on the agent's side, so a lost release needs no retry.
            logging.debug(f"agent {self.agent_id!r}: could not send inhibit for {key!r}: {e}")

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
        self._sync_sink: Optional[Callable[[str, Dict[str, Any]], Awaitable[None]]] = None

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
            conn = self._agents.get(agent_id)
            if conn is None:
                conn = self._agents[agent_id] = AgentConnection(agent_id, host=host)
                log.info(f"Registered agent {agent_id!r}")
            conn.host = host
            conn.run_monitors = bool(entry.get('run_monitors', False))
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

    def set_sync_sink(self, sink: Callable[[str, Dict[str, Any]], Awaitable[None]]) -> None:
        """Install the coroutine an agent's RECORDS and PLAN_ACK frames are handed to, as (agent_id, frame)."""
        self._sync_sink = sink

    async def dispatch_sync(self, agent_id: str, frame: Dict[str, Any]) -> None:
        if self._sync_sink is None:
            return
        # The engine's sync handler must not kill the agent's socket task.
        try:
            await self._sync_sink(agent_id, frame)
        except Exception as e:
            log.error(f"agent {agent_id!r}: could not handle {frame.get('t')!r}: {e}")

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
