"""JobsGateway: the narrow job-control surface a job-capable plugin and its UI
hold, in place of pass-throughs on the engine. A job is a detached command on
the target (a Job row) advanced by the owning plugin's poll; "running" is a DB
state, not a live coroutine, so everything here is DB reads and writes plus
(for cancel) one ordinary SSH command on the host the job runs on."""

import asyncio
from typing import Awaitable, Callable, Dict, List, Optional, Sequence, Set


# Prefix of the kind an action launched as a detached job is recorded under, followed by the action's id.
ACTION_JOB_PREFIX = 'action:'


def action_job_kind(action_id: str) -> str:
    """The job kind a detached run of this action is recorded under."""
    return ACTION_JOB_PREFIX + action_id


def action_id_of(kind: str) -> Optional[str]:
    """The action id a job kind names, or None when the job is not a detached action."""
    return kind[len(ACTION_JOB_PREFIX):] if kind.startswith(ACTION_JOB_PREFIX) else None


# Seconds between polls of a job while someone has its log open.
WATCHED_POLL_SECONDS = 2.0

# Wake key of the engine loop that polls detached actions, which no monitor's own cycle does.
ACTION_LOOP = 'action-jobs'

# How many open log views follow each job, by job id.
_watchers: Dict[int, int] = {}

# Each sleeping polling loop's wake key, and the sleeps a new watch cut short.
_naps: Dict["asyncio.Task", str] = {}
_woken: Set["asyncio.Task"] = set()


def is_watched(job_id: int) -> bool:
    """Whether any open log view follows this job."""
    return _watchers.get(job_id, 0) > 0


def watch(job_id: int, wake: str) -> Callable[[], None]:
    """Count one more log view on the job, wake the loop sleeping under `wake`, and return the callable that ends the watch."""
    _watchers[job_id] = _watchers.get(job_id, 0) + 1
    for nap, key in list(_naps.items()):
        if key == wake:
            _woken.add(nap)
            nap.cancel()
    ended = [False]

    def unwatch() -> None:
        if ended[0]:
            return
        ended[0] = True
        left = _watchers.get(job_id, 0) - 1
        if left > 0:
            _watchers[job_id] = left
        else:
            _watchers.pop(job_id, None)

    return unwatch


async def sleep_unless_watched(seconds: float, wake: str) -> bool:
    """Sleep for `seconds`, or until a log view starts watching a job polled under `wake`; True when woken early."""
    nap = asyncio.ensure_future(asyncio.sleep(seconds))
    _naps[nap] = wake
    try:
        await nap
        return False
    except asyncio.CancelledError:
        if nap not in _woken:
            raise
        return True
    finally:
        _naps.pop(nap, None)
        _woken.discard(nap)


class JobsGateway:
    """Detached-job state and control scoped to one plugin."""

    def __init__(self, db, plugin,
                 cancel_exec: Optional[Callable[[str, Optional[str]], Awaitable]] = None):
        """Bind the gateway to the store and one plugin; cancel_exec runs a raw command on the plugin's transport, or on the named agent."""
        self._db = db
        self._plugin = plugin
        self._cancel_exec = cancel_exec

    def _is_side(self, kind: str) -> bool:
        """Whether a job of this kind runs beside the plugin's main job: a detached action, or a kind the plugin names."""
        return action_id_of(kind) is not None or kind in getattr(self._plugin, 'SIDE_JOB_KINDS', ())

    def running(self) -> Optional[dict]:
        """Return the plugin's currently running main job row, if any; side jobs never count."""
        jobs = [job for job in self._db.running_jobs(plugin_id=self._plugin.id) if not self._is_side(job['kind'])]
        return jobs[0] if jobs else None

    def running_side(self, kind: str) -> Optional[dict]:
        """Return the plugin's running job of this side kind, if any."""
        jobs = [job for job in self._db.running_jobs(plugin_id=self._plugin.id) if job['kind'] == kind]
        return jobs[0] if jobs else None

    def action_job(self, action_id: str) -> Optional[dict]:
        """Return the running detached run of this action, if any."""
        return self.running_side(action_job_kind(action_id))

    def action_jobs(self) -> List[dict]:
        """Return every running detached action of this plugin, newest first."""
        return [job for job in self._db.running_jobs(plugin_id=self._plugin.id)
                if action_id_of(job['kind']) is not None]

    def is_running(self) -> bool:
        """Whether the plugin has a running main job."""
        return self.running() is not None

    def any_running(self) -> bool:
        """Whether the plugin has a main job or a detached action running, either of which Cancel can stop."""
        return self.running() is not None or bool(self.action_jobs())

    def current_id(self) -> Optional[int]:
        """Return the running job's id, if any."""
        job = self.running()
        return job['id'] if job else None

    def recent(self, limit: int = 20, exclude_kinds: Sequence[str] = ()) -> list:
        """Return the plugin's most recent job rows, leaving out any of the excluded kinds."""
        return self._db.recent_jobs(plugin_id=self._plugin.id, limit=limit, exclude_kinds=exclude_kinds)

    def watch(self, job: dict) -> Callable[[], None]:
        """Poll this job every few seconds while its log is open; returns the callable that ends the watch."""
        wake = ACTION_LOOP if action_id_of(job['kind']) is not None else self._plugin.id
        return watch(job['id'], wake)

    def watched(self) -> bool:
        """Whether a log view follows one of this plugin's running jobs that its own cycle polls."""
        return any(is_watched(job['id']) for job in self._db.running_jobs(plugin_id=self._plugin.id)
                   if action_id_of(job['kind']) is None)

    async def log(self, job_id: int) -> list:
        """Return a job's whole output, read from disk once the job has finished."""
        return await asyncio.wrap_future(self._db.job_log(job_id))

    async def cancel(self) -> bool:
        """Kill the plugin's running main job, else its newest detached action,
        on the target (one ordinary SSH command) and mark it cancelled. The
        next poll would also observe the death, but cancelling eagerly gives
        immediate feedback."""
        from x_monitor.core.connectors.ssh_connector import cancel_command
        job = self.running() or next(iter(self.action_jobs()), None)
        if not job or not job.get('pid'):
            return False
        if self._cancel_exec is not None:
            await self._cancel_exec(cancel_command(job['pid']), self._plugin.job_agent(job))
        self._db.finish_job(job['id'], 'cancelled', exit_code=130, error='Cancelled by user')
        return True

    def create(self, kind: str, command: str, workdir: Optional[str] = None) -> int:
        """Record a newly launched detached job and return its id."""
        return self._db.create_job(plugin_id=self._plugin.id, target=self._plugin.target,
                                   kind=kind, command=command, workdir=workdir)

    def set_pid(self, job_id: int, pid: int) -> None:
        """Record the detached job's process-group id once known."""
        self._db.set_job_pid(job_id, pid)

    def set_progress(self, job_id: int, summary: str) -> None:
        """Update the one-line progress summary the job panel shows."""
        self._db.set_job_progress(job_id, summary)

    def append_output(self, job_id: int, lines: list, stream: str = 'stdout') -> None:
        """Append newly observed output lines to the job's log."""
        self._db.append_job_output(job_id, lines, stream)

    def bump_output_seq(self, job_id: int, new_seq: int) -> None:
        """Advance the byte offset up to which the job's output was consumed."""
        self._db.bump_job_output_seq(job_id, new_seq)

    def finish(self, job_id: int, state: str, exit_code=None, error=None) -> None:
        """Mark the job finished with its terminal state."""
        self._db.finish_job(job_id, state, exit_code=exit_code, error=error)
