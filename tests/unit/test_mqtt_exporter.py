"""MQTT exporter: topic layout, Home Assistant discovery, change-driven publishing and reconnects."""

import asyncio
import json
import sys
from types import SimpleNamespace

import pytest

from vigil.core.exporters import ExporterEngine
from vigil.core.exporters import mqtt
from vigil.core.exporters.mqtt import (
    MQTTExporter, Monitor, metric_config, metric_traits, normalize_status, slug, status_configs,
)


class Broker:
    """Records what the fake clients publish and lets a test take the broker down."""

    def __init__(self):
        self.down = False
        self.connects = 0
        self.published = []
        self.subscribed = []
        self.inbox: asyncio.Queue = asyncio.Queue()

    def topics(self):
        return [p[0] for p in self.published]

    def last(self, topic):
        return [p for p in self.published if p[0] == topic][-1]

    def clear(self):
        self.published.clear()

    def drop(self):
        self.inbox.put_nowait(ConnectionError('broker went away'))

    def birth(self, payload='online', retain=False, topic='homeassistant/status'):
        self.inbox.put_nowait(SimpleNamespace(topic=topic, payload=payload.encode(), retain=retain))


class FakeClient:
    def __init__(self, broker):
        self.broker = broker

    async def __aenter__(self):
        if self.broker.down:
            raise ConnectionError('connection refused')
        self.broker.connects += 1
        return self

    async def __aexit__(self, *exc):
        return False

    async def publish(self, topic, payload=None, qos=0, retain=False):
        if self.broker.down:
            raise ConnectionError('not connected')
        self.broker.published.append((topic, payload, qos, retain))

    async def subscribe(self, topic):
        self.broker.subscribed.append(topic)

    @property
    def messages(self):
        return self._messages()

    async def _messages(self):
        while True:
            item = await self.broker.inbox.get()
            if isinstance(item, Exception):
                raise item
            yield item


def _plugin(plugin_id, name=None, target='server.lan'):
    return SimpleNamespace(id=plugin_id, name=name or plugin_id.title(), target=target, children=[])


@pytest.fixture
def broker():
    return Broker()


@pytest.fixture
def mgr(db_manager):
    db_manager.insert_metric('server.lan', 'cpu-mon', 'cpu_pct', 42.5)
    db_manager.insert_metric('server.lan', 'cpu-mon', 'temp_c', 61.0)
    db_manager.insert_metric('nas.lan', 'disk', 'used_pct', 80.0)
    db_manager.insert_status('cpu-mon', 'online')
    db_manager.insert_status('disk', 'warning')
    return db_manager


def _exporter(db, broker, monitors=None, **config):
    exporter = MQTTExporter(db, {'host': 'broker.lan', **config},
                            monitors=lambda: monitors or [],
                            client_factory=lambda: FakeClient(broker))
    exporter.coalesce = 0
    return exporter


async def _settle(predicate, timeout=2.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError('condition never held')
        await asyncio.sleep(0.005)


@pytest.fixture
def fast_backoff(monkeypatch):
    monkeypatch.setattr(mqtt, 'BACKOFF_MIN', 0.01)
    monkeypatch.setattr(mqtt, 'BACKOFF_MAX', 0.02)


class TestNaming:
    def test_slug_keeps_a_single_safe_topic_level(self):
        assert slug('CPU Mon') == 'cpu_mon'
        assert slug('disk:/home') == 'disk_home'
        assert slug('a/b+c#d') == 'a_b_c_d'
        assert slug('keep-dash_and_underscore') == 'keep-dash_and_underscore'
        assert slug('///') == 'unnamed'

    def test_unknown_statuses_read_as_unavailable(self):
        assert normalize_status('warning') == 'warning'
        assert normalize_status('offline') == 'unavailable'
        assert normalize_status(None) == 'unavailable'

    @pytest.mark.parametrize('name, device_class, unit', [
        ('cpu_pct', None, '%'),
        ('progress_percent', None, '%'),
        ('uptime_seconds', 'duration', 's'),
        ('latency_ms', 'duration', 'ms'),
        ('freed_bytes', 'data_size', 'B'),
        ('rss_mb', 'data_size', 'MB'),
        ('avail_gb', 'data_size', 'GB'),
        ('temp_c', 'temperature', '°C'),
        ('cpu_temp_c', 'temperature', '°C'),
        ('signal_dbm', 'signal_strength', 'dBm'),
        ('irq_per_sec', None, '/s'),
        ('containers_total', None, None),
    ])
    def test_metric_traits_follow_the_name(self, name, device_class, unit):
        traits = metric_traits(name)
        assert traits['state_class'] == 'measurement'
        assert traits.get('device_class') == device_class
        assert traits.get('unit_of_measurement') == unit


class TestDiscoveryPayloads:
    monitor = Monitor('cpu-mon', 'CPU', 'server.lan')

    def test_status_sensor_and_problem_sensor(self):
        (s_topic, status), (p_topic, problem) = status_configs('vigil', 'homeassistant', self.monitor)
        assert s_topic == 'homeassistant/sensor/vigil_cpu-mon/status/config'
        assert p_topic == 'homeassistant/binary_sensor/vigil_cpu-mon/problem/config'
        assert status['device_class'] == 'enum'
        assert status['options'] == ['online', 'warning', 'failed', 'unavailable']
        assert status['state_topic'] == problem['state_topic'] == 'vigil/cpu-mon/status'
        assert status['unique_id'] == 'vigil_cpu-mon_status'
        assert problem['unique_id'] == 'vigil_cpu-mon_problem'
        assert problem['device_class'] == 'problem'
        assert status['availability_topic'] == 'vigil/status'

    def test_metric_sensor(self):
        topic, payload = metric_config('vigil', 'homeassistant', self.monitor, 'temp_c')
        assert topic == 'homeassistant/sensor/vigil_cpu-mon/temp_c/config'
        assert payload['state_topic'] == 'vigil/cpu-mon/temp_c'
        assert payload['unique_id'] == 'vigil_cpu-mon_temp_c'
        assert payload['device_class'] == 'temperature'
        assert payload['unit_of_measurement'] == '°C'
        assert payload['name'] == 'CPU temp c'

    def test_one_device_per_target(self):
        other = Monitor('mem', 'Memory', 'server.lan')
        elsewhere = Monitor('disk', 'Disk', 'nas.lan')
        device = lambda m: status_configs('vigil', 'homeassistant', m)[0][1]['device']  # noqa: E731
        assert device(self.monitor) == device(other)
        assert device(self.monitor)['identifiers'] == ['vigil_server_lan']
        assert device(self.monitor)['name'] == 'server.lan'
        assert device(elsewhere)['identifiers'] == ['vigil_nas_lan']

    def test_ids_are_stable_and_follow_the_base_topic(self):
        first = metric_config('vigil', 'homeassistant', self.monitor, 'cpu_pct')
        again = metric_config('vigil', 'homeassistant', self.monitor, 'cpu_pct')
        other = metric_config('lab', 'homeassistant', self.monitor, 'cpu_pct')
        assert first == again
        assert other[1]['unique_id'] == 'lab_cpu-mon_cpu_pct'
        assert other[0] == 'homeassistant/sensor/lab_cpu-mon/cpu_pct/config'


class TestConfig:
    def test_defaults(self, db_manager, broker):
        exporter = _exporter(db_manager, broker)
        assert (exporter.port, exporter.base, exporter.prefix) == (1883, 'vigil', 'homeassistant')
        assert exporter.discovery and exporter.retain
        assert exporter.interval == 0
        assert exporter.client_id.startswith('vigil-')

    def test_tls_moves_the_default_port_and_interval_takes_a_duration(self, db_manager, broker):
        exporter = _exporter(db_manager, broker, tls=True, interval='5m', base_topic='/lab/')
        assert exporter.port == 8883
        assert exporter.interval == 300
        assert exporter.base == 'lab'

    def test_password_file(self, db_manager, broker, tmp_path):
        path = tmp_path / 'pw'
        path.write_text('s3cret\n')
        exporter = _exporter(db_manager, broker, password_file=str(path))
        assert exporter.password == 's3cret'

    def test_the_client_carries_a_last_will(self, db_manager, monkeypatch):
        made = {}
        fake = SimpleNamespace(
            Client=lambda *a, **kw: made.update(args=a, kwargs=kw) or 'client',
            Will=lambda *a, **kw: ('will', a, kw),
            TLSParameters=lambda **kw: ('tls', kw),
        )
        monkeypatch.setitem(sys.modules, 'aiomqtt', fake)
        exporter = MQTTExporter(db_manager, {
            'host': 'broker.lan', 'username': 'u', 'password': 'p', 'client_id': 'vigil-test',
            'tls': {'ca_certs': '/ca.pem', 'insecure': True}})
        assert exporter._client() == 'client'
        assert made['args'] == ('broker.lan', 8883)
        kwargs = made['kwargs']
        assert kwargs['will'] == ('will', ('vigil/status', 'offline'), {'qos': 1, 'retain': True})
        assert (kwargs['username'], kwargs['password'], kwargs['identifier']) == ('u', 'p', 'vigil-test')
        assert kwargs['tls_params'][1]['ca_certs'] == '/ca.pem'
        assert kwargs['tls_insecure'] is True

    def test_missing_library_is_named(self, db_manager, monkeypatch):
        monkeypatch.setitem(sys.modules, 'aiomqtt', None)
        with pytest.raises(ImportError, match=r"vigil\[mqtt\]"):
            MQTTExporter(db_manager, {'host': 'broker.lan'})


class TestPublish:
    async def test_everything_with_discovery(self, mgr, broker):
        exporter = _exporter(mgr, broker, monitors=[_plugin('cpu-mon', 'CPU'), _plugin('idle')])
        await exporter.publish(FakeClient(broker))
        topics = broker.topics()
        assert 'homeassistant/sensor/vigil_cpu-mon/status/config' in topics
        assert 'homeassistant/binary_sensor/vigil_disk/problem/config' in topics
        assert 'homeassistant/sensor/vigil_cpu-mon/temp_c/config' in topics
        assert broker.last('vigil/cpu-mon/status')[1:] == ('online', 0, True)
        assert broker.last('vigil/disk/status')[1] == 'warning'
        assert broker.last('vigil/cpu-mon/cpu_pct')[1] == '42.5'
        assert broker.last('vigil/disk/used_pct')[1] == '80.0'
        # A configured monitor with nothing collected yet still gets its entities.
        assert broker.last('vigil/idle/status')[1] == 'unavailable'

    async def test_names_and_targets_come_from_the_monitor(self, mgr, broker):
        exporter = _exporter(mgr, broker, monitors=[_plugin('cpu-mon', 'CPU', 'box')])
        await exporter.publish(FakeClient(broker))
        status = json.loads(broker.last('homeassistant/sensor/vigil_cpu-mon/status/config')[1])
        assert status['name'] == 'CPU status'
        assert status['device']['name'] == 'box'
        # Without a live monitor the metrics' target names the device.
        disk = json.loads(broker.last('homeassistant/sensor/vigil_disk/status/config')[1])
        assert disk['device']['name'] == 'nas.lan'

    async def test_discovery_goes_out_once_per_connection(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        await exporter.publish(FakeClient(broker))
        broker.clear()
        await exporter.publish(FakeClient(broker))
        assert not [t for t in broker.topics() if t.startswith('homeassistant/')]
        assert 'vigil/cpu-mon/status' in broker.topics()

    async def test_only_the_named_monitors(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        await exporter.publish(FakeClient(broker), {'disk'})
        assert all('cpu-mon' not in t for t in broker.topics())
        assert 'vigil/disk/used_pct' in broker.topics()

    async def test_discovery_off_and_retain_off(self, mgr, broker):
        exporter = _exporter(mgr, broker, discovery=False, retain=False)
        await exporter.publish(FakeClient(broker))
        assert not [t for t in broker.topics() if t.startswith('homeassistant/')]
        assert broker.last('vigil/cpu-mon/status')[3] is False


class TestRun:
    async def test_connect_announces_and_publishes_everything(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        exporter.start()
        try:
            await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
            assert broker.published[0] == ('vigil/status', 'online', 1, True)
            assert broker.subscribed == ['homeassistant/status']
        finally:
            exporter.stop()

    async def test_changes_publish_only_the_changed_monitor_in_one_pass(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        exporter.coalesce = 0.05
        exporter.start()
        try:
            await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
            broker.clear()
            for value in (1.0, 2.0, 3.0):
                mgr.insert_metric('server.lan', 'cpu-mon', 'cpu_pct', value)
            mgr.insert_status('cpu-mon', 'failed')
            await _settle(lambda: 'vigil/cpu-mon/status' in broker.topics())
            await asyncio.sleep(0.1)
            assert broker.topics().count('vigil/cpu-mon/status') == 1
            assert broker.topics().count('vigil/cpu-mon/cpu_pct') == 1
            assert broker.last('vigil/cpu-mon/cpu_pct')[1] == '3.0'
            assert broker.last('vigil/cpu-mon/status')[1] == 'failed'
            assert all('disk' not in t for t in broker.topics())
        finally:
            exporter.stop()

    async def test_a_new_metric_is_announced_before_its_value(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        exporter.start()
        try:
            await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
            broker.clear()
            mgr.insert_metric('nas.lan', 'disk', 'inodes_pct', 12.0)
            await _settle(lambda: 'vigil/disk/inodes_pct' in broker.topics())
            topics = broker.topics()
            config = 'homeassistant/sensor/vigil_disk/inodes_pct/config'
            assert topics.index(config) < topics.index('vigil/disk/inodes_pct')
            assert 'homeassistant/sensor/vigil_disk/used_pct/config' not in topics
        finally:
            exporter.stop()

    async def test_unrelated_changes_are_ignored(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        exporter.start()
        try:
            await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
            broker.clear()
            mgr.insert_event('INFO', 'hello', 'server.lan', 'cpu-mon')
            await asyncio.sleep(0.05)
            assert broker.published == []
        finally:
            exporter.stop()

    async def test_home_assistant_birth_republishes_discovery(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        exporter.start()
        try:
            await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
            broker.clear()
            broker.birth(retain=True)
            broker.birth('offline')
            broker.birth(topic='other/status')
            await asyncio.sleep(0.05)
            assert broker.published == []
            broker.birth()
            await _settle(lambda: 'homeassistant/sensor/vigil_disk/used_pct/config' in broker.topics())
        finally:
            exporter.stop()

    async def test_interval_republishes_everything(self, mgr, broker):
        exporter = _exporter(mgr, broker, discovery=False)
        exporter.interval = 0.02
        exporter.start()
        try:
            await _settle(lambda: broker.topics().count('vigil/disk/status') >= 3)
        finally:
            exporter.stop()

    async def test_stop_says_offline(self, mgr, broker):
        exporter = _exporter(mgr, broker)
        exporter.start()
        await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
        task = exporter._task
        exporter.stop()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert broker.published[-1] == ('vigil/status', 'offline', 1, True)
        mgr.insert_status('disk', 'failed')
        await asyncio.sleep(0.02)
        assert broker.published[-1] == ('vigil/status', 'offline', 1, True)

    async def test_broker_down_retries_without_raising(self, mgr, broker, fast_backoff):
        broker.down = True
        exporter = _exporter(mgr, broker)
        exporter.start()
        try:
            await asyncio.sleep(0.1)
            assert not exporter._task.done()
            assert broker.connects == 0
            mgr.insert_status('disk', 'failed')
            broker.down = False
            await _settle(lambda: 'vigil/disk/status' in broker.topics())
            assert broker.last('vigil/disk/status')[1] == 'failed'
        finally:
            exporter.stop()

    async def test_a_dropped_connection_reconnects_and_republishes(self, mgr, broker, fast_backoff):
        exporter = _exporter(mgr, broker)
        exporter.start()
        try:
            await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
            broker.clear()
            broker.drop()
            await _settle(lambda: broker.connects == 2 and 'vigil/disk/used_pct' in broker.topics())
            assert 'homeassistant/sensor/vigil_disk/used_pct/config' in broker.topics()
            assert broker.published[0] == ('vigil/status', 'online', 1, True)
        finally:
            exporter.stop()

    async def test_a_failed_publish_reconnects(self, mgr, broker, fast_backoff):
        exporter = _exporter(mgr, broker)
        exporter.start()
        try:
            await _settle(lambda: 'vigil/disk/used_pct' in broker.topics())
            broker.down = True
            mgr.insert_status('disk', 'failed')
            await asyncio.sleep(0.05)
            broker.down = False
            await _settle(lambda: broker.connects >= 2 and 'vigil/disk/status' in broker.topics()
                          and broker.last('vigil/disk/status')[1] == 'failed')
        finally:
            exporter.stop()


class TestExporterEngine:
    async def test_starts_and_stops_mqtt(self, db_manager, monkeypatch):
        started = []

        class Stub:
            def __init__(self, db, cfg, monitors=None):
                self.cfg, self.monitors = cfg, monitors
                started.append(self)

            def start(self):
                self.running = True

            def stop(self):
                self.running = False

        monkeypatch.setattr(mqtt, 'MQTTExporter', Stub)
        engine = ExporterEngine(db_manager, {'mqtt': {'host': 'broker.lan'}})
        monitors = lambda: []  # noqa: E731
        engine.start(monitors)
        assert started[0].running and started[0].monitors is monitors
        engine.stop()
        assert not started[0].running

    async def test_missing_library_does_not_stop_the_engine(self, db_manager, monkeypatch, caplog):
        monkeypatch.setitem(sys.modules, 'aiomqtt', None)
        engine = ExporterEngine(db_manager, {'mqtt': {'host': 'broker.lan'}})
        engine.start()
        assert "pip install 'vigil[mqtt]'" in caplog.text
        engine.stop()

    async def test_without_a_host_nothing_starts(self, db_manager):
        engine = ExporterEngine(db_manager, {'mqtt': {'port': 1883}})
        engine.start()
        assert engine._exporters == []
