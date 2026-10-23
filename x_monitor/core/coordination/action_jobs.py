"""Detached actions: an action whose plan asks to run detached is launched as a
job on its host, and one engine loop polls every running one until it ends.
The finished run's output then goes to the action's own interpreter, as if
the command had run inline. Nothing lives in a coroutine per job, so a job
started before a restart or a reload is simply polled by the next loop."""

import asyncio
import logging
import shlex
import time
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

from x_monitor.core.connectors import ssh_connector as detached
from x_monitor.core.connectors.types import ActionPlan, CmdResult, CollectResult, DispatchResult
from x_monitor.core.coordination.jobs import action_id_of, action_job_kind

if TYPE_CHECKING:
    from x_monitor.core.coordination.engine import XMonitorEngine
    from x_monitor.plugins.base.plugin_base import Plugin

log = logging.getLogger(__name__)


# ==================================================================================================
# Settings
# ==================================================================================================

# Seconds between polls of the running detached actions.
POLL_SECONDS = 5.0

# Characters of the newest output line shown as a running action's progress.
PROGRESS_LIMIT = 200


# ==================================================================================================
# Helpers
# ==================================================================================================

def action_label(plugin: "Plugin", action_id: str) -> str:
    """The name a person sees for an action, or its id when no button names it."""
    for action in plugin.all_actions():
        if action.get('action_id') == action_id:
            return str(action.get('name') or action_id)
    return action_id.replace('_', ' ').capitalize()


def bounded(command: str, timeout: Optional[float]) -> str:
    """The command under `timeout`, which kills it once the whole run takes too long."""
    if not timeout:
        return command
    return f'timeout {int(timeout)} sh -c {shlex.quote(command)}'


def _last_line(lines: List[str]) -> Optional[str]:
    """The newest non-blank line, cut to fit the progress line."""
    for line in reversed(lines):
        if line.strip():
            return line.strip()[:PROGRESS_LIMIT]
    return None


# ==================================================================================================
# Follower
# ==================================================================================================

class ActionJobs:
    """Launches detached actions and follows each running one to its end."""

    def __init__(self, engine: "XMonitorEngine"):
        self._engine = engine
        # Each running job's action arguments, which only this process knows; a restarted one interprets without them.
        self._kwargs: Dict[int, Dict[str, Any]] = {}

    # --- launch ---

    async def launch(self, plugin: "Plugin", action_id: str, plan: ActionPlan, ctx,
                     interpret: Callable[[CmdResult], Any], kwargs: Dict[str, Any]) -> DispatchResult:
        """Start the plan's command detached and record it as a job, refusing a second run of the same action."""
        label = action_label(plugin, action_id)
        if plugin.jobs.action_job(action_id) is not None:
            return False, {'content': f"{label} is already running"}
        command = bounded(plan.command, plan.timeout)
        workdir = detached.workdir_for(f'{plugin.id}-{action_id}-{int(time.time())}')
        result = await self._engine.connectors.execute(ctx, ActionPlan(detached.launch_command(command, workdir)))
        pid = detached.parse_launch(result.stdout) if result.exit_code == 0 else None
        if pid is None:
            failed = CmdResult(result.exit_code or -1, '', result.stderr or result.stdout or 'Could not start')
            return self._engine.finish_action(plugin, interpret(failed))
        job_id = plugin.jobs.create(action_job_kind(action_id), command, workdir)
        plugin.jobs.set_pid(job_id, pid)
        self._kwargs[job_id] = kwargs
        message = f"{label} started in the background (pid {pid})"
        self._engine.apply(plugin, CollectResult(logs=[(message, 'INFO')]))
        return True, {'content': message, 'job_id': job_id}

    # --- follow ---

    async def run(self) -> None:
        """Poll every running detached action until the engine stops."""
        while True:
            await asyncio.sleep(POLL_SECONDS)
            await self.poll_all()

    async def poll_all(self) -> None:
        """Advance every running detached action of a current monitor by one poll."""
        monitors = {plugin.id: plugin for plugin in self._engine.all_monitors()}
        pending = []
        for job in self._engine.db.running_jobs():
            plugin = monitors.get(job['plugin_id'])
            if plugin is None or action_id_of(job['kind']) is None or not job.get('pid') or not job.get('workdir'):
                continue
            pending.append(self._advance(plugin, job))
        for outcome in await asyncio.gather(*pending, return_exceptions=True):
            if isinstance(outcome, BaseException):
                log.error(f"Polling a detached action failed: {outcome}")

    async def _advance(self, plugin: "Plugin", job: dict) -> None:
        """Read one poll of a running action, and hand its whole output to the interpreter once it ends."""
        ctx = self._engine.job_context(plugin, plugin.job_agent(job))
        if ctx is None:
            return
        poll_plan = ActionPlan(detached.poll_command(job['workdir'], job['pid'], job['output_seq']))
        result = await self._engine.connectors.execute(ctx, poll_plan)
        # A poll that never reached the host says nothing about the job, so the next one tries again.
        if result.exit_code != 0 and not result.stdout.strip():
            return
        poll = detached.parse_poll(result.stdout)
        finished = poll.exit_code is not None or not poll.alive

        job_id = job['id']
        lines, consumed = detached.split_lines(poll.new_output)
        if finished and poll.new_output[consumed:]:
            lines.append(poll.new_output[consumed:])
            consumed = len(poll.new_output)
        if lines:
            plugin.jobs.append_output(job_id, lines)
            plugin.jobs.bump_output_seq(job_id, job['output_seq'] + consumed)
            progress = _last_line(lines)
            if progress:
                plugin.jobs.set_progress(job_id, progress)
        if not finished:
            return

        # The running job's output is read from memory, before finishing moves it to disk.
        output = '\n'.join(row['message'] for row in self._engine.db.job_output(job_id, limit=0))
        exit_code = poll.exit_code if poll.exit_code is not None else -1
        if poll.exit_code is None:
            plugin.jobs.finish(job_id, 'failed', exit_code=-1, error='Process ended without writing an exit code')
        else:
            plugin.jobs.finish(job_id, 'succeeded' if exit_code == 0 else 'failed', exit_code=exit_code,
                               error=None if exit_code == 0 else f"Exited with status {exit_code}")
        self._interpret(plugin, job, CmdResult(exit_code, output, ''))

    def _interpret(self, plugin: "Plugin", job: dict, result: CmdResult) -> None:
        """Record a finished action's outcome on its monitor, as its interpreter reads the output."""
        action_id = action_id_of(job['kind'])
        kwargs = self._kwargs.pop(job['id'], {})
        custom = plugin.custom_action(action_id)
        outcome = custom.interpret(result) if custom is not None else plugin.interpret_action(action_id, result, **kwargs)
        if not isinstance(outcome, CollectResult):
            label = action_label(plugin, action_id)
            message = f"{label} finished" if outcome else f"{label} failed (exit {result.exit_code})"
            outcome = CollectResult(logs=[(message, 'INFO' if outcome else 'ERROR')], success=bool(outcome))
        self._engine.apply(plugin, outcome)
