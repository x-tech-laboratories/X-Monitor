"""Triggered actions: a monitor's `triggers` list, each entry one of its
actions run when a collection cycle shows a condition, either the monitor's
status or one of its metrics. An entry runs once each time its condition
becomes true and has held for `for`, and is armed again once the condition
clears. Parsing and the decision are pure; the engine checks every cycle,
runs the action and keeps each entry's state in the settings store."""

import json
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from x_monitor.core.connectors.types import CollectResult, Status


# ===== Conditions =====

_COMPARISONS = {
    'above': ('>', lambda value, limit: value > limit),
    'below': ('<', lambda value, limit: value < limit),
    'equals': ('=', lambda value, limit: value == limit),
}


@dataclass(frozen=True)
class Condition:
    """What a trigger watches: a set of statuses, or a metric compared with a limit."""

    statuses: FrozenSet[str] = frozenset()
    metric: Optional[str] = None
    comparison: Optional[str] = None
    limit: float = 0.0

    def holds(self, result: CollectResult) -> Optional[bool]:
        """Whether the cycle shows the condition, or None when the cycle did not report what it watches."""
        if self.metric is None:
            return None if result.status is None else str(result.status) in self.statuses
        value = (result.metrics or {}).get(self.metric)
        if value is None:
            return None
        return _COMPARISONS[self.comparison][1](float(value), self.limit)

    def describe(self) -> str:
        """The condition in words, such as `status is warning or failed` or `up_to_date < 1`."""
        if self.metric is None:
            return 'status is ' + ' or '.join(sorted(self.statuses))
        return f"{self.metric} {_COMPARISONS[self.comparison][0]} {self.limit:g}"


def _parse_condition(entry: Dict[str, Any], action: str) -> Condition:
    """Read an entry's `status` or `metric` condition, raising ValueError when it names neither or both."""
    if ('status' in entry) == ('metric' in entry):
        raise ValueError(f"the triggered {action!r} needs exactly one of `status` or `metric`")
    if 'status' in entry:
        names = entry['status'] if isinstance(entry['status'], list) else [entry['status']]
        statuses = set()
        for name in names:
            try:
                statuses.add(str(Status(str(name))))
            except ValueError:
                raise ValueError(f"the triggered {action!r} names an unknown status {name!r}; use "
                                 + ', '.join(str(s) for s in Status)) from None
        if not statuses:
            raise ValueError(f"the triggered {action!r} needs at least one status")
        return Condition(statuses=frozenset(statuses))
    given = [key for key in _COMPARISONS if key in entry]
    if len(given) != 1:
        raise ValueError(f"the triggered {action!r} needs exactly one of `above`, `below` or `equals`")
    try:
        limit = float(entry[given[0]])
    except (TypeError, ValueError):
        raise ValueError(f"`{given[0]}` of the triggered {action!r} must be a number") from None
    return Condition(metric=str(entry['metric']), comparison=given[0], limit=limit)


# ===== A monitor's triggers =====

@dataclass(frozen=True)
class TriggeredAction:
    """One `triggers` entry: the action to run, the condition that runs it, how long it must hold, and the arguments."""

    action: str
    condition: Condition
    hold: int = 0
    args: Dict[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        """When the action runs, in words."""
        # Imported here, since plugin_helpers imports this module while it loads.
        from x_monitor.plugins.base.plugin_helpers import format_duration
        text = f"when {self.condition.describe()}"
        return text + f" for {format_duration(self.hold)}" if self.hold else text

    def state_key(self, plugin_id: str) -> str:
        """The settings key holding this entry's state; a changed condition, hold or argument starts afresh."""
        key = f'trigger:{plugin_id}:{self.action}:{self.describe()}'
        if self.args:
            key += ':' + json.dumps(self.args, sort_keys=True)
        return key

    def result_key(self, plugin_id: str) -> str:
        """The settings key holding this entry's last run: when it started, whether it succeeded, and what it logged."""
        return 'trigger-result:' + self.state_key(plugin_id)[len('trigger:'):]

    def step(self, state: Dict[str, Any], holds: Optional[bool], now: float) -> Tuple[Dict[str, Any], bool]:
        """The entry's next state after a cycle, and whether to run the action now.

        The state records when the condition started holding and whether this
        episode already ran the action. A cycle that did not report what the
        entry watches leaves the state as it was."""
        if holds is None:
            return state, False
        if not holds:
            return {}, False
        since = state.get('since', now)
        if state.get('fired') or now - since < self.hold:
            return {'since': since, 'fired': bool(state.get('fired'))}, False
        return {'since': since, 'fired': True}, True


def parse_triggers(value: Any) -> List[TriggeredAction]:
    """Read a monitor's `triggers` list, raising ValueError on a malformed entry."""
    from x_monitor.plugins.base.plugin_helpers import parse_duration
    if not value:
        return []
    if not isinstance(value, list):
        raise ValueError("`triggers` must be a list of {action, status | metric} entries")
    entries = []
    for entry in value:
        if not isinstance(entry, dict) or not entry.get('action'):
            raise ValueError(f"each `triggers` entry needs an `action`, not {entry!r}")
        action = str(entry['action'])
        args = entry.get('args') or {}
        if not isinstance(args, dict):
            raise ValueError(f"`args` of the triggered {action!r} must be a mapping")
        hold = parse_duration(entry.get('for', 0))
        entries.append(TriggeredAction(action, _parse_condition(entry, action), hold, dict(args)))
    return entries
