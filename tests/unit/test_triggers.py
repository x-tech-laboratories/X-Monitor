"""Triggered actions: reading a monitor's `triggers`, deciding when one runs, and the engine running it after a cycle."""

import asyncio
import json
from typing import List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from x_monitor.core.connectors.types import CmdResult, Command, CollectResult
from x_monitor.core.coordination.triggers import parse_triggers
from x_monitor.plugins.base.plugin_base import Plugin


def _one(**entry):
    return parse_triggers([{'action': 'switch', **entry}])[0]


# ===== Parsing =====

class TestParse:
    def test_nothing_configured_is_no_triggers(self):
        assert parse_triggers(None) == []

    def test_a_status_entry(self):
        entry = _one(status=['warning', 'failed'], **{'for': '5m'}, args={'kind': 'data'})
        assert entry.condition.statuses == {'warning', 'failed'}
        assert (entry.hold, entry.args) == (300, {'kind': 'data'})
        assert entry.describe() == 'when status is failed or warning for 5 Minutes'

    def test_a_single_status_needs_no_list(self):
        assert _one(status='failed').condition.statuses == {'failed'}

    def test_a_metric_entry(self):
        entry = _one(metric='up_to_date', below=1)
        assert entry.describe() == 'when up_to_date < 1'

    @pytest.mark.parametrize('entry, message', [
        ({}, 'exactly one of `status` or `metric`'),
        ({'status': 'failed', 'metric': 'x', 'above': 1}, 'exactly one of `status` or `metric`'),
        ({'status': 'broken'}, "unknown status 'broken'"),
        ({'status': []}, 'at least one status'),
        ({'metric': 'x'}, 'exactly one of `above`, `below` or `equals`'),
        ({'metric': 'x', 'above': 1, 'below': 2}, 'exactly one of `above`, `below` or `equals`'),
        ({'metric': 'x', 'above': 'lots'}, 'must be a number'),
        ({'status': 'failed', 'args': ['x']}, '`args`'),
    ])
    def test_a_malformed_entry_is_rejected(self, entry, message):
        with pytest.raises(ValueError, match=message):
            _one(**entry)

    def test_an_entry_without_an_action_is_rejected(self):
        with pytest.raises(ValueError, match='needs an `action`'):
            parse_triggers([{'status': 'failed'}])

    def test_a_changed_condition_gets_a_new_state_key(self):
        assert _one(status='failed').state_key('m') != _one(status='warning').state_key('m')


# ===== Conditions =====

class TestCondition:
    def test_status_holds_only_for_a_listed_status(self):
        condition = _one(status=['failed']).condition
        assert condition.holds(CollectResult(status='failed')) is True
        assert condition.holds(CollectResult(status='online')) is False

    def test_a_cycle_without_a_status_is_unknown(self):
        assert _one(status=['failed']).condition.holds(CollectResult()) is None

    @pytest.mark.parametrize('comparison, value, expected', [
        ('above', 91, True), ('above', 90, False),
        ('below', 0, True), ('below', 1, False),
        ('equals', 1, True), ('equals', 2, False),
    ])
    def test_metric_comparisons(self, comparison, value, expected):
        limit = {'above': 90, 'below': 1, 'equals': 1}[comparison]
        condition = _one(metric='m', **{comparison: limit}).condition
        assert condition.holds(CollectResult(metrics={'m': value})) is expected

    def test_a_cycle_without_the_metric_is_unknown(self):
        assert _one(metric='m', above=1).condition.holds(CollectResult(metrics={'other': 5})) is None


# ===== Deciding =====

class TestStep:
    def test_runs_at_once_without_a_hold(self):
        assert _one(status='failed').step({}, True, 100) == ({'since': 100, 'fired': True}, True)

    def test_runs_once_per_episode(self):
        entry = _one(status='failed')
        state, _ = entry.step({}, True, 100)
        assert entry.step(state, True, 200) == (state, False)

    def test_waits_out_the_hold(self):
        entry = _one(status='failed', **{'for': 60})
        state, fire = entry.step({}, True, 100)
        assert not fire
        state, fire = entry.step(state, True, 159)
        assert not fire
        assert entry.step(state, True, 160) == ({'since': 100, 'fired': True}, True)

    def test_clearing_rearms_it(self):
        entry = _one(status='failed')
        state, _ = entry.step({}, True, 100)
        state, _ = entry.step(state, False, 200)
        assert state == {}
        assert entry.step(state, True, 300)[1] is True

    def test_clearing_during_the_hold_restarts_it(self):
        entry = _one(status='failed', **{'for': 60})
        state, _ = entry.step({}, True, 100)
        state, _ = entry.step(state, False, 130)
        state, fire = entry.step(state, True, 140)
        assert not fire and state['since'] == 140

    def test_an_unknown_cycle_changes_nothing(self):
        state = {'since': 100, 'fired': False}
        assert _one(status='failed').step(state, None, 999) == (state, False)


# ===== The engine =====

class _Probe(Plugin):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.status = 'online'

    def commands(self) -> List[Command]:
        return []

    def parse(self, results: List[CmdResult]) -> CollectResult:
        return CollectResult(status=self.status)

    def plan_action(self, action_id, **kwargs):
        return CollectResult(logs=[(f"ran {action_id}", 'INFO')], success=True)

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
    plugin = make_plugin(_Probe, {"interval": 3600, "triggers": [
        {'action': 'heal', 'status': 'failed', 'args': {'hard': True}}]})
    plugin.engine = engine
    engine._exec_contexts[plugin.id] = MagicMock()
    return plugin


async def _settle(engine):
    while engine._tasks:
        await asyncio.gather(*list(engine._tasks))


class TestEngine:
    async def test_a_cycle_showing_the_condition_runs_the_action_once(self, engine, probe):
        probe.status = 'failed'
        with patch.object(engine, 'dispatch_action', AsyncMock(return_value=(True, None))) as dispatch:
            await engine.run_cycle_now(probe)
            await engine.run_cycle_now(probe)
            await _settle(engine)
        dispatch.assert_awaited_once_with(probe, 'heal', hard=True)

    async def test_it_runs_again_after_the_condition_clears(self, engine, probe):
        with patch.object(engine, 'dispatch_action', AsyncMock(return_value=(True, None))) as dispatch:
            for status in ('failed', 'online', 'failed'):
                probe.status = status
                await engine.run_cycle_now(probe)
            await _settle(engine)
        assert dispatch.await_count == 2

    async def test_a_restart_does_not_repeat_the_episode(self, engine, probe):
        probe.status = 'failed'
        with patch.object(engine, 'dispatch_action', AsyncMock(return_value=(True, None))) as dispatch:
            await engine.run_cycle_now(probe)
            engine._trigger_states.clear()
            await engine.run_cycle_now(probe)
            await _settle(engine)
        assert dispatch.await_count == 1

    async def test_the_outcome_is_recorded_and_logged(self, engine, probe):
        probe.status = 'failed'
        await engine.run_cycle_now(probe)
        await _settle(engine)
        record = json.loads(engine.db.get_setting(probe.triggered_actions[0].result_key(probe.id)))
        assert record['ok'] is True
        events = [e['message'] for e in engine.db.plugin_events(plugin_id=probe.id, limit=10)]
        assert any(m.endswith('Triggered heal (when status is failed) ran') for m in events)

    async def test_a_failing_action_is_contained_and_recorded(self, engine, probe):
        probe.status = 'failed'
        with patch.object(engine, 'dispatch_action', AsyncMock(side_effect=RuntimeError('boom'))):
            await engine.run_cycle_now(probe)
            await _settle(engine)
        record = json.loads(engine.db.get_setting(probe.triggered_actions[0].result_key(probe.id)))
        assert record['ok'] is False and 'boom' in record['message']
