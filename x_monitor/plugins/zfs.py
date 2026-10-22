"""ZFS pool state and capacity, via zpool."""

from typing import Any, Dict, List

from x_monitor.plugins.base.signal_plugin import SignalPlugin, worst_status as _worst
from x_monitor.core.connectors.types import CmdResult, CollectResult, Command, Status
from x_monitor.core.settings.config_schema import PluginConfig
from x_monitor.plugins.base.plugin_helpers import level_for


_UNHEALTHY = {'DEGRADED', 'FAULTED', 'OFFLINE', 'UNAVAIL', 'REMOVED'}


def _sanitize_pool(name: str) -> str:
    """A pool name reduced to the characters a metric name may carry."""
    return ''.join(c if c.isalnum() or c == '_' else '_' for c in name.lower())


def _pool_caption(item: Dict[str, Any]) -> str:
    """A pool tile's caption: its health word and how full it is."""
    return f"{item.get('health', '--')} · {item.get('usage') or 0.0:.0f}%"


class Zfs(SignalPlugin):
    """ZFS pool state and capacity from one `zpool list`, reporting a count of
    degraded pools plus a usage metric per pool and the fullest pool's usage,
    with each pool's health and usage kept in the snapshot for its tile.
    A zpool that fails to run or lists no pools measured nothing, so it is
    unavailable; a pool in any unhealthy state is failed."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.warning = float(config.get('warning', 80))
        self.threshold = float(config.get('threshold', 90))
        self.pools = list(config.get('pools') or [])

    def _item_level(self, item):
        """Color one pool's meter by its own capacity against this monitor's thresholds."""
        return level_for(item.get('value') or 0.0, self.warning, self.threshold)

    def _pool_state(self, item):
        """Color one pool's tile failed when it is unhealthy, otherwise by its capacity."""
        if item.get('health') in _UNHEALTHY:
            return 'failed'
        return level_for(item.get('usage') or 0.0, self.warning, self.threshold)

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command("zpool list -H -o name,health,capacity " + " ".join(self.pools) + " 2>&1")]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0 and not stdout.strip():
            return CollectResult.unavailable(f"zpool list failed: {stderr or stdout}")

        ok, degraded = 0, 0
        usage: Dict[str, float] = {}
        pools: List[Dict[str, Any]] = []
        logs, statuses = [], []
        for line in stdout.splitlines():
            parts = line.strip().split()
            if len(parts) != 3:
                continue
            pool, health, capacity = parts
            try:
                usage_pct = float(capacity.rstrip('%'))
            except ValueError:
                continue
            usage[pool] = usage_pct
            pools.append({'label': pool, 'health': health, 'usage': usage_pct})

            if health in _UNHEALTHY:
                degraded += 1
                status = 'failed'
            else:
                ok += 1
                status = level_for(usage_pct, self.warning, self.threshold)
            statuses.append(status)
            logs.append((
                f"Pool {pool}: {health}, {usage_pct:.0f}% used "
                f"(warn {self.warning:g}% / fail {self.threshold:g}%)",
                Status(status).log_level,
            ))

        if not usage:
            result = CollectResult.unavailable("No ZFS pools found")
            result.snapshot = []
            return result

        metrics = {
            'pools_total': ok + degraded,
            'pools_ok': ok,
            'pools_degraded': degraded,
            'zfs_usage_max': max(usage.values()),
        }
        for pool, usage_pct in usage.items():
            metrics[f'pool_usage_{_sanitize_pool(pool)}'] = usage_pct

        return CollectResult(metrics=metrics, logs=logs, status=_worst(statuses), snapshot=pools)

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'zfs_total_card': {'metric': 'pools_total', 'title': 'POOLS', 'format': 'int'},
            'zfs_degraded_card': {
                'kind': 'share', 'title': 'POOL HEALTH', 'format': 'int',
                'parts': [
                    {'metric': 'pools_ok', 'label': 'Healthy', 'color': 'online'},
                    {'metric': 'pools_degraded', 'label': 'Degraded', 'color': 'failed'},
                ],
            },
            'zfs_pool_tiles': {
                'title': 'POOL STATE',
                'repeat': {
                    'source': 'snapshot',
                    'container': 'tiles',
                    'item_format_fn': _pool_caption,
                    'item_color_by': self._pool_state,
                    'empty_text': 'No ZFS pools found',
                },
            },
            'zfs_pools': {
                'title': 'POOL CAPACITY',
                'repeat': {
                    'source': 'metrics_prefix',
                    'metrics_prefix': 'pool_usage_', 'metrics_suffix': '',
                    'item_format': 'percent1',
                    'item_color_by': self._item_level,
                    'label_transform': 'spaces_upper',
                    'container': 'bars',
                    'bar_marker': self.warning,
                    'empty_text': 'No ZFS pools found',
                },
            },
        }

    def card_row(self) -> List[str]:
        return ['zfs_total_card', 'zfs_degraded_card']

    def rows(self) -> List[List[str]]:
        return [['zfs_pool_tiles'], ['zfs_pools']]

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'zfs_chart': {'metric': 'zfs_usage_max', 'title': 'FULLEST POOL CAPACITY (%)'}}
