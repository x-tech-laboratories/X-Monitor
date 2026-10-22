"""Scheduled actions: a monitor's `schedule` list, each entry one of its
actions run at the times a five-field cron expression names, in local time.
Parsing and the next-run calculation are pure; the engine's schedule loop
does the running and keeps each entry's last handled time in the settings
store."""

import json
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, FrozenSet, List, Optional


# ===== Cron expressions =====

_ALIASES = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
}

_MONTH_NAMES = {name: number for number, name in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], start=1)}

_WEEKDAY_NAMES = {name: number for number, name in enumerate(
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])}

# Long enough to reach a 29 February across a century year that skips its leap day.
_SEARCH_DAYS = 366 * 9


def _field_value(text: str, names: Dict[str, int], label: str) -> int:
    """Read one number or name from a cron field."""
    lowered = text.lower()
    if lowered in names:
        return names[lowered]
    if not text.isdigit():
        raise ValueError(f"{label} has an unrecognised value {text!r}")
    return int(text)


def _parse_field(text: str, low: int, high: int, label: str,
                 names: Optional[Dict[str, int]] = None) -> FrozenSet[int]:
    """Expand one cron field, such as `*/15`, `1-5` or `mon,wed`, into the values it allows."""
    names = names or {}
    values = set()
    for part in text.split(','):
        base, _, step_text = part.partition('/')
        step = 1
        if step_text:
            if not step_text.isdigit() or int(step_text) == 0:
                raise ValueError(f"{label} has a bad step {step_text!r}")
            step = int(step_text)
        if base == '*':
            start, end = low, high
        elif '-' in base:
            start_text, end_text = base.split('-', 1)
            start = _field_value(start_text, names, label)
            end = _field_value(end_text, names, label)
        else:
            start = _field_value(base, names, label)
            # A lone value with a step, as in `5/10`, runs from that value to the end of the range.
            end = high if step_text else start
        if not (low <= start <= high and low <= end <= high) or start > end:
            raise ValueError(f"{label} value {base!r} is outside {low}-{high}")
        values.update(range(start, end + 1, step))
    return frozenset(values)


@dataclass(frozen=True)
class CronSchedule:
    """A parsed five-field cron expression: minute, hour, day of month, month, day of week."""

    expression: str
    minutes: FrozenSet[int]
    hours: FrozenSet[int]
    days: FrozenSet[int]
    months: FrozenSet[int]
    weekdays: FrozenSet[int]
    any_day: bool
    any_weekday: bool

    @classmethod
    def parse(cls, expression: str) -> "CronSchedule":
        """Parse an expression such as `"30 2 * * *"` or `"@daily"`, raising ValueError when it is malformed."""
        text = str(expression).strip()
        fields = _ALIASES.get(text.lower(), text).split()
        if len(fields) != 5:
            raise ValueError(f"cron expression {text!r} needs five fields: "
                             "minute hour day-of-month month day-of-week")
        minute, hour, day, month, weekday = fields
        weekdays = _parse_field(weekday, 0, 7, 'day of week', _WEEKDAY_NAMES)
        # Cron allows 7 as a second name for Sunday.
        weekdays = frozenset(0 if value == 7 else value for value in weekdays)
        schedule = cls(
            expression=text,
            minutes=_parse_field(minute, 0, 59, 'minute'),
            hours=_parse_field(hour, 0, 23, 'hour'),
            days=_parse_field(day, 1, 31, 'day of month'),
            months=_parse_field(month, 1, 12, 'month', _MONTH_NAMES),
            weekdays=weekdays,
            any_day=day.startswith('*'),
            any_weekday=weekday.startswith('*'),
        )
        if schedule.next_after(datetime(2000, 1, 1)) is None:
            raise ValueError(f"cron expression {text!r} never matches a real date")
        return schedule

    def matches_day(self, day: date) -> bool:
        """Whether the expression runs on this date; a restricted day of month and day of week match either, as cron does."""
        if day.month not in self.months:
            return False
        weekday = day.isoweekday() % 7
        if self.any_day and self.any_weekday:
            return True
        if self.any_day:
            return weekday in self.weekdays
        if self.any_weekday:
            return day.day in self.days
        return day.day in self.days or weekday in self.weekdays

    def next_after(self, moment: datetime) -> Optional[datetime]:
        """The first run strictly after `moment`, as a naive local time, or None if there is none."""
        start = moment.replace(second=0, microsecond=0) + timedelta(minutes=1)
        day = start.date()
        for _ in range(_SEARCH_DAYS):
            if self.matches_day(day):
                for hour in sorted(self.hours):
                    for minute in sorted(self.minutes):
                        candidate = datetime.combine(day, time(hour, minute))
                        if candidate >= start:
                            return candidate
            day += timedelta(days=1)
        return None


# ===== A monitor's schedule =====

@dataclass(frozen=True)
class ScheduledAction:
    """One `schedule` entry: the action to run, when, and the arguments to pass it."""

    action: str
    cron: CronSchedule
    args: Dict[str, Any] = field(default_factory=dict)

    def state_key(self, plugin_id: str) -> str:
        """The settings key holding this entry's last handled time; a changed expression or argument starts afresh."""
        key = f'schedule:{plugin_id}:{self.action}:{self.cron.expression}'
        if self.args:
            key += ':' + json.dumps(self.args, sort_keys=True)
        return key

    def due(self, handled: float, now: float) -> bool:
        """Whether a run fell after the last handled time and no later than now."""
        upcoming = self.cron.next_after(datetime.fromtimestamp(handled))
        return upcoming is not None and upcoming.timestamp() <= now


def parse_schedule(value: Any) -> List[ScheduledAction]:
    """Read a monitor's `schedule` list, raising ValueError on a malformed entry."""
    if not value:
        return []
    if not isinstance(value, list):
        raise ValueError("`schedule` must be a list of {action, cron} entries")
    entries = []
    for entry in value:
        if not isinstance(entry, dict) or not entry.get('action') or not entry.get('cron'):
            raise ValueError(f"each `schedule` entry needs an `action` and a `cron`, not {entry!r}")
        args = entry.get('args') or {}
        if not isinstance(args, dict):
            raise ValueError(f"`args` of the scheduled {entry['action']!r} must be a mapping")
        entries.append(ScheduledAction(str(entry['action']), CronSchedule.parse(entry['cron']), dict(args)))
    return entries
