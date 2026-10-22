"""Scheduled actions: cron parsing, next-run times, and when the engine starts a run."""

import asyncio
import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from x_monitor.__main__ import XMonitorEngine
from x_monitor.core.coordination.schedule import CronSchedule, ScheduledAction, parse_schedule


# ===== Cron expressions =====

class TestCronSchedule:
    def test_daily_time_runs_next_at_that_time(self):
        cron = CronSchedule.parse('30 2 * * *')
        assert cron.next_after(datetime(2026, 10, 21, 1, 0)) == datetime(2026, 10, 21, 2, 30)
        assert cron.next_after(datetime(2026, 10, 21, 2, 30)) == datetime(2026, 10, 22, 2, 30)

    def test_steps_ranges_and_lists(self):
        cron = CronSchedule.parse('*/15 9-17 * * 1-5')
        assert cron.minutes == {0, 15, 30, 45}
        assert cron.hours == set(range(9, 18))
        # Saturday 24 October rolls on to Monday 26 October.
        assert cron.next_after(datetime(2026, 10, 23, 17, 50)) == datetime(2026, 10, 26, 9, 0)

    def test_names_and_sunday_as_seven(self):
        assert CronSchedule.parse('0 0 * jan,jul sun').months == {1, 7}
        assert CronSchedule.parse('0 0 * * 7').weekdays == {0}

    def test_aliases(self):
        cron = CronSchedule.parse('@weekly')
        assert cron.next_after(datetime(2026, 10, 21, 12, 0)) == datetime(2026, 10, 25, 0, 0)

    def test_restricted_day_and_weekday_match_either(self):
        # The 1st of the month or any Monday, as cron reads it.
        cron = CronSchedule.parse('0 0 1 * mon')
        assert cron.next_after(datetime(2026, 10, 21)) == datetime(2026, 10, 26)
        assert cron.next_after(datetime(2026, 10, 27)) == datetime(2026, 11, 1)

    def test_leap_day_is_found(self):
        assert CronSchedule.parse('0 0 29 2 *').next_after(datetime(2026, 3, 1)) == datetime(2028, 2, 29)

    @pytest.mark.parametrize('expression', [
        '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', '0 0 30 2 *', 'x * * * *',
    ])
    def test_rejects_bad_expressions(self, expression):
        with pytest.raises(ValueError):
            CronSchedule.parse(expression)


class TestParseSchedule:
    def test_reads_entries(self):
        entries = parse_schedule([{'action': 'run_backup', 'cron': '0 3 * * *'},
                                  {'action': 'restart', 'cron': '@daily', 'args': {'unit': 'x'}}])
        assert [e.action for e in entries] == ['run_backup', 'restart']
        assert entries[1].args == {'unit': 'x'}

    def test_empty_is_no_schedule(self):
        assert parse_schedule(None) == []

    @pytest.mark.parametrize('value', [{'action': 'x'}, [{'action': 'x'}], [{'cron': '@daily'}],
                                       [{'action': 'x', 'cron': '@daily', 'args': [1]}]])
    def test_rejects_malformed_entries(self, value):
        with pytest.raises(ValueError):
            parse_schedule(value)

    def test_changed_arguments_get_their_own_state(self):
        cron = CronSchedule.parse('@daily')
        assert (ScheduledAction('a', cron, {'x': 1}).state_key('p')
                != ScheduledAction('a', cron, {'x': 2}).state_key('p'))


# ===== The engine's schedule loop =====

def _engine(plugin):
    """An engine with one monitor, an in-memory settings store, and a recorded dispatch."""
    engine = object.__new__(XMonitorEngine)
    engine.plugins = [plugin]
    engine._scheduled_running = set()
    engine._tasks = set()
    settings = {}
    engine.db = MagicMock()
    engine.db.get_setting.side_effect = lambda key, default=None: settings.get(key, default)
    engine.db.set_setting.side_effect = settings.__setitem__
    engine.dispatch_action = AsyncMock(return_value=(True, None))
    engine._apply = MagicMock()
    return engine, settings


def _monitor(cron='0 3 * * *', args=None):
    return MagicMock(id='borg', children=[],
                     scheduled_actions=parse_schedule([{'action': 'run_backup', 'cron': cron,
                                                        'args': args or {}}]))


def _at(*parts) -> float:
    return datetime(*parts).timestamp()


async def _settle():
    await asyncio.sleep(0)
    await asyncio.sleep(0)


class TestScheduleLoop:
    async def test_new_schedule_waits_for_its_next_time(self):
        engine, settings = _engine(_monitor())
        engine._start_due_schedules(_at(2026, 10, 21, 4, 0))
        await _settle()
        engine.dispatch_action.assert_not_awaited()
        assert list(settings.values()) == [str(int(_at(2026, 10, 21, 4, 0)))]

    async def test_runs_once_its_time_comes(self):
        plugin = _monitor(args={'note': 'nightly'})
        engine, _ = _engine(plugin)
        engine._start_due_schedules(_at(2026, 10, 21, 2, 0))
        engine._start_due_schedules(_at(2026, 10, 21, 2, 59))
        await _settle()
        engine.dispatch_action.assert_not_awaited()

        engine._start_due_schedules(_at(2026, 10, 21, 3, 0, 10))
        engine._start_due_schedules(_at(2026, 10, 21, 3, 0, 40))
        await _settle()
        engine.dispatch_action.assert_awaited_once_with(plugin, 'run_backup', note='nightly')
        assert engine._apply.call_args.args[1].logs == [('Scheduled run_backup (0 3 * * *) ran', 'INFO')]

    async def test_missed_runs_collapse_into_one(self):
        engine, _ = _engine(_monitor())
        engine._start_due_schedules(_at(2026, 10, 18, 4, 0))
        # Down for three nights: one run on return, none on the next check.
        engine._start_due_schedules(_at(2026, 10, 21, 12, 0))
        engine._start_due_schedules(_at(2026, 10, 21, 12, 0, 30))
        await _settle()
        assert engine.dispatch_action.await_count == 1

    async def test_a_running_action_is_not_started_again(self):
        engine, _ = _engine(_monitor(cron='* * * * *'))
        release = asyncio.Event()

        async def slow(*args, **kwargs):
            await release.wait()
            return True, None
        engine.dispatch_action = AsyncMock(side_effect=slow)
        engine._start_due_schedules(_at(2026, 10, 21, 3, 0))
        engine._start_due_schedules(_at(2026, 10, 21, 3, 1))
        engine._start_due_schedules(_at(2026, 10, 21, 3, 2))
        await _settle()
        assert engine.dispatch_action.await_count == 1
        release.set()
        await _settle()

    async def test_failure_is_logged_on_the_monitor(self):
        engine, _ = _engine(_monitor())
        engine.dispatch_action = AsyncMock(side_effect=RuntimeError('agent gone'))
        engine._start_due_schedules(_at(2026, 10, 21, 2, 0))
        engine._start_due_schedules(_at(2026, 10, 21, 3, 0))
        await _settle()
        assert engine._apply.call_args.args[1].logs == [
            ('Scheduled run_backup (0 3 * * *) failed: agent gone', 'ERROR')]
        assert engine._scheduled_running == set()


class TestScheduleResult:
    async def test_a_run_records_when_it_started_and_how_it_went(self):
        engine, settings = _engine(_monitor())
        engine._start_due_schedules(_at(2026, 10, 21, 2, 0))
        engine._start_due_schedules(_at(2026, 10, 21, 3, 0))
        await _settle()
        record = json.loads(settings[_monitor().scheduled_actions[0].result_key('borg')])
        assert record['ok'] is True and record['message'] == 'Scheduled run_backup (0 3 * * *) ran'

    async def test_a_failed_run_is_recorded_as_failed(self):
        engine, settings = _engine(_monitor())
        engine.dispatch_action = AsyncMock(side_effect=RuntimeError('agent gone'))
        engine._start_due_schedules(_at(2026, 10, 21, 2, 0))
        engine._start_due_schedules(_at(2026, 10, 21, 3, 0))
        await _settle()
        record = json.loads(settings[_monitor().scheduled_actions[0].result_key('borg')])
        assert record['ok'] is False and 'agent gone' in record['message']

    def test_the_result_key_is_distinct_from_the_run_key(self):
        entry = _monitor().scheduled_actions[0]
        assert entry.result_key('borg') != entry.state_key('borg')
