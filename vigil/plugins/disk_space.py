"""Disk usage of one filesystem path, read with df over SSH — sampled locally
by the agent on agent-backed hosts. Config: path (default /) and threshold
(percent used, default 90). Usage at or above the threshold is failed; a df
or parse error is unavailable. This monitor has no separate warning tier."""

from typing import Dict, Any, List
from vigil.plugins.base.plugin_base import Plugin
from vigil.core.connectors.types import CmdResult, Command, CollectResult

from vigil.plugins.base.plugin_helpers import format_bytes
from vigil.plugins.base.disk_usage import df_command, parse_df

_COLUMNS = ('size', 'used', 'avail', 'pcent')

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
        self.threshold = int(config.get('threshold', 90))


    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command(f"{df_command(_COLUMNS, path=self.path, byte_blocks=True)} | tail -1")]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0:
            return CollectResult.unavailable(f"df failed for '{self.path}': {stderr}")

        rows = parse_df(stdout, _COLUMNS, header=False)
        if not rows:
            return CollectResult.unavailable(f"Failed to parse df output '{stdout.strip()}'")
        row = rows[0]
        used_pct = row['pcent']

        size_gb  = row['size']  / (1024 ** 3)
        used_gb  = row['used']  / (1024 ** 3)
        avail_gb = row['avail'] / (1024 ** 3)

        metrics = {
            'used_pct': used_pct,
            'size_gb': size_gb,
            'used_gb': used_gb,
            'avail_gb': avail_gb,
        }

        level = 'WARNING' if used_pct >= self.threshold else 'INFO'
        return CollectResult(
            metrics=metrics,
            logs=[(
                f"{self.path}: {used_pct:.1f}% used "
                f"({format_bytes(used_gb)} of {format_bytes(size_gb)}, "
                f"{format_bytes(avail_gb)} free, threshold {self.threshold}%)",
                level,
            )],
            status='failed' if used_pct >= self.threshold else 'online',
        )

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'path_card': {'title': 'PATH', 'value_attr': 'path'},
                'threshold_card': {'title': 'THRESHOLD', 'value_attr': 'threshold', 'value_format': '{}%'},
                'usage_card': {
                    'metric': 'used_pct', 'title': 'USAGE',
                    'format': 'percent1',
                    'color': {'warning': self.threshold, 'threshold': self.threshold},
                },
                'avail_card': {'metric': 'avail_gb', 'title': 'AVAILABLE', 'format': 'bytes_gb'},
                'total_card': {'metric': 'size_gb', 'title': 'TOTAL SIZE', 'format': 'bytes_gb'},
            },
            'chart': {'metric': 'used_pct', 'title': f'USAGE HISTORY — {self.path} (%)'},
            'events': True,
        }

