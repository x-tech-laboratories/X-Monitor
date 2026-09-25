"""MQTT exporter: publishes every monitor's status and metrics, with Home Assistant discovery."""
import asyncio
import json
import logging
import re
import socket
from typing import Any, Callable, Dict, Iterable, List, NamedTuple, Optional, Set, Tuple

from vigil.core.contracts import MetricsSource
from vigil.core.notifications.channels import secret
from vigil.core.state import changes
from vigil.core.state.changes import CHANGES
from vigil.plugins.base.plugin_helpers import parse_duration

STATUS_OPTIONS = ('online', 'warning', 'failed', 'unavailable')

# Seconds a change waits so a burst of writes goes out as one publish pass.
COALESCE_SECONDS = 1.0
BACKOFF_MIN = 1.0
BACKOFF_MAX = 60.0

_UNSAFE = re.compile(r'[^a-z0-9_-]+')

# Name endings that say what a metric measures, checked in order; the first match wins.
_TRAITS: Tuple[Tuple[Tuple[str, ...], Dict[str, str]], ...] = (
    (('temp_c', '_celsius', '_temp', 'temperature'),
     {'device_class': 'temperature', 'unit_of_measurement': '°C'}),
    (('_pct', '_percent'), {'unit_of_measurement': '%'}),
    (('_seconds', '_secs'), {'device_class': 'duration', 'unit_of_measurement': 's'}),
    (('_ms',), {'device_class': 'duration', 'unit_of_measurement': 'ms'}),
    (('_bytes',), {'device_class': 'data_size', 'unit_of_measurement': 'B'}),
    (('_kb',), {'device_class': 'data_size', 'unit_of_measurement': 'kB'}),
    (('_mb',), {'device_class': 'data_size', 'unit_of_measurement': 'MB'}),
    (('_gb',), {'device_class': 'data_size', 'unit_of_measurement': 'GB'}),
    (('_mbps',), {'device_class': 'data_rate', 'unit_of_measurement': 'Mbit/s'}),
    (('_dbm',), {'device_class': 'signal_strength', 'unit_of_measurement': 'dBm'}),
    (('_watts', '_w'), {'device_class': 'power', 'unit_of_measurement': 'W'}),
    (('_per_sec',), {'unit_of_measurement': '/s'}),
)


class Monitor(NamedTuple):
    id: str
    name: str
    target: str


def slug(value: Any) -> str:
    """A form of `value` safe as one MQTT topic level and as a Home Assistant id."""
    return _UNSAFE.sub('_', str(value).lower()).strip('_') or 'unnamed'


def metric_traits(metric: str) -> Dict[str, str]:
    """The Home Assistant device class, unit and state class a metric's name implies."""
    name = metric.lower()
    traits = {'state_class': 'measurement'}
    for endings, found in _TRAITS:
        if name.endswith(endings):
            traits.update(found)
            break
    return traits


def normalize_status(state: Optional[str]) -> str:
    """A stored status mapped onto the four the status sensor declares."""
    return state if state in STATUS_OPTIONS else 'unavailable'


def format_value(value: Any) -> str:
    """A metric value as an MQTT payload."""
    return str(value)


def _device(base: str, target: str) -> Dict[str, Any]:
    return {
        'identifiers': [f'{slug(base)}_{slug(target)}'],
        'name': target,
        'manufacturer': 'Vigil',
        'model': 'Monitored host',
    }


def _common(base: str, monitor: Monitor) -> Dict[str, Any]:
    return {
        'availability_topic': f'{base}/status',
        'device': _device(base, monitor.target),
        'origin': {'name': 'Vigil'},
    }


def status_topic(base: str, monitor_id: str) -> str:
    """The topic carrying a monitor's status."""
    return f'{base}/{slug(monitor_id)}/status'


def metric_topic(base: str, monitor_id: str, metric: str) -> str:
    """The topic carrying one metric of a monitor."""
    return f'{base}/{slug(monitor_id)}/{slug(metric)}'


def status_configs(base: str, prefix: str, monitor: Monitor) -> List[Tuple[str, Dict[str, Any]]]:
    """The discovery topics and payloads of a monitor's status sensor and problem binary sensor."""
    node, uid = slug(monitor.id), f'{slug(base)}_{slug(monitor.id)}'
    state = status_topic(base, monitor.id)
    status = {
        **_common(base, monitor),
        'name': f'{monitor.name} status',
        'unique_id': f'{uid}_status',
        'state_topic': state,
        'device_class': 'enum',
        'options': list(STATUS_OPTIONS),
        'icon': 'mdi:list-status',
    }
    problem = {
        **_common(base, monitor),
        'name': f'{monitor.name} problem',
        'unique_id': f'{uid}_problem',
        'state_topic': state,
        'device_class': 'problem',
        'value_template': "{{ 'OFF' if value == 'online' else 'ON' }}",
    }
    return [
        (f'{prefix}/sensor/{slug(base)}_{node}/status/config', status),
        (f'{prefix}/binary_sensor/{slug(base)}_{node}/problem/config', problem),
    ]


def metric_config(base: str, prefix: str, monitor: Monitor,
                  metric: str) -> Tuple[str, Dict[str, Any]]:
    """The discovery topic and payload of one metric's sensor."""
    node, obj = slug(monitor.id), slug(metric)
    payload = {
        **_common(base, monitor),
        'name': f'{monitor.name} {metric.replace("_", " ")}',
        'unique_id': f'{slug(base)}_{node}_{obj}',
        'state_topic': metric_topic(base, monitor.id, metric),
        **metric_traits(metric),
    }
    return f'{prefix}/sensor/{slug(base)}_{node}/{obj}/config', payload


def _aiomqtt():
    try:
        import aiomqtt
    except ImportError as e:
        raise ImportError(
            "the MQTT exporter needs the aiomqtt package: pip install 'vigil[mqtt]'") from e
    return aiomqtt


class MQTTExporter:
    """Publishes on every status and metric change, and republishes everything on (re)connect."""

    def __init__(self, db: MetricsSource, config: Dict[str, Any],
                 monitors: Optional[Callable[[], Iterable[Any]]] = None,
                 client_factory: Optional[Callable[[], Any]] = None):
        self.db = db
        self.host = config['host']
        self.tls = config.get('tls') or False
        self.port = int(config.get('port') or (8883 if self.tls else 1883))
        self.username = config.get('username')
        self.password = secret(config, 'password')
        self.client_id = config.get('client_id') or f'vigil-{slug(socket.gethostname())}'
        self.base = str(config.get('base_topic') or 'vigil').strip('/')
        self.prefix = str(config.get('discovery_prefix') or 'homeassistant').strip('/')
        self.discovery = bool(config.get('discovery', True))
        self.retain = bool(config.get('retain', True))
        self.interval = parse_duration(config.get('interval') or 0)
        self.coalesce = COALESCE_SECONDS
        if client_factory is None:
            self._mqtt = _aiomqtt()
            client_factory = self._client
        self._client_factory = client_factory
        self._monitors = monitors or (lambda: ())
        self._dirty: Set[str] = set()
        self._full = True
        self._announced: Set[Tuple[str, str]] = set()
        self._wake: Optional[asyncio.Event] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._unsubscribe: Optional[Callable[[], None]] = None
        self._task: Optional[asyncio.Task] = None
        self._connected = False

    @property
    def availability_topic(self) -> str:
        return f'{self.base}/status'

    def _client(self) -> Any:
        mqtt = self._mqtt
        tls_params, tls_insecure = None, None
        if self.tls:
            opts = self.tls if isinstance(self.tls, dict) else {}
            tls_params = mqtt.TLSParameters(
                ca_certs=opts.get('ca_certs'), certfile=opts.get('certfile'),
                keyfile=opts.get('keyfile'))
            tls_insecure = bool(opts.get('insecure')) or None
        return mqtt.Client(
            self.host, self.port, username=self.username, password=self.password,
            identifier=self.client_id, timeout=10,
            will=mqtt.Will(self.availability_topic, 'offline', qos=1, retain=True),
            tls_params=tls_params, tls_insecure=tls_insecure,
        )

    def start(self) -> None:
        """Watch the change bus and start the connection task. Needs the running loop."""
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        self._unsubscribe = CHANGES.subscribe(self._on_change)
        self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        """Stop watching changes and end the connection task, which says offline on its way out."""
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        if self._task:
            self._task.cancel()
            self._task = None

    def _on_change(self, kind: str, plugin_id: Optional[str]) -> None:
        """Change-bus subscriber: runs on the writer's thread, so it only hands off."""
        if kind not in (changes.STATUS, changes.METRIC) or not plugin_id or self._loop is None:
            return
        try:
            self._loop.call_soon_threadsafe(self._mark, plugin_id)
        except RuntimeError:
            pass  # The loop has closed during shutdown.

    def _mark(self, plugin_id: Optional[str] = None) -> None:
        """Queue one monitor for publishing, or everything when no monitor is given."""
        if plugin_id is None:
            self._full = True
        else:
            self._dirty.add(plugin_id)
        if self._wake is not None:
            self._wake.set()

    async def run(self) -> None:
        """Connect, publish, and reconnect with backoff for as long as the exporter runs."""
        logging.info(f"MQTT exporter started -> {self.host}:{self.port} as {self.client_id}")
        if self._wake is None:
            self._wake = asyncio.Event()
        delay, quiet = BACKOFF_MIN, False
        while True:
            # A broker that is down or drops us must never end the exporter; the next attempt retries.
            try:
                await self._session()
                error: Any = 'connection closed'
            except asyncio.CancelledError:
                raise
            except Exception as e:
                error = e
            if self._connected:
                self._connected, delay, quiet = False, BACKOFF_MIN, False
            log = logging.debug if quiet else logging.warning
            log(f"MQTT exporter: {self.host}:{self.port} unreachable ({error}); "
                f"retrying in {delay:.0f}s")
            quiet = True
            await asyncio.sleep(delay)
            delay = min(delay * 2, BACKOFF_MAX)

    async def _session(self) -> None:
        """One connection: announce, publish everything, then follow changes until it drops."""
        client = self._client_factory()
        async with client:
            self._connected = True
            logging.info(f"MQTT exporter connected to {self.host}:{self.port}")
            try:
                await client.publish(self.availability_topic, 'online', qos=1, retain=True)
                if self.discovery:
                    await client.subscribe(f'{self.prefix}/status')
                self._announced.clear()
                self._mark()
                await self._follow(client)
            except asyncio.CancelledError:
                # A clean disconnect suppresses the last will, so say offline before leaving.
                try:
                    await asyncio.wait_for(
                        client.publish(self.availability_topic, 'offline', qos=1, retain=True), 2)
                except Exception:
                    pass
                raise

    async def _follow(self, client: Any) -> None:
        tasks = [asyncio.create_task(self._drain(client))]
        if self.discovery:
            tasks.append(asyncio.create_task(self._listen(client)))
        if self.interval > 0:
            tasks.append(asyncio.create_task(self._tick()))
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        for task in done:
            task.result()

    async def _drain(self, client: Any) -> None:
        """Publish whatever changed, one coalesced pass per burst."""
        while True:
            await self._wake.wait()
            if self.coalesce:
                await asyncio.sleep(self.coalesce)
            self._wake.clear()
            full, dirty = self._full, self._dirty
            self._full, self._dirty = False, set()
            try:
                await self.publish(client, None if full else dirty)
            except BaseException:
                # What failed to go out is sent again on the next connection.
                self._full = True
                raise

    async def _listen(self, client: Any) -> None:
        """Republish everything when Home Assistant announces it has (re)started."""
        birth = f'{self.prefix}/status'
        async for message in client.messages:
            # A retained birth is an old one, and everything was just published on connect.
            if getattr(message, 'retain', False) or str(message.topic) != birth:
                continue
            payload = message.payload
            if isinstance(payload, (bytes, bytearray)):
                payload = payload.decode('utf-8', 'replace')
            if str(payload).strip() == 'online':
                logging.info("MQTT exporter: Home Assistant came online, republishing discovery")
                self._announced.clear()
                self._mark()

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            self._mark()

    def _monitor_index(self) -> Dict[str, Monitor]:
        index: Dict[str, Monitor] = {}
        try:
            for plugin in self._monitors():
                pid = str(plugin.id)
                index[pid] = Monitor(pid, str(getattr(plugin, 'name', None) or pid),
                                     str(getattr(plugin, 'target', None) or 'localhost'))
        except Exception as e:
            logging.debug(f"MQTT exporter could not list monitors: {e}")
        return index

    async def publish(self, client: Any, only: Optional[Set[str]] = None) -> None:
        """Publish the status and metrics of the monitors in `only`, or of every monitor."""
        monitors = self._monitor_index()
        statuses = self.db.latest_statuses()
        metrics: Dict[str, List[Dict[str, Any]]] = {}
        for row in self.db.latest_metrics():
            if only is None or row['plugin_id'] in only:
                metrics.setdefault(row['plugin_id'], []).append(row)
        ids = (set(monitors) | set(statuses) | set(metrics)) if only is None else set(only)
        for pid in sorted(ids):
            rows = metrics.get(pid, [])
            monitor = monitors.get(pid) or Monitor(
                pid, pid, rows[0]['target'] if rows else 'localhost')
            await self._publish_monitor(client, monitor, statuses.get(pid), rows)

    async def _publish_monitor(self, client: Any, monitor: Monitor, state: Optional[str],
                               rows: List[Dict[str, Any]]) -> None:
        if self.discovery and (monitor.id, '') not in self._announced:
            for topic, payload in status_configs(self.base, self.prefix, monitor):
                await client.publish(topic, json.dumps(payload), qos=1, retain=self.retain)
            self._announced.add((monitor.id, ''))
        await client.publish(status_topic(self.base, monitor.id), normalize_status(state),
                             retain=self.retain)
        for row in sorted(rows, key=lambda r: r['metric_name']):
            metric = row['metric_name']
            if self.discovery and (monitor.id, metric) not in self._announced:
                topic, payload = metric_config(self.base, self.prefix, monitor, metric)
                await client.publish(topic, json.dumps(payload), qos=1, retain=self.retain)
                self._announced.add((monitor.id, metric))
            await client.publish(metric_topic(self.base, monitor.id, metric),
                                 format_value(row['value']), retain=self.retain)
