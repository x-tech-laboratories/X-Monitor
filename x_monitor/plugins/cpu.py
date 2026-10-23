"""CPU utilization, overall and per core, sampled from /proc/stat and ranked
against warning/threshold; a sample that could not be read or parsed is
unavailable."""

from typing import Any, Dict, List, Tuple

from x_monitor.plugins.base.signal_plugin import SignalPlugin, worst_status
from x_monitor.core.connectors.types import CmdResult, CollectResult, Command, Status
from x_monitor.core.settings.config_schema import PluginConfig
from x_monitor.plugins.base.plugin_helpers import level_for, limit_from, limits_text


def _parse_cpu_line(line: str) -> Tuple[int, int]:
    parts = line.split()
    user, nice, system, idle = int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4])
    iowait  = int(parts[5]) if len(parts) > 5 else 0
    irq     = int(parts[6]) if len(parts) > 6 else 0
    softirq = int(parts[7]) if len(parts) > 7 else 0
    steal   = int(parts[8]) if len(parts) > 8 else 0
    total   = user + nice + system + idle + iowait + irq + softirq + steal
    return total, idle + iowait


def _cpu_pct(line1: str, line2: str) -> float:
    total1, idle1 = _parse_cpu_line(line1)
    total2, idle2 = _parse_cpu_line(line2)
    delta_total = total2 - total1
    delta_idle  = idle2  - idle1
    if delta_total <= 0:
        return 0.0
    return max(0.0, min(100.0, 100.0 * (1.0 - delta_idle / delta_total)))


def _split_samples(stdout: str) -> List[Dict[str, str]]:
    """Split the output into /proc/stat samples, each mapping 'cpu' or 'cpu<n>' to its line."""
    samples: List[Dict[str, str]] = []
    for line in stdout.splitlines():
        name = line.split(maxsplit=1)[0] if line.strip() else ''
        if not name.startswith('cpu'):
            continue
        if name == 'cpu':
            samples.append({})
        if samples:
            samples[-1][name] = line
    return samples


def _core_pcts(first: Dict[str, str], second: Dict[str, str]) -> Dict[int, float]:
    """Utilization of every core present in both samples, keyed by core number; a core that went offline between them is skipped."""
    cores: Dict[int, float] = {}
    for name, line in second.items():
        index = name[3:]
        if not index.isdigit() or name not in first:
            continue
        try:
            cores[int(index)] = _cpu_pct(first[name], line)
        except (ValueError, IndexError):
            continue
    return dict(sorted(cores.items()))


class Cpu(SignalPlugin):
    """CPU utilization from two /proc/stat samples a second apart, taken on
    the target so the sleep costs one round trip rather than two. The same
    two samples give every core's utilization, shown as bars from a snapshot;
    per-core history metrics are opt-in because they cost one row per core per cycle."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.warning   = limit_from(config, 'warning',   70)
        self.threshold = limit_from(config, 'threshold', 85)
        self.per_core_metrics = bool(config.get('per_core_metrics', False))
        self.core_warning   = limit_from(config, 'core_warning')
        self.core_threshold = limit_from(config, 'core_threshold')

    def _core_rule_enabled(self) -> bool:
        """Whether either per-core limit is set, so the busiest core is ranked on its own."""
        return self.core_warning is not None or self.core_threshold is not None

    def _core_level(self, item) -> str:
        """Color one core's bar by the per-core thresholds when set, else the overall ones."""
        value = item.get('value') or 0.0
        if self._core_rule_enabled():
            return level_for(value, self.core_warning, self.core_threshold)
        return level_for(value, self.warning, self.threshold)

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command("{ grep '^cpu' /proc/stat; sleep 1; grep '^cpu' /proc/stat; }")]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0:
            return CollectResult.unavailable(f"CPU collection failed: {stderr}")

        samples = _split_samples(stdout)
        if len(samples) < 2:
            return CollectResult.unavailable(f"Incomplete CPU output: {stdout!r}")

        try:
            cpu_pct = _cpu_pct(samples[0]['cpu'], samples[1]['cpu'])
        except (ValueError, IndexError) as e:
            return CollectResult.unavailable(f"Failed to parse CPU output: {e}")

        cores = _core_pcts(samples[0], samples[1])
        metrics = {'cpu_pct': cpu_pct}
        levels = [level_for(cpu_pct, self.warning, self.threshold)]
        busiest = ''
        if cores:
            busiest_core = max(cores, key=lambda n: cores[n])
            core_max = cores[busiest_core]
            metrics['cpu_core_max_pct'] = core_max
            busiest = f", busiest core {busiest_core} at {core_max:.0f}%"
            if self._core_rule_enabled():
                levels.append(level_for(core_max, self.core_warning, self.core_threshold))
            if self.per_core_metrics:
                for index, pct in cores.items():
                    metrics[f'cpu{index}_pct'] = pct

        status = worst_status(levels)
        return CollectResult(
            metrics=metrics,
            logs=[(
                f"CPU {cpu_pct:.1f}% ({limits_text(self.warning, self.threshold, '%')})"
                f"{busiest}",
                Status(status).log_level,
            )],
            status=status,
            snapshot=[{'label': str(index), 'value': pct} for index, pct in cores.items()],
        )

    def cards(self) -> Dict[str, Dict[str, Any]]:
        core_marker = self.core_warning if self._core_rule_enabled() else self.warning
        return {
            'cpu_card': {'kind': 'gauge', 'metric': 'cpu_pct', 'title': 'CPU',
                         'format': 'percent1',
                         'color': {'warning': self.warning,
                                   'threshold': self.threshold}},
            'cores': {
                'title': 'CORES',
                'repeat': {
                    'source': 'snapshot',
                    'container': 'bars',
                    'bar_marker': core_marker,
                    'item_format': 'percent0',
                    'item_color_by': self._core_level,
                    'empty_text': 'No per-core data yet',
                },
            },
        }

    def card_row(self) -> List[str]:
        return ['cpu_card']

    def rows(self) -> List[List[str]]:
        return [['cores']]

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'cpu_chart': {'metric': 'cpu_pct', 'title': 'CPU USAGE (%)'}}
