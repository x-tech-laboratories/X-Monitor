"""Keeping the host awake while a task runs.

A monitored host that suspends when idle, such as a phone, would otherwise
fall asleep part-way through a long command or a network scan aimed at it. The
agent holds one logind idle inhibitor for as long as anything wants the host
awake: every command it runs, and every hold the server asks for on behalf of a
task running elsewhere. It blocks the automatic idle suspend only, so a suspend
the user asks for still goes ahead.

The lock is a ``systemd-inhibit`` child reading the agent's pipe. When the agent
dies, however it dies, the pipe closes and the lock goes with it, so a restart
can never leave the host held awake.
"""

import asyncio
import contextlib
import logging
import shutil
from typing import AsyncIterator, Optional

LINGER_SECONDS = 5.0
"""How long the lock outlives its last holder, so a burst of short commands shares one lock instead of taking one each."""


class IdleInhibitor:
    """A counted idle inhibitor: taken on the first hold, released a moment after the last."""

    def __init__(self, linger: float = LINGER_SECONDS):
        self._linger = linger
        self._holders = 0
        self._process: Optional[asyncio.subprocess.Process] = None
        self._release_task: Optional[asyncio.Task] = None
        self._warned = False

    @property
    def holders(self) -> int:
        return self._holders

    @property
    def is_locked(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def acquire(self) -> None:
        """Add a holder, taking the lock if this is the first one."""
        self._holders += 1
        if self._release_task is not None:
            self._release_task.cancel()
            self._release_task = None
        if not self.is_locked:
            await self._lock()

    def release(self) -> None:
        """Drop a holder; the lock goes once none is left for the linger period."""
        if self._holders == 0:
            return
        self._holders -= 1
        if self._holders == 0 and self._release_task is None:
            self._release_task = asyncio.create_task(self._release_after_linger())

    @contextlib.asynccontextmanager
    async def held(self) -> AsyncIterator[None]:
        """Hold the host awake for the duration of the block."""
        await self.acquire()
        try:
            yield
        finally:
            self.release()

    async def close(self) -> None:
        """Release the lock now, whatever still holds it."""
        if self._release_task is not None:
            self._release_task.cancel()
            self._release_task = None
        self._holders = 0
        await self._unlock()

    async def _release_after_linger(self) -> None:
        try:
            await asyncio.sleep(self._linger)
        except asyncio.CancelledError:
            return
        self._release_task = None
        if self._holders == 0:
            await self._unlock()

    async def _lock(self) -> None:
        binary = shutil.which('systemd-inhibit')
        if binary is None:
            self._warn_once("systemd-inhibit is not on PATH, so tasks cannot keep this host awake")
            return
        try:
            self._process = await asyncio.create_subprocess_exec(
                binary, '--what=idle', '--mode=block', '--who=x-monitor-agent',
                '--why=An X-Monitor task is running', 'cat',
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError as e:
            self._process = None
            self._warn_once(f"could not start systemd-inhibit: {e}")

    async def _unlock(self) -> None:
        process, self._process = self._process, None
        if process is None or process.returncode is not None:
            return
        # Closing the pipe ends the child's `cat`, which is what releases the lock.
        if process.stdin is not None:
            process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

    def _warn_once(self, message: str) -> None:
        if not self._warned:
            logging.warning(message)
            self._warned = True
