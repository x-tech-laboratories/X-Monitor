"""Run the real dashboard on a homelab-shaped fleet fed with moving sample readings.

The engine schedules every monitor as usual, but a cycle applies a sample reading for the
monitor's type instead of collecting, so every widget has live data and nothing leaves the
machine. Groups still fold their children's statuses the real way. A type with no sample here
reports unavailable.

    python dev/demo/sample.py --config <rendered sample.yaml> --db <path> --port <port>
"""

import argparse
import json
import logging
import math
import random
import time
from typing import Any, Callable, Dict, Tuple

from x_monitor.core.connectors.types import CmdResult, CollectResult
from x_monitor.core.coordination.engine import XMonitorEngine
from x_monitor.core.ui import theme
from x_monitor.core.ui.main_dashboard import init_gui
from x_monitor.plugins.base.plugin_helpers import SCRIPT_SEP, level_for
from x_monitor.plugins.processes import _process_tree

# ============================================================================
# Sample readings
# ============================================================================

# Metrics and a status, and for a monitor whose tiles read one, its snapshot list.
Reading = Tuple[Any, ...]


def wave(tick: int, seed: int, base: float, swing: float, noise: float = 0.0) -> float:
    """A slow sine around `base`, offset per monitor so no two lines move together, plus jitter."""
    jitter = random.Random(seed * 7919 + tick).uniform(-noise, noise)
    return max(0.0, base + swing * math.sin((tick + seed * 5) / 6) + jitter)


def thresholds(plugin: Any, value: float) -> str:
    """The monitor's own warning/threshold verdict on a value, or online when it has none."""
    warning, threshold = getattr(plugin, 'warning', None), getattr(plugin, 'threshold', None)
    if warning is None or threshold is None:
        return 'online'
    return level_for(value, warning, threshold)


def down_now(tick: int, seed: int, period: int = 37, length: int = 3) -> bool:
    """Whether a flaky monitor is in one of its short, regular outages."""
    return (tick + seed * 11) % period < length


def cpu(plugin, tick, seed) -> Reading:
    """Usage drifting around a quarter, judged by the monitor's own thresholds, with eight cores spread around it."""
    cores = [wave(tick, seed + core, 28 + (40 if core == 3 else 0), 14, 6) for core in range(8)]
    value = sum(cores) / len(cores)
    return ({'cpu_pct': value, 'cpu_core_max_pct': max(cores)}, thresholds(plugin, value),
            [{'label': str(core), 'value': min(pct, 100.0)} for core, pct in enumerate(cores)])


def memory(plugin, tick, seed) -> Reading:
    """A 32 GB machine a little over half full."""
    value = wave(tick, seed, 58, 4, 1)
    return {'memory_pct': value, 'memory_used_gb': 32 * value / 100, 'memory_total_gb': 32.0}, thresholds(plugin, value)


def load(plugin, tick, seed) -> Reading:
    """One-minute load swinging over a steadier five- and fifteen-minute average."""
    one = wave(tick, seed, 40, 15, 6)
    return ({'load_pct_1m': one, 'load_pct_5m': wave(tick, seed, 37, 6, 2),
             'load_pct_15m': wave(tick, seed, 35, 2, 1)}, thresholds(plugin, one))


def temperature(plugin, tick, seed) -> Reading:
    """Four thermal zones, the hottest of them the reading."""
    zones = {'cpu': wave(tick, seed, 58, 6, 2), 'nvme': wave(tick, seed, 42, 2, 1),
             'acpitz': 36.0, 'gpu': wave(tick, seed + 3, 70, 8, 2)}
    hottest = max(zones.values())
    return {'temp_c': hottest, **{f'temp_zone_{name}': value for name, value in zones.items()}}, thresholds(plugin, hottest)


def throughput(plugin, tick, seed) -> Reading:
    """Download well above upload, both wandering."""
    return {'rx_kbps': wave(tick, seed, 2400, 1500, 600), 'tx_kbps': wave(tick, seed, 600, 300, 150)}, 'online'


def processes(plugin, tick, seed) -> Reading:
    """A small process tree whose busiest branch, a browser's content processes, wanders."""
    def proc(pid, ppid, user, cpu, mem, command):
        return {'pid': pid, 'ppid': ppid, 'user': user, 'cpu': round(cpu, 1), 'mem': mem, 'command': command}
    flat = [
        proc(1, 0, 'root', 0.2, 0.1, 'systemd'),
        proc(412, 1, 'root', 0.0, 0.3, 'sshd'),
        proc(5120, 412, 'alice', 0.1, 0.1, 'bash'),
        proc(5188, 5120, 'alice', wave(tick, seed, 3, 2, 1), 0.2, 'htop'),
        proc(880, 1, 'root', wave(tick, seed, 4, 2, 1), 1.4, 'nginx'),
        proc(881, 880, 'nginx', wave(tick, seed + 1, 2, 1, 0.5), 0.6, 'nginx'),
        proc(882, 880, 'nginx', wave(tick, seed + 2, 2, 1, 0.5), 0.6, 'nginx'),
        proc(1500, 1, 'alice', wave(tick, seed, 6, 3, 1), 4.2, 'firefox'),
        proc(1544, 1500, 'alice', wave(tick, seed + 3, 30, 25, 5), 3.1, 'Isolated Web Co'),
        proc(1560, 1500, 'alice', wave(tick, seed + 4, 8, 6, 2), 2.4, 'Isolated Web Co'),
        proc(1571, 1500, 'alice', 0.3, 0.9, 'RDD Process'),
        proc(2, 0, 'root', 0.0, 0.0, 'kthreadd'),
        proc(14, 2, 'root', wave(tick, seed, 1, 1, 0.3), 0.0, 'ksoftirqd/0'),
    ]
    top = max(p['cpu'] for p in flat)
    return ({'process_count': float(len(flat)), 'top_cpu_pct': top}, level_for(top, plugin.cpu_warning, plugin.cpu_threshold),
            _process_tree(flat, plugin.max_processes))


def connections(plugin, tick, seed) -> Reading:
    """Established and time-wait connections over a fixed set of listeners."""
    established, time_wait = wave(tick, seed, 140, 25, 8), wave(tick, seed, 60, 18, 8)
    total = established + time_wait + 38
    return ({'conn_total': total, 'conn_established': established, 'conn_listen': 38.0,
             'conn_time_wait': time_wait}, thresholds(plugin, total))


def disk_io(plugin, tick, seed) -> Reading:
    """Reads ahead of writes, both wandering."""
    return {'read_kbps': wave(tick, seed, 1200, 800, 300), 'write_kbps': wave(tick, seed, 340, 150, 80)}, 'online'


def disk_space(plugin, tick, seed) -> Reading:
    """A filesystem filled to a level fixed per monitor."""
    used = wave(tick, seed, 45 + seed % 40, 2, 0.5)
    return {'used_pct': used, 'size_gb': 1800.0, 'avail_gb': 1800 * (1 - used / 100)}, thresholds(plugin, used)


def filesystems(plugin, tick, seed) -> Reading:
    """Three mounts, the data one hovering around its warning level."""
    used = {'root': 41.0, 'storage': wave(tick, seed, 84, 5, 1), 'boot': 33.0}
    metrics = {f'fs_{key}_used_pct': value for key, value in used.items()}
    metrics.update({f'fs_{key}_inodes_pct': 4.0 for key in used})
    return metrics, thresholds(plugin, max(used.values()))


def zfs(plugin, tick, seed) -> Reading:
    """Two healthy pools, one of them nearly full."""
    usage = {'storage': wave(tick, seed, 79, 4, 1), 'backup': 42.0}
    pools = [{'label': name, 'health': 'ONLINE', 'usage': value} for name, value in usage.items()]
    return ({'pools_total': 2.0, 'pools_ok': 2.0, 'pools_degraded': 0.0, 'zfs_usage_max': max(usage.values()),
             **{f'pool_usage_{name}': value for name, value in usage.items()}},
            thresholds(plugin, max(usage.values())), pools)


def smart(plugin, tick, seed) -> Reading:
    """Three disks, all passing."""
    disks = [{'label': name, 'health': 'PASSED', 'temperature': wave(tick, seed + index, temp, 2, 1),
              'power_on_hours': hours + tick / 720}
             for index, (name, temp, hours) in enumerate([('sda', 36, 21402), ('sdb', 37, 21398), ('nvme0n1', 41, 8120)])]
    return {'disks_total': 3.0, 'disks_ok': 3.0, 'disks_failed': 0.0, 'disks_unknown': 0.0}, 'online', disks


def uptime(plugin, tick, seed) -> Reading:
    """A host that drops out for a few checks now and then."""
    up = not down_now(tick, seed)
    return {'up': 1.0 if up else 0.0, 'latency_ms': wave(tick, seed, 21, 5, 3)}, 'online' if up else 'failed'


def http(plugin, tick, seed) -> Reading:
    """An endpoint that fails a check now and then, less often than a host."""
    up = not down_now(tick, seed, period=53)
    return {'probe_ok': 1.0 if up else 0.0, 'probe_latency_ms': wave(tick, seed, 60, 15, 8)}, 'online' if up else 'failed'


def ports(plugin, tick, seed) -> Reading:
    """Every configured check, each with its own short outages."""
    metrics, down = {}, 0
    for index, check in enumerate(plugin.checks):
        up = not down_now(tick, seed + index, period=61, length=2)
        down += not up
        metrics[f"{check['metric']}_up"] = 1.0 if up else 0.0
        metrics[f"{check['metric']}_latency_ms"] = wave(tick, seed + index, 40, 8, 4)
    return metrics, 'failed' if down else 'online'


def pihole(plugin, tick, seed) -> Reading:
    """Steadily growing query counts with a block rate near a fifth."""
    return ({'block_rate_pct': wave(tick, seed, 18, 3, 1), 'queries_blocked': 7750.0 + 4 * tick,
             'queries_forwarded': 28842.0 + 15 * tick, 'queries_cached': 5526.0 + 3 * tick,
             'clients_active': 14.0, 'blocking_enabled': 1.0}, 'online')


def unbound(plugin, tick, seed) -> Reading:
    """A resolver with a high cache hit rate and almost no SERVFAILs."""
    return ({'resolved_ok': 1.0, 'servfail_rate_pct': wave(tick, seed, 0.4, 0.3, 0.1),
             'queries_total': 120000.0 + 30 * tick, 'cache_hit_rate_pct': wave(tick, seed, 87, 3, 1),
             'uptime_seconds': 530000.0 + 5 * tick}, 'online')


def containers(plugin, tick, seed) -> Reading:
    """Four containers, one of which stops and starts again, and one whose image has an update."""
    stopped = (tick // 20) % 2
    rows = [{'name': 'nginx', 'state': 'running', 'image': 'nginx:latest',
             'update': 'Update available', 'update_state': 'available'},
            {'name': 'postgres', 'state': 'exited' if stopped else 'running', 'image': 'postgres:16',
             'update': 'Up to date', 'update_state': 'current'},
            {'name': 'redis', 'state': 'running', 'image': 'redis:7', 'update': 'Up to date', 'update_state': 'current'},
            {'name': 'app', 'state': 'running', 'image': 'app:dev', 'update': 'Local image', 'update_state': 'local'}]
    return ({'containers_total': 4.0, 'containers_running': 4.0 - stopped, 'containers_stopped': float(stopped),
             'images_update_available': 1.0},
            'warning' if stopped else 'online', rows)


def parsed(plugin, *outputs: str) -> CollectResult:
    """The monitor's own parse of canned command output, one string per command it runs."""
    return plugin.parse([CmdResult(0, output, '') for output in outputs])


def package_updates(plugin, tick, seed) -> CollectResult:
    """An apt host with two pending updates, one of them a security fix."""
    updates = ('Listing... Done\n'
               'bash/stable 5.2.15-2+b7 amd64 [upgradable from: 5.2.15-2+b2]\n'
               'openssl/stable-security 3.0.14-1~deb12u2 amd64 [upgradable from: 3.0.13-1~deb12u1]\n')
    return parsed(plugin, f"manager=apt\nsource=\nrc=0\n{SCRIPT_SEP}\n{updates}\n{SCRIPT_SEP}\n\n{SCRIPT_SEP}\n\n")


def reboot_required(plugin, tick, seed) -> CollectResult:
    """A Debian host whose kernel and libc were upgraded since boot."""
    return parsed(plugin, "kernel=6.1.0-25-amd64\ndebian=1\ndebian_flag=1\n"
                          "debian_pkg=linux-image-6.1.0-26-amd64\ndebian_pkg=libc6\nmodules=present\n")


def interfaces(plugin, tick, seed) -> CollectResult:
    """Loopback, a wired link with addresses and a docker bridge."""
    def link(name, mac, addrs, operstate='UP', link_type='ether'):
        return {'ifname': name, 'flags': ['BROADCAST', 'UP', 'LOWER_UP'], 'mtu': 1500, 'operstate': operstate,
                'link_type': link_type, 'address': mac, 'addr_info': addrs}
    links = [link('lo', '00:00:00:00:00:00', [{'family': 'inet', 'local': '127.0.0.1', 'prefixlen': 8}],
                  'UNKNOWN', 'loopback'),
             link('eth0', '52:54:00:00:00:01', [{'family': 'inet', 'local': '192.0.2.10', 'prefixlen': 24},
                                                {'family': 'inet6', 'local': 'fe80::1', 'prefixlen': 64}]),
             link('docker0', '02:42:00:00:00:01', [{'family': 'inet', 'local': '172.17.0.1', 'prefixlen': 16}])]
    sysfs = ['lo\tunknown\t1\t65536\t00:00:00:00:00:00\t\t772',
             'eth0\tup\t1\t1500\t52:54:00:00:00:01\t1000\t1',
             'docker0\tup\t1\t1500\t02:42:00:00:00:01\t\t1']
    return parsed(plugin, f"{json.dumps(links)}\n{SCRIPT_SEP}\n\n{SCRIPT_SEP}\n" + "\n".join(sysfs) + "\n")


def sessions(plugin, tick, seed) -> CollectResult:
    """One local desktop session and one SSH session, with a few recent logins."""
    def block(sid, user, host='', tty='pts/0', seat='', kind='tty', service='sshd'):
        return (f"Id={sid}\nName={user}\nTimestamp=Thu 2026-09-24 10:00:00 UTC\nSeat={seat}\nTTY={tty}\n"
                f"Remote={'yes' if host else 'no'}\nRemoteHost={host}\nRemoteUser=\nService={service}\n"
                f"Type={kind}\nClass=user\nState=active\nIdleHint=no\nIdleSinceHint=0\n")
    current = block('2', 'alice', tty='', seat='seat0', kind='wayland', service='gdm-password') + block('4', 'alice', '192.0.2.5')
    last = ('alice    pts/0        192.0.2.5        2026-09-24T10:00:00+00:00   still logged in\n'
            'bob      tty1         0.0.0.0          2026-09-23T08:00:00+00:00 - 2026-09-23T17:00:00+00:00  (09:00)\n')
    return parsed(plugin, f"source=loginctl\n{SCRIPT_SEP}\n{current}{SCRIPT_SEP}\n{last}")


def host_control(plugin, tick, seed) -> CollectResult:
    """A host with power-profiles-daemon and suspend support."""
    power = ('backend=ppd\n  performance:\n    CpuDriver:\tintel_pstate\n* balanced:\n'
             '    CpuDriver:\tintel_pstate\n  power-saver:\n    CpuDriver:\tintel_pstate\n')
    return parsed(plugin, power, 'freeze mem disk')


def syncthing(plugin, tick, seed) -> Reading:
    """Three folders, one of which pulls a batch of changes now and then, which reads as info."""
    percent = (tick + seed) % 30 * 10
    syncing = percent < 100
    folders = [{'id': 'docs', 'label': 'Documents', 'state': 'idle', 'caption': 'up to date', 'status': 'online'},
               {'id': 'photos', 'label': 'Photos', 'state': 'syncing' if syncing else 'idle',
                'caption': f'syncing {percent}%' if syncing else 'up to date',
                'status': 'info' if syncing else 'online'},
               {'id': 'music', 'label': 'Music', 'state': 'idle', 'caption': 'up to date', 'status': 'online'}]
    need = (100 - percent) * 4e6 if syncing else 0.0
    return ({'folders_total': 3.0, 'folders_errored': 0.0, 'folders_stalled': 0.0, 'need_bytes': need,
             'pull_errors': 0.0, 'devices_expected': 2.0, 'devices_disconnected': 0.0},
            'info' if syncing else 'online', folders)


def borg(plugin, tick, seed) -> Reading:
    """A repository backed up recently, or for one in five, missed past its max age."""
    # One repository in five has missed its window, so the backups panel shows a late one.
    late = seed % 5 == 0
    age = plugin.max_age * (1.4 if late else 0.25 + (seed % 3) * 0.15)
    return ({'last_backup_epoch': time.time() - age, 'archive_count': 30.0 + seed % 20,
             'deduplicated_size': 400.0 + seed * 10, 'dedup_ratio': 2.4}, 'failed' if late else 'online')


def nixos_upgrade(plugin, tick, seed) -> Reading:
    """A deployment that is in sync, drifting or waiting on a reboot."""
    drifting, reboot = seed % 4 == 1, seed % 4 == 2
    return ({'generation': 800.0 + seed * 3, 'up_to_date': 0.0 if drifting else 1.0,
             'reboot_required': 1.0 if reboot else 0.0, 'last_switch_epoch': time.time() - 86400 * (seed % 6)},
            'warning' if drifting or reboot else 'online')


def vuln_scan(plugin, tick, seed) -> Reading:
    """A scan with a few noted findings and, on some hosts, worse."""
    vulnerable, suspected, noted = float(seed % 3 == 0), float(seed % 3), float(2 + seed % 8)
    status = 'failed' if vulnerable else 'warning' if suspected else 'online'
    return {'vulnerable': vulnerable, 'suspected': suspected, 'noted': noted, 'open_ports': 3.0 + seed % 12}, status


SAMPLES: Dict[str, Callable[[Any, int, int], Any]] = {
    'cpu': cpu, 'memory': memory, 'load': load, 'temperature': temperature,
    'throughput': throughput, 'connections': connections, 'processes': processes, 'disk_io': disk_io,
    'disk_space': disk_space, 'filesystems': filesystems, 'zfs': zfs, 'smart': smart,
    'uptime': uptime, 'http': http, 'ports': ports, 'pihole': pihole, 'unbound': unbound,
    'containers': containers, 'syncthing': syncthing, 'borg': borg, 'nixos_upgrade': nixos_upgrade, 'vuln_scan': vuln_scan,
}

# Types whose sample runs the monitor's own parser on canned output, so each needs a real plugin.
PARSED_SAMPLES: Dict[str, Callable[[Any, int, int], CollectResult]] = {
    'package_updates': package_updates, 'reboot_required': reboot_required, 'interfaces': interfaces,
    'sessions': sessions, 'host_control': host_control,
}
SAMPLES.update(PARSED_SAMPLES)


# ============================================================================
# The engine that applies them
# ============================================================================

class SampleEngine(XMonitorEngine):
    """The real engine, except that a monitor's cycle applies a sample reading instead of collecting."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._ticks: Dict[str, int] = {}

    async def _run_cycle(self, plugin) -> bool:
        kind = plugin.config.get('type')
        if kind == 'group':
            return await super()._run_cycle(plugin)
        tick = self._ticks.get(plugin.id, 0)
        self._ticks[plugin.id] = tick + 1
        sample = SAMPLES.get(kind)
        if sample is None:
            self._apply(plugin, CollectResult(status='unavailable'))
            return True
        seed = sum(map(ord, plugin.id))
        reading = sample(plugin, tick, seed)
        if isinstance(reading, CollectResult):
            self._apply(plugin, reading)
            return True
        metrics, status, *snapshot = reading
        self._apply(plugin, CollectResult(metrics=metrics, status=status,
                                          snapshot=snapshot[0] if snapshot else None))
        return True


def main():
    """Parse the command line and start the dashboard on the sample engine."""
    parser = argparse.ArgumentParser(description="X-Monitor sample-data demo")
    parser.add_argument("--config", required=True)
    parser.add_argument("--db")
    parser.add_argument("--port", type=int, default=8099)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    engine = SampleEngine(args.config, db_path_override=args.db)
    engine.setup_modules()
    theme.configure(engine.config_loader.theme_settings)
    init_gui(engine=engine, port=args.port)


if __name__ in {"__main__", "__mp_main__"}:
    main()
