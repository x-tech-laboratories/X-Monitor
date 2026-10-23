"""JobsGateway separates a plugin's main job from the side jobs that run beside it."""

from x_monitor.core.coordination.jobs import JobsGateway, action_id_of, action_job_kind
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
