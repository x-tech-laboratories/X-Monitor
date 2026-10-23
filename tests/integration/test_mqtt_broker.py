"""MQTT exporter against a real mosquitto broker, skipped when neither mosquitto nor nix is available."""

import asyncio
import contextlib
import json
import shutil
import socket
import subprocess
import time

import pytest

aiomqtt = pytest.importorskip('aiomqtt')

from x_monitor.core.exporters.mqtt import MQTTExporter  # noqa: E402


def _mosquitto_binary():
    found = shutil.which('mosquitto')
    if found:
        return found
    if not shutil.which('nix'):
        return None
    try:
        out = subprocess.run(
            ['nix', 'build', 'nixpkgs#mosquitto', '--no-link', '--print-out-paths'],
            capture_output=True, text=True, timeout=300, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    for path in out.stdout.split():
        if (candidate := shutil.which('mosquitto', path=f'{path}/bin')):
            return candidate
    return None


def _free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@pytest.fixture(scope='module')
def broker_port(tmp_path_factory):
    binary = _mosquitto_binary()
    if not binary:
        pytest.skip('mosquitto is not available')
    port = _free_port()
    conf = tmp_path_factory.mktemp('mosquitto') / 'mosquitto.conf'
    conf.write_text(f'listener {port} 127.0.0.1\nallow_anonymous true\npersistence false\n')
    proc = subprocess.Popen([binary, '-c', str(conf)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 10
    while True:
        with contextlib.suppress(OSError), socket.create_connection(('127.0.0.1', port), 0.2):
            break
        if proc.poll() is not None or time.monotonic() > deadline:
            proc.kill()
            pytest.skip('mosquitto did not start')
        time.sleep(0.05)
    yield port
    proc.terminate()
    proc.wait(timeout=5)


class Watcher:
    """A second client that keeps the latest payload seen on every topic."""

    def __init__(self, port):
        self.port = port
        self.seen = {}
        self._task = None

    async def __aenter__(self):
        ready = asyncio.Event()
        self._task = asyncio.create_task(self._run(ready))
        await asyncio.wait_for(ready.wait(), 5)
        return self

    async def __aexit__(self, *exc):
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task

    async def _run(self, ready):
        async with aiomqtt.Client('127.0.0.1', self.port) as client:
            await client.subscribe('#')
            ready.set()
            async for message in client.messages:
                self.seen[str(message.topic)] = message.payload.decode()

    async def wait_for(self, topic, value=None, timeout=5.0):
        deadline = asyncio.get_running_loop().time() + timeout
        while self.seen.get(topic) is None or (value is not None and self.seen[topic] != value):
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError(f'{topic} never became {value!r}: {self.seen.get(topic)!r}')
            await asyncio.sleep(0.02)
        return self.seen[topic]


@pytest.fixture
def mgr(db_manager):
    db_manager.insert_metric('server.lan', 'cpu-mon', 'cpu_pct', 42.5)
    db_manager.insert_status('cpu-mon', 'online')
    return db_manager


async def test_publishes_discovery_state_and_changes(mgr, broker_port):
    exporter = MQTTExporter(mgr, {'host': '127.0.0.1', 'port': broker_port,
                                  'base_topic': 'x-monitor', 'client_id': 'x-monitor-it'})
    exporter.coalesce = 0.05
    async with Watcher(broker_port) as watch:
        exporter.start()
        try:
            assert await watch.wait_for('x-monitor/status') == 'online'
            assert await watch.wait_for('x-monitor/cpu-mon/cpu_pct') == '42.5'
            config = json.loads(await watch.wait_for(
                'homeassistant/sensor/x-monitor_cpu-mon/cpu_pct/config'))
            assert config['unit_of_measurement'] == '%'
            assert config['device']['name'] == 'server.lan'
            mgr.insert_status('cpu-mon', 'failed')
            await watch.wait_for('x-monitor/cpu-mon/status', 'failed')
        finally:
            task = exporter._task
            exporter.stop()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await watch.wait_for('x-monitor/status', 'offline')


async def test_state_is_retained_for_a_late_subscriber(mgr, broker_port):
    exporter = MQTTExporter(mgr, {'host': '127.0.0.1', 'port': broker_port,
                                  'base_topic': 'late', 'client_id': 'x-monitor-late'})
    exporter.coalesce = 0
    exporter.start()
    try:
        async with Watcher(broker_port) as watch:
            await watch.wait_for('late/cpu-mon/cpu_pct', '42.5')
        async with Watcher(broker_port) as late:
            assert await late.wait_for('late/cpu-mon/cpu_pct') == '42.5'
            assert await late.wait_for('homeassistant/sensor/late_cpu-mon/status/config')
    finally:
        exporter.stop()


async def test_last_will_marks_x_monitor_offline_when_the_connection_dies(mgr, broker_port):
    exporter = MQTTExporter(mgr, {'host': '127.0.0.1', 'port': broker_port,
                                  'base_topic': 'lwt', 'client_id': 'x-monitor-lwt'})
    async with Watcher(broker_port) as watch:
        client = exporter._client()
        await client.__aenter__()
        await client.publish('lwt/status', 'online', qos=1, retain=True)
        await watch.wait_for('lwt/status', 'online')
        # Closing the socket without a DISCONNECT is what a crash looks like to the broker.
        client._client.socket().close()
        await watch.wait_for('lwt/status', 'offline', timeout=10)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(client.__aexit__(None, None, None), 0.5)


async def test_broker_down_does_not_raise(mgr):
    exporter = MQTTExporter(mgr, {'host': '127.0.0.1', 'port': _free_port()})
    exporter.start()
    await asyncio.sleep(0.3)
    assert not exporter._task.done()
    exporter.stop()
