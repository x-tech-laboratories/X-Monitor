"""Network interface inventory: every interface's operstate, carrier, MAC,
MTU, speed and IPv4/IPv6 addresses, from `ip -j addr` and /sys/class/net
(falling back to plain `ip addr` when ip has no JSON output). An interface
listed in expect_up that is missing, down or without carrier is failed; one
whose addresses changed since the previous cycle (a new DHCP lease, a new
IPv6 prefix) is warning for that cycle and logs the old and new addresses.
Temporary IPv6 privacy addresses rotate by design and are left out of that
comparison. Config: include, exclude, include_loopback, expect_up."""

import json
import re
from fnmatch import fnmatch
from typing import Any, Dict, FrozenSet, List, Optional

from x_monitor.plugins.base.signal_plugin import SignalPlugin
from x_monitor.core.connectors.types import CmdResult, CollectResult, Command, Status
from x_monitor.core.settings.config_schema import PluginConfig
from x_monitor.plugins.base.plugin_helpers import SCRIPT_SEP, StatusAccumulator

# The kernel's ARPHRD_LOOPBACK link type, as /sys/class/net/<if>/type reports it.
_LOOPBACK_TYPE = '772'

_TEXT_LINK_RE = re.compile(r'^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>(.*)$')
_TEXT_ADDR_RE = re.compile(r'^\s+(inet6?)\s+(\S+)(.*)$')
_TEXT_MAC_RE = re.compile(r'^\s+link/(\S+)\s+(\S+)')


def _probe_script() -> str:
    """One script printing `ip -j addr`, plain `ip addr` when JSON is unsupported, and each interface's sysfs facts."""
    return '\n'.join([
        'j=$(ip -j addr show 2>/dev/null) || j=""',
        'case "$j" in "["*) ;; *) j="" ;; esac',
        "printf '%s\\n' \"$j\"",
        f'echo "{SCRIPT_SEP}"',
        'if [ -z "$j" ]; then ip addr show 2>/dev/null; fi',
        f'echo "{SCRIPT_SEP}"',
        'for d in /sys/class/net/*; do',
        '  [ -e "$d" ] || continue',
        "  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"${d##*/}\" "
        '"$(cat "$d/operstate" 2>/dev/null)" "$(cat "$d/carrier" 2>/dev/null)" '
        '"$(cat "$d/mtu" 2>/dev/null)" "$(cat "$d/address" 2>/dev/null)" '
        '"$(cat "$d/speed" 2>/dev/null)" "$(cat "$d/type" 2>/dev/null)"',
        'done',
    ])


def _int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _blank(name: str) -> Dict[str, Any]:
    return {'name': name, 'state': 'unknown', 'carrier': None, 'mac': '', 'mtu': None,
            'speed': None, 'loopback': False, 'ipv4': [], 'ipv6': [], 'ipv6_temporary': []}


def _parse_sysfs(text: str) -> Dict[str, Dict[str, Any]]:
    """One interface per tab-separated sysfs line: name, operstate, carrier, mtu, address, speed, type."""
    interfaces: Dict[str, Dict[str, Any]] = {}
    for line in text.splitlines():
        fields = line.split('\t')
        if len(fields) < 7 or not fields[0]:
            continue
        name, state, carrier, mtu, mac, speed, link_type = fields[:7]
        iface = _blank(name)
        iface['state'] = state.strip().lower() or 'unknown'
        iface['carrier'] = {'1': True, '0': False}.get(carrier.strip())
        iface['mtu'] = _int(mtu)
        iface['mac'] = mac.strip()
        speed_value = _int(speed)
        iface['speed'] = speed_value if speed_value is not None and speed_value > 0 else None
        iface['loopback'] = link_type.strip() == _LOOPBACK_TYPE
        interfaces[name] = iface
    return interfaces


def _add_address(iface: Dict[str, Any], family: str, address: str, temporary: bool) -> None:
    if family == 'inet':
        iface['ipv4'].append(address)
    elif temporary:
        iface['ipv6_temporary'].append(address)
    else:
        iface['ipv6'].append(address)


def _parse_ip_json(text: str) -> Dict[str, Dict[str, Any]]:
    """Interfaces from `ip -j addr show`."""
    try:
        links = json.loads(text)
    except ValueError:
        return {}
    interfaces: Dict[str, Dict[str, Any]] = {}
    for link in links if isinstance(links, list) else []:
        name = link.get('ifname')
        if not name:
            continue
        iface = _blank(name)
        flags = link.get('flags') or []
        iface['state'] = str(link.get('operstate') or 'unknown').lower()
        iface['carrier'] = 'LOWER_UP' in flags
        iface['mtu'] = _int(link.get('mtu'))
        iface['mac'] = link.get('address') or ''
        iface['loopback'] = link.get('link_type') == 'loopback' or 'LOOPBACK' in flags
        for info in link.get('addr_info') or []:
            local, prefix = info.get('local'), info.get('prefixlen')
            if not local:
                continue
            address = f'{local}/{prefix}' if prefix is not None else local
            _add_address(iface, info.get('family', ''), address, bool(info.get('temporary')))
        interfaces[name] = iface
    return interfaces


def _parse_ip_text(text: str) -> Dict[str, Dict[str, Any]]:
    """Interfaces from plain `ip addr show`, for an ip without JSON output."""
    interfaces: Dict[str, Dict[str, Any]] = {}
    current: Optional[Dict[str, Any]] = None
    for line in text.splitlines():
        m = _TEXT_LINK_RE.match(line)
        if m:
            name, flags, rest = m.group(1), m.group(2).split(','), m.group(3)
            current = interfaces[name] = _blank(name)
            state = re.search(r'\bstate (\S+)', rest)
            mtu = re.search(r'\bmtu (\d+)', rest)
            current['state'] = state.group(1).lower() if state else 'unknown'
            current['mtu'] = _int(mtu.group(1)) if mtu else None
            current['carrier'] = 'LOWER_UP' in flags
            current['loopback'] = 'LOOPBACK' in flags
            continue
        if current is None:
            continue
        m = _TEXT_ADDR_RE.match(line)
        if m:
            _add_address(current, m.group(1), m.group(2), 'temporary' in m.group(3).split())
            continue
        m = _TEXT_MAC_RE.match(line)
        if m and m.group(1) != 'none':
            current['mac'] = m.group(2)
    return interfaces


def _merge(sysfs: Dict[str, Dict[str, Any]], ip: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """sysfs's state, carrier and speed with ip's addresses, over the union of both lists."""
    merged: Dict[str, Dict[str, Any]] = {}
    for name in list(sysfs) + [n for n in ip if n not in sysfs]:
        base = dict(sysfs.get(name) or ip[name])
        extra = ip.get(name)
        if extra is not None:
            for key in ('ipv4', 'ipv6', 'ipv6_temporary'):
                base[key] = extra[key]
            base['mac'] = base['mac'] or extra['mac']
            base['mtu'] = base['mtu'] if base['mtu'] is not None else extra['mtu']
            base['loopback'] = base['loopback'] or extra['loopback']
            if base['carrier'] is None:
                base['carrier'] = extra['carrier']
        merged[name] = base
    return merged


def is_up(iface: Dict[str, Any]) -> bool:
    """Up and passing traffic: operstate up, or unknown (tunnels, loopback) with a carrier."""
    return iface['state'] == 'up' or (iface['state'] == 'unknown' and iface['carrier'] is True)


def _address_set(iface: Dict[str, Any]) -> FrozenSet[str]:
    return frozenset(iface['ipv4'] + iface['ipv6'])


def _safe(name: str) -> str:
    return ''.join(c if c.isalnum() else '_' for c in name.lower()).strip('_') or 'iface'


def _describe(addresses: FrozenSet[str]) -> str:
    return ', '.join(sorted(addresses)) or 'none'


class Interfaces(SignalPlugin):
    """The host's network interfaces with their link state and addressing,
    failing when an interface it must have is down and warning when one's
    addresses change."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.include: List[str] = list(config.get('include') or [])
        self.exclude: List[str] = list(config.get('exclude') or [])
        self.include_loopback = bool(config.get('include_loopback', False))
        self.expect_up: List[str] = list(config.get('expect_up') or [])
        # The last non-empty address set of each expected interface, so a link that drops and returns unchanged is no change.
        self._addresses: Dict[str, FrozenSet[str]] = {}

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command(_probe_script())]

    def _shown(self, iface: Dict[str, Any]) -> bool:
        name = iface['name']
        if iface['loopback'] and not self.include_loopback:
            return False
        if self.include and not any(fnmatch(name, pattern) for pattern in self.include):
            return False
        return not any(fnmatch(name, pattern) for pattern in self.exclude)

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if SCRIPT_SEP not in stdout:
            return CollectResult.unavailable(
                f"Could not list network interfaces: {(stderr or stdout).strip()[:200]}")

        parts = stdout.split(SCRIPT_SEP)
        parts += [''] * (3 - len(parts))
        ip = _parse_ip_json(parts[0].strip()) if parts[0].strip() else _parse_ip_text(parts[1])
        interfaces = _merge(_parse_sysfs(parts[2]), ip)
        if not interfaces:
            return CollectResult.unavailable("No network interfaces found in /sys/class/net or `ip addr`")

        acc = StatusAccumulator()
        logs: List[tuple] = []
        metrics: Dict[str, float] = {}
        for name in self.expect_up:
            self._check_expected(name, interfaces.get(name), acc, logs, metrics)

        shown = [iface for iface in interfaces.values() if self._shown(iface) or iface['name'] in self.expect_up]
        up = sum(1 for iface in shown if is_up(iface))
        metrics['interfaces_up'] = float(up)
        metrics['interfaces_total'] = float(len(shown))

        summary = f"{up}/{len(shown)} interface(s) up"
        if acc.problems:
            summary += f"; {'; '.join(acc.problems)}"
        logs.insert(0, (summary, acc.log_level))

        expected = set(self.expect_up)
        rows = [{**iface, 'up': is_up(iface), 'expected': iface['name'] in expected}
                for iface in sorted(shown, key=lambda i: i['name'])]
        return CollectResult(metrics=metrics, logs=logs, status=str(acc.status), snapshot=rows)

    def _check_expected(self, name: str, iface: Optional[Dict[str, Any]], acc: StatusAccumulator,
                        logs: List[tuple], metrics: Dict[str, float]) -> None:
        """Fail an expected interface that is missing or down, and warn when its addresses changed."""
        metrics[f'interface_{_safe(name)}_up'] = 1.0 if iface is not None and is_up(iface) else 0.0
        if iface is None:
            acc.escalate('failed', f"{name} is missing")
            return
        if not is_up(iface):
            why = 'has no carrier' if iface['carrier'] is False else f"is {iface['state']}"
            acc.escalate('failed', f"{name} {why}")
            return
        addresses = _address_set(iface)
        if not addresses:
            return
        previous = self._addresses.get(name)
        self._addresses[name] = addresses
        if previous is not None and previous != addresses:
            acc.escalate('warning', f"{name} addresses changed")
            logs.append((f"{name} addresses changed: {_describe(previous)} -> {_describe(addresses)}",
                         Status.WARNING.log_level))

    @property
    def _interface_rows(self) -> List[Dict[str, Any]]:
        snapshot = self.data.latest_snapshot(default=[]) if self.data else []
        rows = []
        for iface in snapshot if isinstance(snapshot, list) else []:
            speed = iface.get('speed')
            carrier = iface.get('carrier')
            rows.append({
                'name': iface.get('name', ''),
                'state': iface.get('state', ''),
                'carrier': '--' if carrier is None else ('yes' if carrier else 'no'),
                'mac': iface.get('mac') or '--',
                'mtu': iface.get('mtu') if iface.get('mtu') is not None else '--',
                'speed': f"{speed} Mb/s" if speed else '--',
                'ipv4': ', '.join(iface.get('ipv4') or []) or '--',
                'ipv6': ', '.join((iface.get('ipv6') or []) + (iface.get('ipv6_temporary') or [])) or '--',
                'up': bool(iface.get('up')),
                'expected': bool(iface.get('expected')),
            })
        return rows

    @staticmethod
    def _state_color(row: Dict[str, Any]) -> Optional[str]:
        """Color an expected interface's state; others are shown as they are."""
        if not row.get('expected'):
            return None
        return 'online' if row.get('up') else 'failed'

    def _expected_counts(self) -> Optional[tuple]:
        if not self.expect_up:
            return None
        values = [self.data.latest_metric(f'interface_{_safe(name)}_up') for name in self.expect_up]
        values = [m.value for m in values if m is not None]
        if not values:
            return None
        return sum(1 for v in values if v >= 1), len(values)

    @property
    def _expected_text(self) -> str:
        counts = self._expected_counts()
        if counts is None:
            return '--' if self.expect_up else 'NONE SET'
        return f'{counts[0]}/{counts[1]} UP'

    @property
    def _expected_color(self) -> Optional[str]:
        counts = self._expected_counts()
        if counts is None:
            return None
        return 'online' if counts[0] == counts[1] else 'failed'

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'up_card': {'metric': 'interfaces_up', 'title': 'UP', 'format': 'int'},
            'total_card': {'metric': 'interfaces_total', 'title': 'INTERFACES', 'format': 'int'},
            'expected_card': {'title': 'EXPECTED UP', 'value_attr': '_expected_text',
                              'color_attr': '_expected_color', 'refresh': True},
        }

    def tables(self) -> Dict[str, Dict[str, Any]]:
        return {
            'interfaces': {
                'row_key': 'name',
                'rows_attr': '_interface_rows',
                'columns': [
                    {'name': 'name', 'label': 'Interface', 'field': 'name', 'sortable': True, 'align': 'left'},
                    {'name': 'state', 'label': 'State', 'field': 'state', 'sortable': True, 'align': 'left',
                     'cell_color_by': self._state_color},
                    {'name': 'carrier', 'label': 'Carrier', 'field': 'carrier', 'align': 'left'},
                    {'name': 'ipv4', 'label': 'IPv4', 'field': 'ipv4', 'align': 'left'},
                    {'name': 'ipv6', 'label': 'IPv6', 'field': 'ipv6', 'align': 'left'},
                    {'name': 'mac', 'label': 'MAC', 'field': 'mac', 'align': 'left'},
                    {'name': 'mtu', 'label': 'MTU', 'field': 'mtu', 'align': 'right'},
                    {'name': 'speed', 'label': 'Speed', 'field': 'speed', 'align': 'right'},
                ],
            },
        }

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'up_chart': {'metric': 'interfaces_up', 'title': 'INTERFACES UP'}}
