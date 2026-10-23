"""The engine running an action on another monitor's transport, and running the action a plugin asks for after a cycle."""

import asyncio
from typing import List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import ActionPlan, CmdResult, Command, CollectResult


class _Probe(Plugin):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.status = 'online'
        self.reaction = None
        self.seen = []
        self.outcomes = []

    def commands(self) -> List[Command]:
        return []

    def parse(self, results: List[CmdResult]) -> CollectResult:
        return CollectResult(status=self.status)

    def on_status(self, status, now):
        self.seen.append(status)
        return self.reaction

    def plan_action(self, action_id, **kwargs):
        if action_id == 'remote':
            return ActionPlan('echo hi', via=kwargs.get('via'))
        if action_id == 'poke':
            return CollectResult(logs=[(f"poked {kwargs}", 'INFO')], success=True)
        return None

    def interpret_action(self, action_id, result, **kwargs):
        self.outcomes.append(result)
        return result.exit_code == 0

    def render_ui(self, context: str = 'page'):
        pass


@pytest.fixture
def engine(tmp_path):
    from x_monitor.__main__ import XMonitorEngine
    cfg = tmp_path / "c.yaml"
    cfg.write_text("plugins: []\n")
    return XMonitorEngine(str(cfg), db_path_override=str(tmp_path / "e.db"))


@pytest.fixture
def probe(make_plugin, engine):
    plugin = make_plugin(_Probe, {"interval": 3600})
    plugin.engine = engine
    engine._exec_contexts[plugin.id] = MagicMock(name='own-context')
    return plugin


async def _settle(engine):
    while engine._tasks:
        await asyncio.gather(*list(engine._tasks))


class TestVia:
    async def test_runs_on_the_named_monitors_transport(self, engine, probe):
        other = MagicMock(name='host1-context')
        engine._exec_contexts['host1-ssh'] = other
        with patch.object(engine.connectors, 'execute', AsyncMock(return_value=CmdResult(0, 'hi', ''))) as run:
            ok, _ = await engine.dispatch_action(probe, 'remote', via='host1-ssh')
        assert ok is True
        assert run.await_args.args[0] is other

    async def test_without_via_uses_its_own_transport(self, engine, probe):
        with patch.object(engine.connectors, 'execute', AsyncMock(return_value=CmdResult(0, '', ''))) as run:
            await engine.dispatch_action(probe, 'remote')
        assert run.await_args.args[0] is engine._exec_contexts[probe.id]

    async def test_unknown_monitor_fails_without_running_anything(self, engine, probe):
        with patch.object(engine.connectors, 'execute', AsyncMock()) as run:
            ok, _ = await engine.dispatch_action(probe, 'remote', via='nowhere')
        assert ok is False
        run.assert_not_awaited()
        assert "No monitor 'nowhere'" in probe.outcomes[0].stderr


class TestStatusReaction:
    async def test_each_cycle_offers_its_status(self, engine, probe):
        probe.status = 'failed'
        await engine.run_cycle_now(probe)
        assert probe.seen == ['failed']

    async def test_the_asked_for_action_runs(self, engine, probe):
        probe.status = 'failed'
        probe.reaction = ('poke', {'automatic': True, 'attempt': 1})
        with patch.object(engine, 'dispatch_action', AsyncMock(return_value=(True, None))) as dispatch:
            await engine.run_cycle_now(probe)
            await _settle(engine)
        dispatch.assert_awaited_once_with(probe, 'poke', automatic=True, attempt=1)

    async def test_no_reaction_runs_nothing(self, engine, probe):
        with patch.object(engine, 'dispatch_action', AsyncMock()) as dispatch:
            await engine.run_cycle_now(probe)
            await _settle(engine)
        dispatch.assert_not_awaited()

    async def test_a_cycle_without_a_status_is_not_offered(self, engine, probe):
        probe.status = None
        await engine.run_cycle_now(probe)
        assert probe.seen == []

    async def test_a_broken_on_status_does_not_fail_the_cycle(self, engine, probe):
        def boom(status, now):
            raise RuntimeError('boom')
        probe.on_status = boom
        assert await engine.run_cycle_now(probe) is True

    async def test_a_failing_reaction_is_contained(self, engine, probe):
        probe.reaction = ('poke', {})
        with patch.object(engine, 'dispatch_action', AsyncMock(side_effect=RuntimeError('boom'))):
            await engine.run_cycle_now(probe)
            await _settle(engine)

    async def test_uptime_wakes_a_host_that_went_down(self, engine, make_plugin):
        from x_monitor.core.connectors.types import PingResult
        from x_monitor.plugins.uptime import Uptime
        plugin = make_plugin(Uptime, {'name': 'nas', 'id': 'nas', 'target_host': 'host1',
                                      'mac': '00:11:22:33:44:55', 'wake_on_down': True})
        plugin.engine = engine
        engine._exec_contexts[plugin.id] = MagicMock()
        down = [PingResult(exception=None, returncode=1, stderr='timed out')]
        with patch.object(engine.connectors, 'dispatch', AsyncMock(return_value=down)), \
                patch('x_monitor.plugins.uptime.send_magic_packet') as send:
            await engine.run_cycle_now(plugin)
            await _settle(engine)
            await engine.run_cycle_now(plugin)
            await _settle(engine)
        send.assert_called_once()
        events = [e['message'] for e in engine.db.plugin_events(plugin_id='nas', limit=10)]
        assert any('Automatic wake 1 of 3' in m for m in events)
