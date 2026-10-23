"""Whether a host needs a reboot to run what is installed, by every check that
applies to it: Debian's /var/run/reboot-required flag (and its .pkgs list),
RHEL's `needs-restarting -r`, NixOS's booted vs current kernel, initrd,
modules and systemd, and on any other host a running kernel whose module
directory is gone. A reboot any check asks for is reboot_status (warning by
default); a host where no check applies is unavailable. Config: reboot_status."""

import re
from typing import Any, Dict, List, Optional

from x_monitor.plugins.base.nixos_boot import boot_parts_script, changed_parts, reboot_required
from x_monitor.plugins.base.signal_plugin import SignalPlugin
from x_monitor.core.connectors.types import CmdResult, CollectResult, Command, Status
from x_monitor.core.settings.config_schema import PluginConfig

_SEVERITIES = ('online', 'warning', 'failed')

# The package lines needs-restarting -r prints under "Core libraries or services have been updated".
_RHEL_PACKAGE_RE = re.compile(r'^\s*\*\s*(\S+)')


def _probe_script() -> str:
    """One script running every reboot check the host supports, as key=value lines."""
    return '\n'.join([
        'echo "kernel=$(uname -r)"',
        'if [ -e /run/booted-system ]; then',
        '  echo "nixos=1"',
        *('  ' + line for line in boot_parts_script()),
        'fi',
        'if [ -d /var/lib/dpkg ]; then',
        '  echo "debian=1"',
        '  if [ -f /var/run/reboot-required ]; then echo "debian_flag=1"; fi',
        "  sed 's/^/debian_pkg=/' /var/run/reboot-required.pkgs 2>/dev/null",
        'fi',
        'if command -v needs-restarting >/dev/null 2>&1; then',
        '  out=$(needs-restarting -r 2>&1); echo "rhel_rc=$?"',
        "  printf '%s\\n' \"$out\" | sed 's/^/rhel_out=/'",
        'elif command -v dnf >/dev/null 2>&1; then',
        '  out=$(dnf -q needs-restarting -r 2>&1); echo "rhel_rc=$?"',
        "  printf '%s\\n' \"$out\" | sed 's/^/rhel_out=/'",
        'fi',
        'for dir in /usr/lib/modules /lib/modules; do',
        '  if [ -d "$dir" ]; then',
        '    if [ -d "$dir/$(uname -r)" ]; then echo "modules=present"; else echo "modules=missing"; fi',
        '    break',
        '  fi',
        'done',
    ])


def _parse_probe(stdout: str) -> Dict[str, Any]:
    """Turn the probe's key=value lines into a dict, collecting the repeated keys into lists."""
    repeated = ('booted_part', 'current_part', 'debian_pkg', 'rhel_out')
    fields: Dict[str, Any] = {key: [] for key in repeated}
    for line in stdout.splitlines():
        key, sep, value = line.partition('=')
        if not sep:
            continue
        if key in repeated:
            fields[key].append(value.strip())
        else:
            fields[key] = value.strip()
    return fields


def _unique(items: List[str]) -> List[str]:
    return list(dict.fromkeys(item for item in items if item))


def _checks(fields: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every check that could run on this host, each with its verdict, reason and packages."""
    checks: List[Dict[str, Any]] = []

    if fields.get('nixos'):
        booted, current = fields['booted_part'], fields['current_part']
        verdict = reboot_required(booted, current)
        if verdict is not None:
            parts = changed_parts(booted, current)
            checks.append({'check': 'nixos', 'required': verdict,
                           'reason': f"booted {', '.join(parts)} differ from the current system"
                           if verdict else 'booted system matches the current one',
                           'packages': parts})

    if fields.get('debian'):
        required = bool(fields.get('debian_flag'))
        checks.append({'check': 'debian', 'required': required,
                       'reason': '/var/run/reboot-required is present' if required
                       else 'no /var/run/reboot-required flag',
                       'packages': _unique(fields['debian_pkg']) if required else []})

    rhel = _rhel_check(fields)
    if rhel is not None:
        checks.append(rhel)

    modules = fields.get('modules')
    # NixOS keeps no /lib/modules tree, so its own check stands in for this one.
    if modules and not fields.get('nixos'):
        required = modules == 'missing'
        kernel = fields.get('kernel') or '?'
        checks.append({'check': 'kernel', 'required': required,
                       'reason': f"running kernel {kernel} has no module directory" if required
                       else f"running kernel {kernel} is still installed",
                       'packages': []})
    return checks


def _rhel_check(fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """needs-restarting's verdict: exit 0 means no reboot, exit 1 with its reboot message means one is needed."""
    rc = fields.get('rhel_rc')
    lines = fields['rhel_out']
    text = '\n'.join(lines).lower()
    if rc == '0':
        return {'check': 'rhel', 'required': False,
                'reason': 'needs-restarting reports no reboot needed', 'packages': []}
    # Exit 1 is also how dnf reports a command it does not have, so the message must mention a reboot.
    if rc == '1' and 'reboot' in text:
        packages = _unique([m.group(1) for m in map(_RHEL_PACKAGE_RE.match, lines) if m])
        return {'check': 'rhel', 'required': True,
                'reason': 'needs-restarting reports core packages updated since boot',
                'packages': packages}
    return None


class RebootRequired(SignalPlugin):
    """Whether the host must reboot to run its installed kernel and core
    libraries, from whichever of the distro checks the host supports."""

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        status = str(config.get('reboot_status', 'warning')).lower()
        self.reboot_status = status if status in _SEVERITIES else 'warning'

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command(_probe_script())]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0 and not stdout.strip():
            return CollectResult.unavailable(f"Could not run the reboot checks: {stderr.strip()[:200]}")

        fields = _parse_probe(stdout)
        checks = _checks(fields)
        if not checks:
            return CollectResult.unavailable(
                "No reboot check applies to this host (no reboot-required flag, "
                "needs-restarting, NixOS boot links or kernel module directory)")

        required = [c for c in checks if c['required']]
        packages = _unique([p for c in required for p in c['packages']])
        snapshot = {
            'required': bool(required),
            'kernel': fields.get('kernel', ''),
            'checks': [c['check'] for c in checks],
            'reasons': [c['reason'] for c in (required or checks)],
            'packages': packages,
        }
        metrics = {'reboot_required': 1.0 if required else 0.0}
        if not required:
            return CollectResult(
                metrics=metrics, snapshot=snapshot, status='online',
                logs=[(f"No reboot required ({'; '.join(snapshot['reasons'])})", 'INFO')],
            )
        message = f"Reboot required: {'; '.join(snapshot['reasons'])}"
        if packages:
            message += f" (packages: {', '.join(packages)})"
        return CollectResult(
            metrics=metrics, snapshot=snapshot, status=self.reboot_status,
            logs=[(message, Status(self.reboot_status).log_level)],
        )

    def _snapshot(self) -> Dict[str, Any]:
        snapshot = self.data.latest_snapshot(default={}) if self.data else {}
        return snapshot if isinstance(snapshot, dict) else {}

    @property
    def _reboot_text(self) -> str:
        metric = self.data.latest_metric('reboot_required')
        if metric is None:
            return '--'
        return 'REQUIRED' if metric.value >= 1 else 'NOT NEEDED'

    @property
    def _reboot_color(self) -> Optional[str]:
        metric = self.data.latest_metric('reboot_required')
        if metric is None:
            return None
        return self.reboot_status if metric.value >= 1 else 'online'

    @property
    def _kernel_text(self) -> str:
        return self._snapshot().get('kernel') or '--'

    @property
    def _checks_text(self) -> str:
        return ', '.join(self._snapshot().get('checks') or []) or '--'

    @property
    def _reason_rows(self) -> List[Dict[str, str]]:
        snapshot = self._snapshot()
        rows = [{'id': f'reason-{i}', 'kind': 'Reason', 'detail': reason}
                for i, reason in enumerate(snapshot.get('reasons') or [])]
        rows += [{'id': f'package-{i}', 'kind': 'Package', 'detail': package}
                 for i, package in enumerate(snapshot.get('packages') or [])]
        return rows

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'reboot_card': {'title': 'REBOOT', 'value_attr': '_reboot_text',
                            'color_attr': '_reboot_color', 'refresh': True},
            'kernel_card': {'title': 'RUNNING KERNEL', 'value_attr': '_kernel_text',
                            'refresh': True},
            'checks_card': {'title': 'CHECKED BY', 'value_attr': '_checks_text',
                            'refresh': True},
        }

    def tables(self) -> Dict[str, Dict[str, Any]]:
        return {
            'details': {
                'row_key': 'id',
                'rows_attr': '_reason_rows',
                'columns': [
                    {'name': 'kind', 'label': 'Kind', 'field': 'kind', 'align': 'left'},
                    {'name': 'detail', 'label': 'Detail', 'field': 'detail', 'align': 'left'},
                ],
            },
        }

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'reboot_chart': {'metric': 'reboot_required', 'title': 'REBOOT REQUIRED'}}
