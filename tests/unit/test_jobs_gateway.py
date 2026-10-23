"""JobsGateway separates a plugin's main job from the side jobs that run beside it."""

import asyncio
from unittest.mock import MagicMock

from x_monitor.core.coordination.action_jobs import POLL_SECONDS, ActionJobs
from x_monitor.core.coordination.jobs import (
    ACTION_LOOP, WATCHED_POLL_SECONDS, JobsGateway, action_id_of, action_job_kind, sleep_unless_watched,
)
from x_monitor.plugins.base.plugin_base import Plugin


class _Plugin(Plugin):
    SIDE_JOB_KINDS = ('eval',)


def _gateway(db_manager):
    plugin = _Plugin('p', {'name': 'p', 'id': 'p', 'interval': 60})
    plugin.target = 'host'
    gateway = JobsGateway(db_manager, plugin)
    plugin.jobs = gateway
    return plugin, gateway


def _start(gateway, kind):
    job_id = gateway.create(kind, 'true', '/tmp/x')
    gateway.set_pid(job_id, 100 + job_id)
    return job_id


class TestKinds:
    def test_an_action_kind_names_its_action(self):
        assert action_id_of(action_job_kind('custom:sync')) == 'custom:sync'

    def test_a_plain_kind_names_no_action(self):
        assert action_id_of('backup') is None


class TestSideJobs:
    def test_a_detached_action_is_not_the_main_job(self, db_manager):
        _, gateway = _gateway(db_manager)
        _start(gateway, action_job_kind('prune'))
        assert gateway.running() is None and not gateway.is_running()
        assert gateway.action_job('prune')['kind'] == 'action:prune'
        assert gateway.any_running()

    def test_a_named_side_kind_is_not_the_main_job(self, db_manager):
        _, gateway = _gateway(db_manager)
        _start(gateway, 'eval')
        assert gateway.running() is None
        assert gateway.running_side('eval')['kind'] == 'eval'

    def test_the_main_job_is_found_beside_side_jobs(self, db_manager):
        _, gateway = _gateway(db_manager)
        _start(gateway, 'eval')
        _start(gateway, 'switch')
        _start(gateway, action_job_kind('prune'))
        assert gateway.running()['kind'] == 'switch'

    def test_a_running_side_kind_polls_sooner(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        plugin.job_poll_interval = 30
        assert plugin.next_cycle_in() is None
        _start(gateway, 'eval')
        assert plugin.next_cycle_in() == 30

    def test_a_running_action_does_not_poll_the_plugin_sooner(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        plugin.job_poll_interval = 30
        _start(gateway, action_job_kind('prune'))
        assert plugin.next_cycle_in() is None


class TestActionState:
    def test_a_detached_action_fills_while_it_runs(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        action = {'action_id': 'prune', 'name': 'Prune', 'detached': True}
        assert plugin.action_state(action) == 'normal'
        _start(gateway, action_job_kind('prune'))
        assert plugin.action_state(action) == 'accent'


class TestCancel:
    async def test_cancel_stops_a_detached_action_when_no_main_job_runs(self, db_manager):
        sent = []

        async def cancel_exec(command, agent=None):
            sent.append(command)

        plugin, _ = _gateway(db_manager)
        gateway = JobsGateway(db_manager, plugin, cancel_exec=cancel_exec)
        job_id = _start(gateway, action_job_kind('prune'))
        assert await gateway.cancel()
        assert sent and str(100 + job_id) in sent[0]
        assert gateway.action_job('prune') is None


class TestHistory:
    def test_excluded_kinds_stay_out_of_the_history(self, db_manager):
        _, gateway = _gateway(db_manager)
        kept = [_start(gateway, 'switch')]
        for _ in range(3):
            _start(gateway, 'eval')
        kept.append(_start(gateway, 'update'))
        assert [job['id'] for job in gateway.recent(limit=2, exclude_kinds=('eval',))] == kept[::-1]
        assert len(gateway.recent(limit=99)) == 5


class TestWatching:
    def test_a_watched_job_is_polled_every_few_seconds(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        job_id = _start(gateway, 'gc')
        assert plugin.next_cycle_in() is None
        unwatch = gateway.watch(gateway.running())
        assert plugin.next_cycle_in() == WATCHED_POLL_SECONDS
        unwatch()
        assert plugin.next_cycle_in() is None
        assert job_id

    def test_a_watch_beats_a_slower_job_poll(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        plugin.job_poll_interval = 30
        _start(gateway, 'gc')
        unwatch = gateway.watch(gateway.running())
        try:
            assert plugin.next_cycle_in() == WATCHED_POLL_SECONDS
        finally:
            unwatch()
        assert plugin.next_cycle_in() == 30

    def test_a_finished_watched_job_stops_the_fast_polling(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        job_id = _start(gateway, 'gc')
        unwatch = gateway.watch(gateway.running())
        try:
            gateway.finish(job_id, 'succeeded', exit_code=0)
            assert plugin.next_cycle_in() is None
        finally:
            unwatch()

    def test_a_watched_action_speeds_the_action_loop_not_the_monitor(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        _start(gateway, action_job_kind('prune'))
        follower = ActionJobs(MagicMock(db=db_manager))
        assert follower.poll_seconds() == POLL_SECONDS
        unwatch = gateway.watch(gateway.action_job('prune'))
        try:
            assert plugin.next_cycle_in() is None
            assert follower.poll_seconds() == WATCHED_POLL_SECONDS
        finally:
            unwatch()
        assert follower.poll_seconds() == POLL_SECONDS

    async def test_a_new_watch_wakes_only_its_own_loop(self, db_manager):
        plugin, gateway = _gateway(db_manager)
        _start(gateway, 'gc')
        own = asyncio.ensure_future(sleep_unless_watched(60, plugin.id))
        other = asyncio.ensure_future(sleep_unless_watched(60, ACTION_LOOP))
        await asyncio.sleep(0)
        unwatch = gateway.watch(gateway.running())
        try:
            assert await asyncio.wait_for(own, 1) is True
            assert not other.done()
        finally:
            unwatch()
            other.cancel()

    async def test_a_cancelled_sleep_still_cancels(self):
        nap = asyncio.ensure_future(sleep_unless_watched(60, 'p'))
        await asyncio.sleep(0)
        nap.cancel()
        try:
            await nap
        except asyncio.CancelledError:
            return
        raise AssertionError('the cancellation was swallowed')
