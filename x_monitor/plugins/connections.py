"""TCP connection counts by state, read from /proc/net/tcp. A total at or
above `warning` is a warning, never a failure, since a burst of short-lived
sockets (a port scan, a busy client) is normal; a table that could not be read
is unavailable."""

from collections import Counter

from typing import Any, Dict, List

from x_monitor.plugins.base.signal_plugin import SignalPlugin
from x_monitor.core.connectors.types import CmdResult, CollectResult, Command, Status
from x_monitor.core.settings.config_schema import PluginConfig
from x_monitor.plugins.base.plugin_helpers import level_for, limit_from


_TCP_STATES = {
    '01': 'ESTABLISHED',
    '02': 'SYN_SENT',
    '03': 'SYN_RECV',
    '04': 'FIN_WAIT1',
    '05': 'FIN_WAIT2',
    '06': 'TIME_WAIT',
    '07': 'CLOSE',
    '08': 'CLOSE_WAIT',
    '09': 'LAST_ACK',
    '0A': 'LISTEN',
    '0B': 'CLOSING',
}


def _parse_states(stdout: str) -> Counter:
    """Count the sockets in each TCP state across the /proc/net/tcp tables."""
    counts: Counter = Counter()
    for line in stdout.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        if fields[0].rstrip(':') == 'sl':
            continue
        state = _TCP_STATES.get(fields[3].upper())
        if state:
            counts[state] += 1
    return counts


class Connections(SignalPlugin):
    """TCP socket counts per state, read straight from /proc/net/tcp{,6} so no
    tooling is required on the target."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.warning = limit_from(config, 'warning', 500)


    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command("cat /proc/net/tcp /proc/net/tcp6 2>/dev/null")]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0:
            return CollectResult.unavailable(f"Failed to read /proc/net/tcp: {stderr}")

        counts = _parse_states(stdout)
        total = sum(counts.values())

        metrics = {f'conn_{state.lower()}': float(counts.get(state, 0))
                   for state in _TCP_STATES.values()}
        metrics['conn_total'] = float(total)

        status = level_for(total, self.warning, None)
        summary = ', '.join(f"{s}={counts[s]}" for s in sorted(counts)) or "no connections"
        return CollectResult(
            metrics=metrics,
            logs=[(f"{total} TCP connections ({summary})", Status(status).log_level)],
            status=status,
        )

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'conn_total_card': {'metric': 'conn_total', 'title': 'CONNECTIONS',
                                'format': 'int_rounded',
                                'color': {'warning': self.warning, 'threshold': None}},
            'conn_states_card': {'kind': 'share', 'title': 'BY STATE', 'format': 'int_rounded',
                                 'parts': [
                                     {'metric': 'conn_established', 'label': 'Established',
                                      'color': 'series-1'},
                                     {'metric': 'conn_listen', 'label': 'Listening',
                                      'color': 'series-2'},
                                     {'metric': 'conn_time_wait', 'label': 'Time wait',
                                      'color': 'series-3'},
                                 ]},
        }

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'conn_total_chart': {'title': 'CONNECTIONS BY STATE', 'style': 'stack', 'series': [
            {'metric': 'conn_established', 'label': 'Established'},
            {'metric': 'conn_listen', 'label': 'Listening'},
            {'metric': 'conn_time_wait', 'label': 'Time wait'},
        ]}}
