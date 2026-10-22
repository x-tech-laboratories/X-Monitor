"""SMART health of every physical disk, via smartctl. A disk reporting FAILED
is failed; a disk whose verdict could not be read, a host with no disks, or a
script that could not run is unavailable, never healthy."""

from typing import Any, Dict, List, Optional

from x_monitor.plugins.base.signal_plugin import (
    SignalPlugin,
)
from x_monitor.core.connectors.types import CmdResult, Command, CollectResult


# Classification is by positive assertion: any output other than an explicit
# PASSED/FAILED verdict means the check did not run, and a blind check must not
# read as a healthy disk.
_SMART_SCRIPT = (
    "command -v smartctl >/dev/null 2>&1 || { echo 'ERROR smartctl not found'; exit 1; }; "
    # zram, zvols, loop/md/device-mapper nodes are TYPE=disk to lsblk but have no SMART.
    "disks=$(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2==\"disk\"{print $1}' "
    "  | grep -Ev '^(zram|zd|loop|md|dm-|sr|fd|ram)' | sed 's|^|/dev/|'); "
    "[ -z \"$disks\" ] && exit 0; "
    "for d in $disks; do "
    "  transport=$(lsblk -no TRAN \"$d\" 2>/dev/null || echo ''); "
    "  if [ \"$transport\" = 'usb' ]; then "
    "    result=$(sudo smartctl -H -A -d sat \"$d\" 2>&1 || true); "
    "  else "
    "    result=$(sudo smartctl -H -A \"$d\" 2>&1 || true); "
    "  fi; "
    # ATA attribute rows carry the raw reading in column 10; NVMe prints labelled lines.
    "  readings=$(echo \"$result\" | awk '"
    "/Temperature_Celsius/ {t=$10} /Airflow_Temperature_Cel/ && t == \"\" {t=$10} "
    "/^Temperature:/ {t=$2} /Power_On_Hours/ {h=$10} /^Power On Hours:/ {h=$4} "
    "END {sub(/[^0-9].*/, \"\", t); gsub(/,/, \"\", h); sub(/[^0-9].*/, \"\", h); "
    "if (t != \"\") printf \" temp=%s\", t; if (h != \"\") printf \" hours=%s\", h}'); "
    "  if echo \"$result\" | grep -iq 'test result: *PASSED'; then echo \"PASS $d$readings\"; "
    "  elif echo \"$result\" | grep -iqE 'test result: *FAILED|SMART Health Status: *FAIL'; then echo \"FAIL $d$readings\"; "
    "  elif echo \"$result\" | grep -iqE 'does not support SMART|Unable to detect device type|Operation not supported'; then "
    "    echo \"SKIP $d\"; "
    "  else echo \"UNKNOWN $d $(echo \"$result\" | tr '\\n' ' ' | cut -c1-160)\"; fi; "
    "done"
)


_VERDICTS = {'PASS': 'PASSED', 'FAIL': 'FAILED', 'UNKNOWN': 'unknown'}


_HEALTH_COLORS = {'PASSED': 'online', 'FAILED': 'failed', 'unknown': 'unavailable'}


def _reading(fields: Dict[str, str], name: str) -> Optional[float]:
    """One numeric reading from a line's key=value fields, or None when it is missing or garbled."""
    try:
        return float(fields[name])
    except (KeyError, ValueError):
        return None


def _disk_item(result: str, rest: str) -> Dict[str, Any]:
    """One disk's tile data from a script line: its name, verdict and any readings it carried."""
    disk, _, tail = rest.partition(' ')
    fields = {}
    if result != 'UNKNOWN':
        fields = dict(token.split('=', 1) for token in tail.split() if '=' in token)
    return {
        'label': disk.removeprefix('/dev/'),
        'health': _VERDICTS[result],
        'temperature': _reading(fields, 'temp'),
        'power_on_hours': _reading(fields, 'hours'),
    }


def _disk_caption(item: Dict[str, Any]) -> str:
    """A disk tile's caption: its verdict, then its temperature and power-on hours when known."""
    parts = [item.get('health') or 'unknown']
    if item.get('temperature') is not None:
        parts.append(f"{item['temperature']:.0f}°C")
    if item.get('power_on_hours') is not None:
        parts.append(f"{item['power_on_hours']:,.0f} h")
    return ' · '.join(parts)


def _disk_color(item: Dict[str, Any]) -> Optional[str]:
    """A disk tile's color: PASSED is online, FAILED failed and an unread verdict unavailable."""
    return _HEALTH_COLORS.get(item.get('health'))


class Smart(SignalPlugin):
    """Per-disk SMART overall-health verdicts from smartctl, counted into
    healthy/failed/unreadable. A disk whose health could not be read counts as
    unavailable, not healthy: "I cannot tell" and "it is fine" must not look alike.
    Each disk's verdict, temperature and power-on hours are kept in the snapshot."""

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command(_SMART_SCRIPT)]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0:
            return CollectResult.unavailable(f"SMART check script failed: {stdout or stderr}")

        passed, failed, unknown = 0, 0, 0
        logs = []
        disks: List[Dict[str, Any]] = []
        for line in stdout.splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) != 2 or parts[0] not in ('PASS', 'FAIL', 'UNKNOWN', 'SKIP'):
                continue
            result, rest = parts
            if result == 'SKIP':
                continue
            disks.append(_disk_item(result, rest))
            if result == 'FAIL':
                failed += 1
                logs.append((f"SMART failure detected on {rest.split()[0]}", "ERROR"))
            elif result == 'UNKNOWN':
                unknown += 1
                disk, _, detail = rest.partition(' ')
                logs.append((
                    f"Could not read SMART health for {disk}: {detail or 'no usable output'}",
                    "ERROR",
                ))
            else:
                passed += 1
                logs.append((f"SMART OK on {rest.split()[0]}", "INFO"))

        total = passed + failed + unknown
        if total == 0:
            result = CollectResult.unavailable("No physical disks found")
            result.snapshot = []
            return result

        return CollectResult(
            metrics={
                'disks_total': total,
                'disks_ok': passed,
                'disks_failed': failed,
                'disks_unknown': unknown,
            },
            logs=logs,
            status='failed' if failed > 0 else ('unavailable' if unknown > 0 else 'online'),
            snapshot=disks,
        )

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'smart_total_card': {'metric': 'disks_total', 'title': 'DISKS', 'format': 'int'},
            'smart_failed_card': {
                'kind': 'share', 'title': 'DISK HEALTH', 'format': 'int',
                'parts': [
                    {'metric': 'disks_ok', 'label': 'Healthy', 'color': 'online'},
                    {'metric': 'disks_failed', 'label': 'Failed', 'color': 'failed'},
                    {'metric': 'disks_unknown', 'label': 'Unreadable', 'color': 'neutral'},
                ],
            },
            'smart_disk_tiles': {
                'title': 'DISK STATE',
                'repeat': {
                    'source': 'snapshot',
                    'container': 'tiles',
                    'item_format_fn': _disk_caption,
                    'item_color_by': _disk_color,
                    'empty_text': 'No physical disks found',
                },
            },
        }

    def card_row(self) -> List[str]:
        return ['smart_total_card', 'smart_failed_card']

    def rows(self) -> List[List[str]]:
        return [['smart_disk_tiles']]
