"""The agent's connection to the X-Monitor server.

One outbound WebSocket, held open. The agent reconnects on its own with
exponential backoff, so a server restart or a flapping link needs no operator
action and the monitors it feeds recover by themselves.

Commands are dispatched into their own tasks rather than handled inline: a
thirty-second `borg` check must not stop the agent answering a one-second CPU
sample on the same socket. That is the concrete difference from SSH, where
concurrency was bounded by the target's ``MaxSessions``; here the only limit
is what the host can usefully run at once.
"""

import asyncio
import logging
import random
import socket
from typing import Any, Dict, List, Optional

import websockets

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from x_monitor.code_version import code_version
from x_monitor_agent import __version__, desktop, executor, inhibit, keys, protocol as proto, watchers
from x_monitor_agent.local import LocalRunner
from x_monitor_agent.local_notify import LocalNotifier, OfflineAlerts, follow

_BACKOFF_INITIAL = 1.0
_BACKOFF_MAX = 60.0

# How long the outbox pump waits before looking for new records when it found none.
_PUMP_IDLE_SECONDS = 1.0

CAPABILITIES = sorted([*watchers.WATCHERS, proto.NOTIFY, proto.DISMISS, proto.INHIBIT])
"""What this agent can do, sent in the hello so a server can tell an older
agent apart from a newer one without a version comparison."""


class AgentClient:
    def __init__(self, url: str, agent_id: str, key: Ed25519PrivateKey,
                 hostname: Optional[str] = None, notify_only: bool = False,
                 state_dir: Optional[str] = None, local_socket: Optional[str] = None):
        self.url = url
        self.notify_only = notify_only
        self.agent_id = agent_id
        self.key = key
        self.hostname = hostname or socket.gethostname()
        self._socket: Any = None
        self._welcomed = False
        self._send_lock = asyncio.Lock()
        self._streams: Dict[str, asyncio.Task] = {}
        self._execs: set = set()
        # Kept across reconnects, so a notification can still be clicked or dismissed after a network drop.
        self._desktop = desktop.Notifier()
        self._notifications: set = set()
        self._inhibitor = inhibit.IdleInhibitor()
        self._server_holds: set = set()
        # The monitors this agent runs itself, which keep running whether or not it is connected.
        self._runner = LocalRunner(agent_id, state_dir) if state_dir and not notify_only else None
        self._requests: set = set()
        self.local_socket = local_socket

    # --- Connection lifecycle ---

    async def run_forever(self) -> None:
        """Dial, serve, and redial. Only cancellation ends this."""
        backoff = _BACKOFF_INITIAL
        if self._runner is not None:
            await self._runner.start()
        local = await self._start_local_notifications()
        while True:
            self._welcomed = False
            try:
                await self._session()
            except asyncio.CancelledError:
                for stop in local:
                    stop()
                if self._runner is not None:
                    self._runner.stop()
                await self._stop_streams()
                await self._inhibitor.close()
                self._desktop.cancel_all()
                for task in list(self._notifications):
                    task.cancel()
                raise
            # Any session failure becomes a redial; a network blip must not end the agent.
            except Exception as e:
                logging.warning(f"connection to {self.url} ended: {e}")

            # A session the server accepted proves the link works, so its loss redials promptly instead of waiting out earlier failures.
            if self._welcomed:
                backoff = _BACKOFF_INITIAL

            # Jitter keeps a fleet of agents from redialling a restarted
            # server in lockstep.
            delay = min(backoff, _BACKOFF_MAX) * random.uniform(0.5, 1.5)
            logging.info(f"reconnecting in {delay:.1f}s")
            await asyncio.sleep(delay)
            backoff = min(backoff * 2, _BACKOFF_MAX)

    async def _session(self) -> None:
        """One connection, from challenge to disconnect."""
        async with websockets.connect(self.url, ping_interval=20, ping_timeout=20) as socket_:
            self._socket = socket_
            challenge = proto.decode(await socket_.recv())
            nonce = str(challenge.get('nonce') or '')
            if challenge.get('t') != proto.CHALLENGE or not nonce:
                raise ConnectionError("server sent no challenge (is it an older X-Monitor?)")
            caps = [proto.DISMISS, proto.NOTIFY] if self.notify_only else CAPABILITIES
            if self._runner is not None:
                caps = sorted([*caps, proto.ENGINE])
            signature = keys.sign(self.key, self.agent_id, nonce)
            hello = proto.hello(self.agent_id, signature, self.hostname, __version__, caps, code_version())
            await socket_.send(proto.encode(hello))

            welcome = proto.decode(await socket_.recv())
            if welcome.get('t') != proto.WELCOME:
                raise ConnectionError("server did not accept the agent (check the key)")
            logging.info(f"connected to {self.url} as {self.agent_id!r}")
            self._welcomed = True

            if not self.notify_only:
                await self._apply_streams(welcome.get('streams') or [])
            pump = None
            if self._runner is not None:
                await self._send(proto.plan_ack(self._runner.plan_version))
                pump = asyncio.create_task(self._pump_records())
            try:
                await self._receive_loop(socket_)
            finally:
                if pump is not None:
                    pump.cancel()
                self._socket = None
                await self._stop_streams()
                await self._cancel_execs()
                self._release_server_holds()

    async def _receive_loop(self, socket_: Any) -> None:
        async for raw in socket_:
            frame = proto.decode(raw)
            tag = frame.get('t')
            if tag == proto.EXEC:
                # Its own task: a long command must not block the socket.
                task = asyncio.create_task(self._handle_exec(frame))
                self._execs.add(task)
                task.add_done_callback(self._execs.discard)
            elif tag in (proto.NOTIFY, proto.DISMISS):
                handler = self._desktop.show if tag == proto.NOTIFY else self._desktop.dismiss
                task = asyncio.create_task(handler(frame))
                self._notifications.add(task)
                task.add_done_callback(self._notifications.discard)
            elif tag == proto.SUBSCRIBE and not self.notify_only:
                await self._apply_streams(frame.get('streams') or [])
            elif tag == proto.INHIBIT and not self.notify_only:
                await self._apply_server_hold(frame)
            elif tag == proto.PING:
                await self._send({'t': proto.PONG, 'id': frame.get('id')})
            elif self._runner is not None and tag in (proto.PLAN, proto.RECORDS_ACK, proto.ACTION, proto.POLL_NOW):
                # Its own task: applying a plan or running an action must not block the socket.
                task = asyncio.create_task(self._handle_engine_frame(frame))
                self._requests.add(task)
                task.add_done_callback(self._requests.discard)

    # --- Local notifications ---

    async def _start_local_notifications(self) -> list:
        """Serve this agent's own notifications on the local socket, or follow it from a desktop agent; returns what stops it."""
        if not self.local_socket:
            return []
        if self.notify_only:
            task = asyncio.create_task(follow(self.local_socket, self._show_local))
            return [task.cancel]
        if self._runner is None:
            return []
        notifier = LocalNotifier(self.local_socket)
        try:
            await notifier.start()
        except OSError as e:
            logging.warning(f"cannot serve local notifications on {self.local_socket}: {e}")
            return []
        alerts = OfflineAlerts(notifier, lambda: self._runner.engine,
                               lambda: self._socket is not None and self._welcomed, self.agent_id)
        return [alerts.start(), notifier.close]

    async def _show_local(self, frame: Dict[str, Any]) -> None:
        """Show or close a notification the system agent raised while X-Monitor was out of reach."""
        if frame.get('t') == proto.NOTIFY:
            await self._desktop.show(frame)
        else:
            await self._desktop.dismiss(frame)

    # --- Local monitors ---

    async def _handle_engine_frame(self, frame: Dict[str, Any]) -> None:
        """Serve one of the server's requests about the monitors this agent runs itself."""
        tag = frame.get('t')
        try:
            if tag == proto.PLAN:
                config = frame.get('config')
                await self._runner.apply_plan(str(frame.get('version') or ''), config if isinstance(config, dict) else {})
                await self._send(proto.plan_ack(self._runner.plan_version))
            elif tag == proto.RECORDS_ACK:
                self._runner.acknowledge(int(frame.get('through') or 0))
            elif tag == proto.ACTION:
                args = frame.get('args')
                success, content = await self._runner.run_action(
                    str(frame.get('id') or ''), str(frame.get('monitor') or ''),
                    str(frame.get('action') or ''), args if isinstance(args, dict) else {})
                await self._send(proto.action_result(str(frame.get('id') or ''), success, content))
            elif tag == proto.POLL_NOW:
                await self._runner.poll_now(str(frame.get('monitor') or ''))
        # A request that fails is logged; the connection and the monitors carry on.
        except Exception as e:
            logging.warning(f"could not handle {tag!r} from the server: {e}")

    async def _pump_records(self) -> None:
        """Send the outbox to the server for as long as this connection lasts, oldest first, starting again from the first unacknowledged record."""
        sent = 0
        while True:
            batch = await asyncio.to_thread(self._runner.pending, sent)
            if not batch:
                await asyncio.sleep(_PUMP_IDLE_SECONDS)
                continue
            await self._send(proto.records(batch))
            sent = batch[-1][0]

    # --- Exec ---

    async def _handle_exec(self, frame: Dict[str, Any]) -> None:
        request_id = frame.get('id')
        if not isinstance(request_id, int):
            return
        if self.notify_only:
            code, out, err = -1, "", "This agent only shows notifications; it runs no commands"
        else:
            command = str(frame.get('cmd', ''))
            timeout = float(frame.get('timeout') or executor.DEFAULT_TIMEOUT)
            async with self._inhibitor.held():
                code, out, err = await executor.run(command, timeout=timeout)
        try:
            await self._send(proto.exec_result(request_id, code, out, err))
        except Exception as e:
            # The socket died while the command ran; the server has already
            # failed the call, so dropping the reply is the correct outcome.
            logging.debug(f"could not deliver result for request {request_id}: {e}")

    async def _cancel_execs(self) -> None:
        """Kill every command still running for a connection that is gone: the
        server has already failed those calls, and a long evaluation left
        running would only load the host for a result nobody will read."""
        tasks = [t for t in self._execs if not t.done()]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if tasks:
            logging.info(f"cancelled {len(tasks)} command(s) orphaned by the disconnect")

    # --- Server holds ---

    async def _apply_server_hold(self, frame: Dict[str, Any]) -> None:
        """Take or drop the idle inhibitor for a task the server runs against this host from elsewhere."""
        key = str(frame.get('key') or '')
        if not key:
            return
        if frame.get('hold'):
            if key not in self._server_holds:
                self._server_holds.add(key)
                await self._inhibitor.acquire()
        elif key in self._server_holds:
            self._server_holds.discard(key)
            self._inhibitor.release()

    def _release_server_holds(self) -> None:
        """Drop every hold the server took, since a lost connection can no longer release them."""
        for _ in self._server_holds:
            self._inhibitor.release()
        self._server_holds.clear()

    # --- Streams ---

    async def _apply_streams(self, raw_streams: List[Dict[str, Any]]) -> None:
        """Converge on the server's subscription set: cancel what is gone,
        start what is new, leave unchanged streams running so a reconnect does
        not restart a healthy journal follow."""
        specs = [s for s in (proto.StreamSpec.from_wire(r) for r in raw_streams) if s]
        wanted = {s.id: s for s in specs}

        for stream_id in list(self._streams):
            if stream_id not in wanted:
                await self._cancel_stream(stream_id)

        for stream_id, spec in wanted.items():
            if stream_id in self._streams:
                continue
            self._streams[stream_id] = asyncio.create_task(
                watchers.supervise(spec.kind, spec.id, spec.params, self._emit_event)
            )
            logging.info(f"watching stream {stream_id!r} ({spec.kind})")

    async def _emit_event(self, envelope: Dict[str, Any]) -> None:
        await self._send(proto.event(
            envelope['stream'], envelope['payload'], envelope['ts']
        ))

    async def _cancel_stream(self, stream_id: str) -> None:
        task = self._streams.pop(stream_id, None)
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logging.info(f"stopped watching stream {stream_id!r}")

    async def _stop_streams(self) -> None:
        for stream_id in list(self._streams):
            await self._cancel_stream(stream_id)

    # --- Send ---

    async def _send(self, frame: Dict[str, Any]) -> None:
        socket_ = self._socket
        if socket_ is None:
            raise ConnectionError("not connected")
        async with self._send_lock:
            await socket_.send(proto.encode(frame))
