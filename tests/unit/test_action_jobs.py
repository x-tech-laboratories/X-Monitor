"""Detached actions: the engine launches them as jobs and follows each one to its end."""

from unittest.mock import AsyncMock, MagicMock

from x_monitor.__main__ import XMonitorEngine
from x_monitor.core.connectors import ssh_connector as detached
from x_monitor.core.connectors.types import ActionPlan, CmdResult, CollectResult
from x_monitor.core.coordination.action_jobs import ActionJobs, bounded
from x_monitor.core.coordination.jobs import JobsGateway
from x_monitor.plugins.group import Group


_ACTIONS = [{'name': 'Sync', 'command': 'sync-all', 'detached': True, 'timeout': '1h'}]


def _poll(out, exit_code=None, alive=True):
    """The stdout one poll of a detached job prints."""
    return CmdResult(0, (
        f"===XMONITOR_SIZE===\n{len(out)}\n"
        f"===XMONITOR_EXIT===\n{exit_code if exit_code is not None else ''}\n"
        f"===XMONITOR_ALIVE===\n{1 if alive else 0}\n"
        f"===XMONITOR_OUT===\n{out}"
    ), '')


def _setup(db_manager, plugin=None):
    """An engine whose connector answers from a queue of results, and a monitor wired to it."""
    plugin = plugin or Group('Rack', {'id': 'rack', 'actions': _ACTIONS})
    plugin.target = 'host'
    plugin.jobs = JobsGateway(db_manager, plugin)
    engine = object.__new__(XMonitorEngine)
    engine.db = db_manager
    engine.plugins = [plugin]
    engine._exec_contexts = {plugin.id: MagicMock(is_agent=False)}
    engine._apply = MagicMock()
    engine.connectors = MagicMock()
    engine.connectors.execute = AsyncMock()
    engine.action_jobs = ActionJobs(engine)
    return engine, plugin


def _logged(engine):
    return [line for call in engine._apply.call_args_list for line in call.args[1].logs]


class TestLaunch:
    async def test_a_detached_action_starts_a_job(self, db_manager):
        engine, plugin = _setup(db_manager)
        engine.connectors.execute.return_value = CmdResult(0, '4242\n', '')
        success, metadata = await engine.dispatch_action(plugin, 'custom:sync')
        assert success and metadata['job_id'] == plugin.jobs.action_job('custom:sync')['id']
        command = engine.connectors.execute.await_args.args[1].command
        assert 'setsid' in command and 'timeout 3600 sh -c sync-all' in command
        assert plugin.jobs.action_job('custom:sync')['pid'] == 4242
        assert _logged(engine) == [('Sync started in the background (pid 4242)', 'INFO')]

    async def test_a_failed_launch_is_the_actions_failure(self, db_manager):
        engine, plugin = _setup(db_manager)
        engine.connectors.execute.return_value = CmdResult(-1, '', 'agent offline')
        success, _ = await engine.dispatch_action(plugin, 'custom:sync')
        assert not success and plugin.jobs.action_job('custom:sync') is None
        assert _logged(engine) == [('Sync failed (exit -1): agent offline', 'ERROR')]

    async def test_a_second_run_is_refused_while_one_runs(self, db_manager):
        engine, plugin = _setup(db_manager)
        engine.connectors.execute.return_value = CmdResult(0, '4242\n', '')
        await engine.dispatch_action(plugin, 'custom:sync')
        success, metadata = await engine.dispatch_action(plugin, 'custom:sync')
        assert not success and metadata == {'content': 'Sync is already running'}
        assert engine.connectors.execute.await_count == 1

    def test_no_timeout_leaves_the_command_alone(self):
        assert bounded('sync-all', None) == 'sync-all'


class TestFollow:
    async def _launched(self, db_manager):
        engine, plugin = _setup(db_manager)
        engine.connectors.execute.return_value = CmdResult(0, '4242\n', '')
        await engine.dispatch_action(plugin, 'custom:sync')
        engine._apply.reset_mock()
        return engine, plugin, plugin.jobs.action_job('custom:sync')['id']

    async def test_a_running_job_gains_output_and_progress(self, db_manager):
        engine, plugin, job_id = await self._launched(db_manager)
        engine.connectors.execute.return_value = _poll('copied 1\ncopied 2\n')
        await engine.action_jobs.poll_all()
        job = plugin.jobs.action_job('custom:sync')
        assert job['progress'] == 'copied 2'
        assert [row['message'] for row in db_manager.job_output(job_id, limit=0)] == ['copied 1', 'copied 2']
        assert not engine._apply.called

    async def test_a_finished_job_is_interpreted_from_its_whole_output(self, db_manager):
        engine, plugin, job_id = await self._launched(db_manager)
        engine.connectors.execute.return_value = _poll('copied 1\n')
        await engine.action_jobs.poll_all()
        engine.connectors.execute.return_value = _poll('copied 2\n', exit_code=0, alive=False)
        await engine.action_jobs.poll_all()
        assert plugin.jobs.action_job('custom:sync') is None
        assert db_manager.get_job(job_id)['state'] == 'succeeded'
        assert _logged(engine) == [('Sync ran: copied 1\ncopied 2', 'INFO')]

    async def test_a_failed_job_is_reported(self, db_manager):
        engine, _, job_id = await self._launched(db_manager)
        engine.connectors.execute.return_value = _poll('no space\n', exit_code=3, alive=False)
        await engine.action_jobs.poll_all()
        assert db_manager.get_job(job_id)['state'] == 'failed'
        assert _logged(engine) == [('Sync failed (exit 3): no space', 'ERROR')]

    async def test_a_vanished_job_fails(self, db_manager):
        engine, _, job_id = await self._launched(db_manager)
        engine.connectors.execute.return_value = _poll('', alive=False)
        await engine.action_jobs.poll_all()
        assert db_manager.get_job(job_id)['error'] == 'Process ended without writing an exit code'

    async def test_an_unanswered_poll_leaves_the_job_running(self, db_manager):
        engine, plugin, _ = await self._launched(db_manager)
        engine.connectors.execute.return_value = CmdResult(-1, '', 'timed out')
        await engine.action_jobs.poll_all()
        assert plugin.jobs.action_job('custom:sync') is not None

    async def test_a_restarted_engine_adopts_a_running_job(self, db_manager):
        _, plugin, job_id = await self._launched(db_manager)
        engine, _ = _setup(db_manager, plugin)
        engine.connectors.execute.return_value = _poll('done\n', exit_code=0, alive=False)
        await engine.action_jobs.poll_all()
        poll = engine.connectors.execute.await_args.args[1].command
        assert 'kill -0 4242' in poll
        assert db_manager.get_job(job_id)['state'] == 'succeeded'

    async def test_a_plugin_action_gets_its_arguments_back(self, db_manager):
        plugin = Group('Rack', {'id': 'rack'})
        plugin.plan_action = lambda action_id, **kwargs: ActionPlan('long', detached=True)
        seen = []

        def interpret(action_id, result, **kwargs):
            seen.append((action_id, result.stdout, kwargs))
            return CollectResult(logs=[('done', 'INFO')])

        plugin.interpret_action = interpret
        engine, plugin = _setup(db_manager, plugin)
        engine.connectors.execute.return_value = CmdResult(0, '7\n', '')
        await engine.dispatch_action(plugin, 'diff', archive='b2')
        engine.connectors.execute.return_value = _poll('a\n', exit_code=0, alive=False)
        await engine.action_jobs.poll_all()
        assert seen == [('diff', 'a', {'archive': 'b2'})]


def test_the_poll_reads_the_jobs_workdir():
    assert 'tail -c +1' in detached.poll_command('$HOME/x', 1, 0)
