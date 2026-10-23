"""Notifications an agent raises itself while X-Monitor is out of reach: the local socket and when they fire."""

import asyncio
from types import SimpleNamespace

from x_monitor_agent import protocol as proto
from x_monitor_agent.local_notify import LocalNotifier, OfflineAlerts, follow


class TestSocket:
    async def test_a_desktop_agent_following_the_socket_gets_each_frame(self, tmp_path):
        path = str(tmp_path / "notify.sock")
        notifier = LocalNotifier(path)
        await notifier.start()
        received = []

        async def handle(frame):
            received.append(frame)

        follower = asyncio.create_task(follow(path, handle))
        try:
            for _ in range(50):
                if notifier._writers:
                    break
                await asyncio.sleep(0.05)
            await notifier.send(proto.notify("Disk is failed", "body", key="local:disk"))
            await notifier.send({'t': 'ping'})
            for _ in range(50):
                if received:
                    break
                await asyncio.sleep(0.05)
            assert [f['title'] for f in received] == ["Disk is failed"]
        finally:
            follower.cancel()
            notifier.close()


class _Recorder:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


def _alerts(connected):
    statuses = {}
    engine = SimpleNamespace(db=SimpleNamespace(latest_status=lambda pid: statuses[pid]),
                             all_monitors=lambda: [SimpleNamespace(id="disk", name="Disk")])
    recorder = _Recorder()
    alerts = OfflineAlerts(recorder, lambda: engine, lambda: connected[0], "odin")
    return alerts, statuses, recorder


class TestOfflineAlerts:
    async def test_a_change_while_offline_raises_a_notification(self):
        connected = [True]
        alerts, statuses, recorder = _alerts(connected)
        statuses["disk"] = "online"
        alerts.observe("disk")
        connected[0] = False
        statuses["disk"] = "failed"
        alerts.observe("disk")
        await asyncio.sleep(0)
        assert [(f['title'], f['urgency']) for f in recorder.sent] == [("Disk is failed", "critical")]

    async def test_a_recovery_while_offline_is_reported_under_the_same_key(self):
        connected = [False]
        alerts, statuses, recorder = _alerts(connected)
        for status in ("online", "failed", "online"):
            statuses["disk"] = status
            alerts.observe("disk")
        await asyncio.sleep(0)
        assert [f['title'] for f in recorder.sent] == ["Disk is failed", "Disk recovered"]
        assert {f['key'] for f in recorder.sent} == {"local:disk"}

    async def test_while_connected_the_server_notifies_instead(self):
        connected = [True]
        alerts, statuses, recorder = _alerts(connected)
        for status in ("online", "failed"):
            statuses["disk"] = status
            alerts.observe("disk")
        await asyncio.sleep(0)
        assert recorder.sent == []
