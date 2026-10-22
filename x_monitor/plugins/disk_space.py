"""Disk usage of one filesystem path, read with df over SSH — sampled locally
by the agent on agent-backed hosts. Config: path (default /), warning
(percent used, default off) and threshold (percent used, default 90), either
set to null to turn that level off. Usage at or above the warning is warning
and at or above the threshold is failed; a df or parse error is unavailable."""

from typing import Dict, Any, List
from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import CmdResult, Command, CollectResult

from x_monitor.plugins.base.plugin_helpers import format_bytes, level_for, limit_from, limits_text


_DEFAULT_LAYOUT = [
    ['host_card', 'path_card', 'threshold_card'],
    ['usage_card', 'avail_card', 'total_card'],
    ['chart'],
    ['events'],
]


class DiskSpace(Plugin):
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.path = config.get('path', '/')
        self.warning = limit_from(config, 'warning')
        self.threshold = limit_from(config, 'threshold', 90)

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command(f"df --output=size,used,avail,pcent -B1 '{self.path}' | tail -1")]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0:
            return CollectResult.unavailable(f"df failed for '{self.path}': {stderr}")

        try:
            fields = stdout.strip().split()
            size_bytes = int(fields[0])
            used_bytes = int(fields[1])
            avail_bytes = int(fields[2])
            used_pct = float(fields[3].rstrip('%'))
        except (IndexError, ValueError) as e:
            return CollectResult.unavailable(f"Failed to parse df output '{stdout.strip()}': {e}")

        size_gb  = size_bytes  / (1024 ** 3)
        used_gb  = used_bytes  / (1024 ** 3)
        avail_gb = avail_bytes / (1024 ** 3)

        metrics = {
            'used_pct': used_pct,
            'size_gb': size_gb,
            'used_gb': used_gb,
            'avail_gb': avail_gb,
        }

        status = level_for(used_pct, self.warning, self.threshold)
        return CollectResult(
            metrics=metrics,
            logs=[(
                f"{self.path}: {used_pct:.1f}% used "
                f"({format_bytes(used_gb)} of {format_bytes(size_gb)}, "
                f"{format_bytes(avail_gb)} free, {limits_text(self.warning, self.threshold, '%')})",
                'INFO' if status == 'online' else 'WARNING',
            )],
            status=status,
        )

    @property
    def _limits_label(self) -> str:
        """The limits card's text, such as 'warn 80% / fail 90%'."""
        return limits_text(self.warning, self.threshold, '%')

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'path_card': {'title': 'PATH', 'value_attr': 'path'},
                'threshold_card': {'title': 'LIMITS', 'value_attr': '_limits_label'},
                'usage_card': {
                    'kind': 'gauge', 'metric': 'used_pct', 'title': 'USAGE',
                    'format': 'percent1',
                    'color': {'warning': self.warning if self.warning is not None else self.threshold,
                              'threshold': self.threshold},
                },
                'avail_card': {'metric': 'avail_gb', 'title': 'AVAILABLE', 'format': 'bytes_gb'},
                'total_card': {'metric': 'size_gb', 'title': 'TOTAL SIZE', 'format': 'bytes_gb'},
            },
            'chart': {'metric': 'used_pct', 'title': f'USAGE HISTORY — {self.path} (%)'},
            'events': True,
        }

