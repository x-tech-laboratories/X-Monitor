"""Basic host reachability: one ICMP ping request through the ping connector
each cycle, with latency parsed out of the reply. The shared
ssh_config/target_host setting names the host to ping. A reply is online; no
reply or a ping execution error is failed, with no warning tier.

With `mac:` set it also offers a Wake action that sends a Wake-on-LAN magic
packet: broadcast from the X-Monitor server by default (wol_broadcast, wol_port,
wol_password), or with wake_via from another monitor's host, for a machine on
a subnet only that host reaches (wake_command overrides how it is sent there).
wake_on_down sends one automatically when the host goes down, every
wake_retry, up to wake_max_attempts times until the host is seen up again."""

import re
import logging
import shlex
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.plugins.base.plugin_helpers import format_duration, parse_duration
from x_monitor.core.connectors.types import (
    ActionPlan, CmdResult, CollectResult, IoActionPlan, PingRequest, PingResult, Request, Result,
)
from x_monitor.core.connectors.wol import (
    DEFAULT_BROADCAST, DEFAULT_PORT, magic_packet, remote_send_command, send_magic_packet,
)

log = logging.getLogger(__name__)

_DEFAULT_LAYOUT = [
    ['host_card', 'status_card', 'latency_card'],
    ['uptime_strip'],
    ['chart'],
    ['events'],
]

_WAKE_LAYOUT = [
    ['host_card', 'status_card', 'latency_card'],
    ['wake'],
    ['uptime_strip'],
    ['chart'],
    ['events'],
]

_WAKE_TIMEOUT = 30.0


class Uptime(Plugin):
    RUNS_ON_AGENT = False
    AVAILABILITY = True

    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.mac = config.get('mac')
        self.wol_broadcast = str(config.get('wol_broadcast') or DEFAULT_BROADCAST)
        self.wol_port = int(config.get('wol_port') or DEFAULT_PORT)
        self.wol_password = config.get('wol_password')
        self.wake_via = config.get('wake_via')
        self.wake_command = config.get('wake_command')
        self.wake_on_down = bool(config.get('wake_on_down', False))
        self.wake_retry = parse_duration(config.get('wake_retry', '10m'))
        self.wake_max_attempts = int(config.get('wake_max_attempts', 3))
        self._wake_attempts = 0
        self._last_wake: Optional[float] = None

    def requests(self) -> List[Request]:
        return [PingRequest(self.target)]

    def parse_results(self, results: List[Result]) -> CollectResult:
        host = self.target
        result: PingResult = results[0]

        if result.exception is not None:
            log.error(f"Uptime plugin error for {host}: {result.exception}")
            return CollectResult(
                metrics={'up': 0.0},
                logs=[(f"Ping execution failed: {result.exception}", "ERROR")],
                status='failed',
            )

        if result.returncode == 0:
            metrics = {'up': 1.0}
            latency_match = re.search(r'time=([\d.]+)\s*ms', result.stdout)
            if latency_match:
                metrics['latency_ms'] = float(latency_match.group(1))
            return CollectResult(
                metrics=metrics,
                logs=[(f"Host {host} is reachable.", "INFO")],
                status='online',
            )

        err_msg = result.stderr.strip() or "Request timed out"
        return CollectResult(
            metrics={'up': 0.0},
            logs=[(f"Host {host} is unreachable: {err_msg}", "ERROR")],
            status='failed',
        )

    # --- Wake-on-LAN ---

    def on_status(self, status: str, now: float) -> Optional[Tuple[str, Dict[str, Any]]]:
        """Asks for a wake when the host is down, spaced by wake_retry and capped until it is seen up again."""
        if not (self.mac and self.wake_on_down):
            return None
        if status == 'online':
            self._wake_attempts, self._last_wake = 0, None
            return None
        if status != 'failed' or self._wake_attempts >= self.wake_max_attempts:
            return None
        if self._last_wake is not None and now - self._last_wake < self.wake_retry:
            return None
        self._wake_attempts += 1
        self._last_wake = now
        return 'wake', {'automatic': True, 'attempt': self._wake_attempts}

    def _route(self) -> str:
        if self.wake_via:
            return f"from monitor {self.wake_via}"
        return f"to {self.wol_broadcast}:{self.wol_port}"

    def _wake_outcome(self, message: str, success: bool, automatic: bool, attempt: int) -> CollectResult:
        if automatic:
            message = f"Automatic wake {attempt} of {self.wake_max_attempts}: {message}"
            if attempt >= self.wake_max_attempts:
                message += f"; no more automatic wakes until {self.name} is seen up again"
        return CollectResult(logs=[(message, 'INFO' if success else 'ERROR')],
                             metadata={'content': message}, success=success)

    def _remote_command(self, packet: bytes) -> str:
        if not self.wake_command:
            return remote_send_command(packet, self.wol_broadcast, self.wol_port)
        return str(self.wake_command).format(
            mac=shlex.quote(str(self.mac)), hex=packet.hex(),
            broadcast=shlex.quote(self.wol_broadcast), port=self.wol_port,
            password=shlex.quote(str(self.wol_password or '')),
        )

    def plan_action(self, action_id: str, automatic: bool = False, attempt: int = 0, **kwargs):
        if action_id != 'wake' or not self.mac:
            return None
        try:
            packet = magic_packet(str(self.mac), self.wol_password)
        except ValueError as e:
            return self._wake_outcome(f"Wake {self.target} failed: {e}", False, automatic, attempt)
        if self.wake_via:
            try:
                command = self._remote_command(packet)
            except (KeyError, IndexError, ValueError) as e:
                return self._wake_outcome(f"Wake {self.target} failed: bad wake_command ({e!r})",
                                          False, automatic, attempt)
            return ActionPlan(command, timeout=_WAKE_TIMEOUT, via=str(self.wake_via))

        def _send(address=self.wol_broadcast, port=self.wol_port) -> Optional[str]:
            try:
                send_magic_packet(packet, address, port)
            except OSError as e:
                return str(e) or type(e).__name__
            return None

        return IoActionPlan(_send)

    def interpret_action(self, action_id: str, result: Any, automatic: bool = False, attempt: int = 0, **kwargs):
        if isinstance(result, CmdResult):
            error = None if result.exit_code == 0 else (
                (result.stderr or result.stdout).strip() or f"exit code {result.exit_code}")
        else:
            error = result
        if error:
            return self._wake_outcome(f"Wake {self.target} failed {self._route()}: {error}", False, automatic, attempt)
        return self._wake_outcome(f"Wake-on-LAN packet for {self.mac} sent {self._route()}", True, automatic, attempt)

    @property
    def UI_SPEC(self):
        spec = {
            'layout': _WAKE_LAYOUT if self.mac else _DEFAULT_LAYOUT,
            'cards': {
                'status_card': {
                    'metric': 'up', 'title': 'CURRENT STATUS',
                    'on_text': 'ONLINE', 'off_text': 'OFFLINE',
                },
                'latency_card': {
                    'metric': 'latency_ms', 'title': 'LAST LATENCY', 'format': 'seconds_ms',
                },
                'uptime_strip': {'kind': 'strip', 'metric': 'up', 'title': 'AVAILABILITY'},
            },
            'chart': {'metric': 'latency_ms', 'title': 'RESPONSE TIME HISTORY (ms)'},
            'events': True,
        }
        if self.mac:
            auto = (f' It is also sent automatically when the host goes down, every '
                    f'{format_duration(self.wake_retry)}, up to {self.wake_max_attempts} times.'
                    if self.wake_on_down else '')
            spec['buttons'] = {'wake': [{
                'id': 'wake', 'label': 'Wake', 'icon': 'power_settings_new', 'flat': False,
                'confirm': 'Send a Wake-on-LAN packet to {plugin.target} ({plugin.mac})?' + auto,
            }]}
        return spec
