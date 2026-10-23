"""The API's control routes and the push endpoint's two credentials, with the audit trail each one leaves."""

from types import SimpleNamespace
from typing import Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from x_monitor.core.ui.api import register_api
from x_monitor.core.ui.auth import register_auth
from x_monitor.core.ui.tokens import build_tokens, hash_token

CONTROL_TOKEN = "vgl_control-token-for-the-ops-box-0"
PUSH_ALL = "vgl_push-token-for-every-monitor-00"
PUSH_NIGHTLY = "vgl_push-token-for-nightly-only-000"

AUTH = {
    "username": "admin", "password": "secret", "session_secret": "test-key",
    "tokens": [
        {"name": "ops", "scope": "control", "token_hash": hash_token(CONTROL_TOKEN)},
        {"name": "all-pushes", "scope": "push", "token_hash": hash_token(PUSH_ALL)},
        {"name": "nightly-job", "scope": "push", "token_hash": hash_token(PUSH_NIGHTLY),
         "monitors": ["nightly"]},
    ],
}


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class FakePush:
    """Satisfies PushablePlugin and remembers each heartbeat."""

    def __init__(self, plugin_id: str, token: Optional[str] = "monitor-secret"):
        self.id = plugin_id
        self.name = plugin_id
        self.config = {"type": "push"}
        self.children = []
        self.token = token
        self.pushes = []

    def record_push(self, status, msg=None, value=None, source=None):
        self.pushes.append({"status": status, "msg": msg, "value": value, "source": source})
        return True


class FakeMonitor:
    """A monitor with one header action, recording what the API asked of it."""

    def __init__(self, plugin_id: str, fail: bool = False):
        self.id = plugin_id
        self.name = plugin_id
        self.config = {"type": "systemd_service"}
        self.children = []
        self.polls = 0
        self.actions = []
        self._fail = fail

    def get_actions(self):
        return [{"action_id": "restart", "name": "Restart"}]

    async def run_cycle(self):
        self.polls += 1
        return True

    async def run_action(self, action_id, **kwargs):
        if self._fail:
            raise RuntimeError("ssh went away")
        self.actions.append((action_id, kwargs))
        return True, "restarted"


def _engine(plugins):
    applied = []
    db = SimpleNamespace(latest_statuses=lambda: {}, latest_metrics=lambda: [],
                         recent_events=lambda **kw: [])
    return SimpleNamespace(plugins=plugins, db=db, applied=applied,
                           apply=lambda plugin, result: applied.append((plugin.id, result)),
                           notifications=SimpleNamespace(channels={}))


def _client(plugins, auth_settings=AUTH):
    engine = _engine(plugins)
    app = FastAPI()
    tokens = build_tokens(auth_settings)
    register_auth(app, auth_settings, tokens)
    register_api(app, engine, tokens)
    return TestClient(app, follow_redirects=False), engine


def _audit_messages(engine):
    return [message for _, result in engine.applied for message, _ in result.logs]


class TestPushWithTheMonitorToken:
    def test_the_per_monitor_token_still_works(self):
        plugin = FakePush("nightly")
        client, _ = _client([plugin])
        resp = client.get("/api/push/nightly/monitor-secret?status=down&msg=full")
        assert resp.json() == {"success": True}
        assert plugin.pushes == [{"status": "down", "msg": "full", "value": None, "source": None}]

    def test_a_wrong_per_monitor_token_is_401(self):
        client, _ = _client([FakePush("nightly")])
        assert client.get("/api/push/nightly/nope").status_code == 401

    def test_a_named_token_in_the_path_is_not_accepted(self):
        client, _ = _client([FakePush("nightly")])
        assert client.get(f"/api/push/nightly/{PUSH_ALL}").status_code == 401


class TestPushWithABearerToken:
    def test_a_push_token_records_a_heartbeat_named_after_it(self):
        plugin = FakePush("nightly", token=None)
        client, _ = _client([plugin])
        resp = client.post("/api/push/nightly?value=3", headers=_bearer(PUSH_ALL))
        assert resp.json() == {"success": True}
        assert plugin.pushes[0]["source"] == "token 'all-pushes'"
        assert plugin.pushes[0]["value"] == 3.0

    def test_a_limited_token_reaches_its_own_monitor(self):
        plugin = FakePush("nightly")
        client, _ = _client([plugin])
        assert client.get("/api/push/nightly", headers=_bearer(PUSH_NIGHTLY)).status_code == 200
        assert plugin.pushes[0]["source"] == "token 'nightly-job'"

    def test_a_limited_token_is_refused_elsewhere(self):
        plugin = FakePush("weekly")
        client, _ = _client([plugin])
        resp = client.get("/api/push/weekly", headers=_bearer(PUSH_NIGHTLY))
        assert resp.status_code == 403
        assert plugin.pushes == []

    def test_a_control_token_cannot_push(self):
        client, _ = _client([FakePush("nightly")])
        assert client.get("/api/push/nightly", headers=_bearer(CONTROL_TOKEN)).status_code == 403

    def test_no_or_an_unknown_token_is_401(self):
        client, _ = _client([FakePush("nightly")])
        assert client.get("/api/push/nightly").status_code == 401
        assert client.get("/api/push/nightly", headers=_bearer("vgl_unknown-000000000")).status_code == 401

    def test_a_bad_status_is_400(self):
        client, _ = _client([FakePush("nightly")])
        assert client.get("/api/push/nightly?status=sideways", headers=_bearer(PUSH_ALL)).status_code == 400

    def test_a_monitor_that_is_not_a_push_monitor_is_404(self):
        client, _ = _client([FakeMonitor("web")])
        assert client.get("/api/push/web", headers=_bearer(PUSH_ALL)).status_code == 404

    def test_push_tokens_work_with_auth_off(self):
        plugin = FakePush("nightly")
        client, _ = _client([plugin], {"tokens": AUTH["tokens"]})
        assert client.get("/api/push/nightly", headers=_bearer(PUSH_ALL)).status_code == 200


class TestControlRoutes:
    def test_poll_runs_a_cycle_and_audits_the_token(self):
        plugin = FakeMonitor("web")
        client, engine = _client([plugin])
        resp = client.post("/api/monitors/web/poll", headers=_bearer(CONTROL_TOKEN))
        assert resp.json() == {"polled": True}
        assert plugin.polls == 1
        assert _audit_messages(engine) == ["Poll requested through the API by token 'ops'"]

    def test_an_action_runs_and_audits_the_token(self):
        plugin = FakeMonitor("web")
        client, engine = _client([plugin])
        resp = client.post("/api/monitors/web/actions/restart", headers=_bearer(CONTROL_TOKEN))
        assert resp.json() == {"success": True, "content": "restarted"}
        assert plugin.actions == [("restart", {})]
        assert _audit_messages(engine) == ["Action 'restart' requested through the API by token 'ops'"]

    def test_an_undeclared_action_is_404(self):
        plugin = FakeMonitor("web")
        client, engine = _client([plugin])
        resp = client.post("/api/monitors/web/actions/rm-rf", headers=_bearer(CONTROL_TOKEN))
        assert resp.status_code == 404
        assert plugin.actions == [] and engine.applied == []

    def test_an_unknown_monitor_is_404(self):
        client, _ = _client([])
        assert client.post("/api/monitors/nope/poll", headers=_bearer(CONTROL_TOKEN)).status_code == 404
        assert client.post("/api/monitors/nope/actions/restart",
                           headers=_bearer(CONTROL_TOKEN)).status_code == 404

    def test_a_failing_action_is_a_500_with_the_error(self):
        client, _ = _client([FakeMonitor("web", fail=True)])
        resp = client.post("/api/monitors/web/actions/restart", headers=_bearer(CONTROL_TOKEN))
        assert resp.status_code == 500
        assert resp.json() == {"success": False, "error": "ssh went away"}

    def test_basic_credentials_audit_the_account(self):
        client, engine = _client([FakeMonitor("web")])
        resp = client.post("/api/monitors/web/poll", auth=("admin", "secret"))
        assert resp.status_code == 200
        assert _audit_messages(engine) == ["Poll requested through the API by admin"]

    def test_with_auth_off_the_audit_names_no_one(self):
        client, engine = _client([FakeMonitor("web")], {})
        assert client.post("/api/monitors/web/poll").status_code == 200
        assert _audit_messages(engine) == ["Poll requested through the API"]

    def test_the_detail_route_lists_the_actions(self):
        client, _ = _client([FakeMonitor("web")])
        body = client.get("/api/monitors/web", headers=_bearer(CONTROL_TOKEN)).json()
        assert body["actions"] == ["restart"]


@pytest.mark.parametrize("path", ["/api/monitors/web/poll", "/api/monitors/web/actions/restart"])
def test_control_routes_need_credentials(path):
    client, _ = _client([FakeMonitor("web")])
    assert client.post(path).status_code == 401
