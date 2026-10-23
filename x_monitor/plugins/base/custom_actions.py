"""Custom actions: a monitor's `actions` list, each entry a shell command the
user adds as a button on that monitor's page. Any plugin type accepts them.
Parsing, planning and reading the outcome are pure; the engine runs the
command over the monitor's own transport, or on the agent an entry names."""

import re
from dataclasses import dataclass
from typing import Any, List, Optional

from x_monitor.core.connectors.types import ActionPlan, CmdResult, CollectResult
from x_monitor.core.contracts import ActionButtonSpec
from x_monitor.plugins.base.plugin_helpers import parse_duration


# ===== Identity =====

# Prefix of every custom action's id, so one can never shadow an action the plugin itself offers.
ACTION_PREFIX = 'custom:'

DEFAULT_ICON = 'terminal'

# Characters of command output kept in the monitor's log line.
OUTPUT_LOG_LIMIT = 500


def _slug(text: str) -> str:
    """Turn a display name into an id: lower case, with runs of other characters as one underscore."""
    return re.sub(r'[^a-z0-9]+', '_', text.lower()).strip('_')


# ===== The action =====

@dataclass(frozen=True)
class CustomAction:
    action_id: str
    name: str
    command: str
    icon: str = DEFAULT_ICON
    confirm: Optional[str] = None
    danger: bool = False
    timeout: Optional[float] = None
    agent: Optional[str] = None

    def button(self) -> ActionButtonSpec:
        """The header button this action shows as."""
        spec: ActionButtonSpec = {'action_id': self.action_id, 'name': self.name, 'icon': self.icon}
        if self.danger:
            spec['variant'] = 'danger'
        if self.confirm:
            spec['confirm'] = self.confirm
        return spec

    def plan(self) -> ActionPlan:
        return ActionPlan(self.command, timeout=self.timeout, agent=self.agent)

    def interpret(self, result: CmdResult) -> CollectResult:
        """Succeed on exit code 0, and log the outcome with the command's output on the monitor."""
        success = result.exit_code == 0
        output = (result.stdout.strip() if success else (result.stderr.strip() or result.stdout.strip()))
        if len(output) > OUTPUT_LOG_LIMIT:
            output = output[:OUTPUT_LOG_LIMIT] + '…'
        message = f"{self.name} ran" if success else f"{self.name} failed (exit {result.exit_code})"
        if output:
            message += f": {output}"
        return CollectResult(logs=[(message, 'INFO' if success else 'ERROR')],
                             metadata={'content': result.stdout}, success=success)


# ===== Parsing =====

def parse_custom_actions(value: Any) -> List[CustomAction]:
    """Read a monitor's `actions` list, raising ValueError on a malformed entry."""
    if not value:
        return []
    if not isinstance(value, list):
        raise ValueError("`actions` must be a list of {name, command} entries")
    actions = []
    seen = set()
    for entry in value:
        if not isinstance(entry, dict) or not entry.get('name') or not entry.get('command'):
            raise ValueError(f"each `actions` entry needs a `name` and a `command`, not {entry!r}")
        name = str(entry['name'])
        key = _slug(str(entry.get('id') or name))
        if not key:
            raise ValueError(f"the action {name!r} needs an `id` made of letters or digits")
        if key in seen:
            raise ValueError(f"two `actions` entries share the id {key!r}; give one its own `id`")
        seen.add(key)
        timeout = entry.get('timeout')
        actions.append(CustomAction(
            action_id=ACTION_PREFIX + key,
            name=name,
            command=str(entry['command']),
            icon=str(entry.get('icon') or DEFAULT_ICON),
            confirm=str(entry['confirm']) if entry.get('confirm') else None,
            danger=bool(entry.get('danger', False)),
            timeout=parse_duration(timeout) if timeout is not None else None,
            agent=str(entry['agent']) if entry.get('agent') else None,
        ))
    return actions
