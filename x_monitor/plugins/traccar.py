"""Traccar GPS-device freshness via one GET of /api/devices over HTTP from
the X-Monitor host, basic-authenticated as a dedicated x-monitor account. Config:
api_url (required, X-Monitor-reachable), username, password / password_command,
devices (names to watch, default all enabled), stale_warning /
stale_threshold (hours), api_timeout. A device silent past stale_warning is
warning; one past stale_threshold, or that never reported, is failed; no
matching enabled devices is a warning. Transport, auth and payload errors
mean nothing was measured, so they are unavailable."""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import (
    CollectResult, HttpRequest, HttpResult, Request, Result,
)
from x_monitor.plugins.base.plugin_helpers import StatusAccumulator, resolve_secret


def _parse_response(stdout: str) -> List[Dict[str, Any]]:
    try:
        devices = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise ValueError(f"device list was not JSON ({e}): {stdout[:200]!r}") from e
    if not isinstance(devices, list):
        raise ValueError(f"device list was not a list: {stdout[:200]!r}")
    return devices


def _age_hours(last_update: Optional[str]) -> Optional[float]:
    if not last_update:
        return None
    try:
        ts = datetime.fromisoformat(last_update.replace('Z', '+00:00'))
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0


def _http_failure(result) -> Optional[CollectResult]:
    """The unavailable CollectResult for a transport, auth, or HTTP error, or None when the response is usable."""
    if result.error is not None:
        return CollectResult.unavailable(f"Failed to query Traccar API: {result.error}")
    if result.status_code == 401:
        return CollectResult.unavailable(
            "Traccar rejected the configured credentials "
            "(check username / password_command)")
    if result.status_code != 200:
        return CollectResult.unavailable(
            f"Traccar API returned HTTP {result.status_code}")
    return None


def _survey_staleness(watched: List[Dict[str, Any]], stale_warning: float,
                      stale_threshold: float):
    """Bucket devices into warn/fail staleness lists (age -1 meaning never reported) and find the oldest update age."""
    stale_warn: List[Tuple[str, float]] = []
    stale_fail: List[Tuple[str, float]] = []
    oldest_age = 0.0

    for device in watched:
        age = _age_hours(device.get('lastUpdate'))
        name = device.get('name', '?')
        if age is None:
            stale_fail.append((name, -1))
            continue
        oldest_age = max(oldest_age, age)
        if age >= stale_threshold:
            stale_fail.append((name, age))
        elif age >= stale_warning:
            stale_warn.append((name, age))

    return stale_warn, stale_fail, oldest_age


def _accumulate_staleness(stale_warn: List[Tuple[str, float]],
                          stale_fail: List[Tuple[str, float]],
                          stale_warning: float, stale_threshold: float) -> StatusAccumulator:
    """Fold the stale-device buckets into problem lines and a worst-of status."""
    acc = StatusAccumulator()
    if stale_fail:
        names = ', '.join(
            f"{name} (never reported)" if age < 0 else f"{name} ({age:.0f}h)"
            for name, age in stale_fail[:3])
        suffix = f" (+{len(stale_fail) - 3} more)" if len(stale_fail) > 3 else ""
        acc.escalate('failed',
                     f"{len(stale_fail)} stale >= {stale_threshold:.0f}h: {names}{suffix}")
    if stale_warn:
        names = ', '.join(f"{name} ({age:.0f}h)" for name, age in stale_warn[:3])
        suffix = f" (+{len(stale_warn) - 3} more)" if len(stale_warn) > 3 else ""
        acc.escalate('warning',
                     f"{len(stale_warn)} stale >= {stale_warning:.0f}h: {names}{suffix}")
    return acc


def _device_items(watched: List[Dict[str, Any]], stale_warning: float,
                  stale_threshold: float) -> List[Dict[str, Any]]:
    """One snapshot item per watched device, by name, with its update age in hours and its staleness state."""
    items = []
    for device in watched:
        age = _age_hours(device.get('lastUpdate'))
        if age is None or age >= stale_threshold:
            state = 'failed'
        elif age >= stale_warning:
            state = 'warning'
        else:
            state = 'online'
        items.append({'label': device.get('name', '?'), 'age_hours': age, 'state': state})
    return sorted(items, key=lambda item: item['label'])


def _age_text(item: Dict[str, Any]) -> str:
    """One device's update age in minutes under an hour and in hours past it."""
    age = item.get('age_hours')
    if age is None:
        return 'never'
    if age < 1:
        return f"{age * 60:.0f} min"
    return f"{age:.1f} h"


def _device_color(item: Dict[str, Any]) -> Optional[str]:
    """One device's meter color, which is its staleness state."""
    return item.get('state')


_DEFAULT_LAYOUT = [
    ['host_card', 'stale_card', 'devices_card'],
    ['device_bars'],
    ['chart'],
    ['events'],
]


class Traccar(Plugin):
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        # X-Monitor fetches this URL directly; it must be X-Monitor-reachable, no default.
        self.api_url = config.get('api_url')
        self.username = config.get('username')
        # Resolve the secret once, on the X-Monitor host, so requests() stays pure.
        self.password = resolve_secret(config.get('password'),
                                       config.get('password_command'))
        self.stale_warning = float(config.get('stale_warning', 24))
        self.stale_threshold = float(config.get('stale_threshold', 72))
        self.devices: Optional[List[str]] = config.get('devices') or None
        self.api_timeout = int(config.get('api_timeout', 10))

    def requests(self) -> List[Request]:
        if not self.api_url or not self.username:
            return []
        base = self.api_url.rstrip('/')
        return [HttpRequest(
            url=f"{base}/api/devices", timeout=self.api_timeout,
            auth=(self.username, self.password or ''),
        )]

    def parse_results(self, results: List[Result]) -> CollectResult:
        """Turns the single /api/devices HTTP result into a CollectResult with
        device-count and staleness metrics, one summary log line, and a status
        where a device past stale_threshold (or never reporting) is failed and
        one past stale_warning is warning."""
        if not self.api_url:
            return CollectResult.unavailable("No 'api_url' configured")
        if not self.username:
            return CollectResult.unavailable(
                "No username configured — set username/password_command "
                "for the dedicated Traccar x-monitor account")

        result: HttpResult = results[0]
        failure = _http_failure(result)
        if failure is not None:
            return failure

        try:
            devices = _parse_response(result.text)
        except ValueError as e:
            return CollectResult.unavailable(str(e))

        watched = [device for device in devices if not device.get('disabled')
                   and (self.devices is None or device.get('name') in self.devices)]

        if not watched:
            return CollectResult(
                logs=[("No matching enabled devices reported by Traccar", "WARNING")],
                status='warning',
            )

        stale_warn, stale_fail, oldest_age = _survey_staleness(
            watched, self.stale_warning, self.stale_threshold)

        metrics = {
            'devices_total': float(len(watched)),
            'oldest_update_hours': oldest_age,
            'devices_stale': float(len(stale_warn) + len(stale_fail)),
        }

        acc = _accumulate_staleness(stale_warn, stale_fail,
                                    self.stale_warning, self.stale_threshold)

        parts = [f"{len(watched)} device(s)", f"oldest update {oldest_age:.0f}h ago"]
        if acc.problems:
            parts.append("| " + "; ".join(acc.problems))

        return CollectResult(metrics=metrics, logs=[(' | '.join(parts), acc.log_level)],
                             status=acc.status,
                             snapshot=_device_items(watched, self.stale_warning,
                                                    self.stale_threshold))

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'stale_card': {
                    'metric': 'devices_stale', 'title': 'STALE DEVICES',
                    'format': 'int', 'color': 'traccar_nonzero_failed',
                },
                'devices_card': {'metric': 'devices_total', 'title': 'DEVICES', 'format': 'int'},
                'device_bars': {
                    'title': 'LAST UPDATE BY DEVICE',
                    'repeat': {
                        'source': 'snapshot',
                        'container': 'bars',
                        'bar_value': 'age_hours',
                        'bar_max': 2 * self.stale_threshold,
                        'bar_marker': 50.0,
                        'item_format_fn': _age_text,
                        'item_color_by': _device_color,
                        'empty_text': 'No devices reported yet',
                    },
                },
            },
            'chart': {'metric': 'oldest_update_hours', 'title': 'OLDEST UPDATE (HOURS)'},
            'events': True,
        }


from x_monitor.core.ui.spec import register_color_rule


@register_color_rule('traccar_nonzero_failed')
def _stale_color(v):
    if v is None:
        return None
    return 'failed' if v else 'online'
