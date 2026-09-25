"""Named API tokens: parsing auth.tokens, matching a bearer token, and the scopes the session gate enforces."""

import base64
import logging
from hashlib import sha256

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from vigil.__main__ import main, token_command
from vigil.core.ui.auth import acting_client, register_auth
from vigil.core.ui.tokens import (
    ApiToken, TokenRegistry, bearer_token, build_tokens, config_snippet, hash_token, new_token,
)

READ_TOKEN = "vgl_read-token-for-the-scraper-000"
CONTROL_TOKEN = "vgl_control-token-for-the-ops-box-0"
PUSH_TOKEN = "vgl_push-token-for-the-backup-job-0"

TOKENS = [
    {"name": "prometheus", "scope": "read", "token_hash": hash_token(READ_TOKEN)},
    {"name": "ops", "scope": "control", "token_hash": hash_token(CONTROL_TOKEN)},
    {"name": "backups", "scope": "push", "token_hash": hash_token(PUSH_TOKEN)},
]
AUTH = {"username": "admin", "password": "secret", "session_secret": "test-key", "tokens": TOKENS}


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _make_app(auth_settings: dict) -> FastAPI:
    app = FastAPI()
    register_auth(app, auth_settings)

    @app.get("/")
    def index():
        return {"page": True}

    @app.get("/api/monitors")
    def monitors(request: Request):
        return {"client": acting_client(request)}

    @app.post("/api/monitors/web/poll")
    def poll(request: Request):
        return {"client": acting_client(request)}

    @app.get("/metrics")
    def metrics():
        return "up 1"

    return app


@pytest.fixture
def client():
    return TestClient(_make_app(AUTH), follow_redirects=False)


class TestHashing:
    def test_a_minted_token_is_long_random_and_prefixed(self):
        a, b = new_token(), new_token()
        assert a != b
        assert a.startswith("vgl_") and len(a) >= 40

    def test_the_hash_is_a_labelled_sha256(self):
        assert hash_token("abc") == "sha256:" + sha256(b"abc").hexdigest()

    def test_the_snippet_parses_back_into_the_same_token(self):
        import yaml
        token = new_token()
        snippet = config_snippet('ci "runner"', hash_token(token), "push", ["nightly"])
        registry = build_tokens(yaml.safe_load(snippet)["auth"])
        match = registry.match(token)
        assert match.name == 'ci "runner"'
        assert match.monitors == frozenset({"nightly"})


class TestBearerHeader:
    @pytest.mark.parametrize("header", [None, "", "Bearer", "Bearer   ", "Basic abc", "Token abc"])
    def test_anything_but_a_bearer_header_yields_nothing(self, header):
        assert bearer_token(header) is None

    def test_the_scheme_is_case_insensitive(self):
        assert bearer_token("bearer abc") == "abc"


class TestBuildTokens:
    def test_each_secret_form_is_accepted(self, tmp_path):
        secret_file = tmp_path / "token"
        secret_file.write_text(CONTROL_TOKEN + "\n")
        registry = build_tokens({"tokens": [
            {"name": "a", "scope": "read", "token_hash": hash_token(READ_TOKEN)},
            {"name": "b", "scope": "control", "token_file": str(secret_file)},
            {"name": "c", "scope": "push", "token": PUSH_TOKEN},
        ]})
        assert registry.match(READ_TOKEN).name == "a"
        assert registry.match(CONTROL_TOKEN).name == "b"
        assert registry.match(PUSH_TOKEN).name == "c"

    def test_a_bare_hex_digest_is_accepted(self):
        digest = sha256(READ_TOKEN.encode()).hexdigest().upper()
        registry = build_tokens({"tokens": [{"name": "a", "scope": "read", "token_hash": digest}]})
        assert registry.match(READ_TOKEN).name == "a"

    def test_a_plaintext_token_is_warned_about(self, caplog):
        with caplog.at_level(logging.WARNING):
            build_tokens({"tokens": [{"name": "a", "scope": "read", "token": READ_TOKEN}]})
        assert "plaintext" in caplog.text

    @pytest.mark.parametrize("entry", [
        {"scope": "read", "token_hash": hash_token(READ_TOKEN)},
        {"name": "a", "token_hash": hash_token(READ_TOKEN)},
        {"name": "a", "scope": "admin", "token_hash": hash_token(READ_TOKEN)},
        {"name": "a", "scope": "read", "token_hash": "sha256:nothex"},
        {"name": "a", "scope": "read", "token_hash": "md5:" + "0" * 32},
        {"name": "a", "scope": "read"},
        {"name": "a", "scope": "read", "token": "short"},
        {"name": "a", "scope": "read", "token_file": "/nonexistent/vigil-token"},
        "not-a-mapping",
    ])
    def test_an_unusable_entry_is_skipped(self, entry):
        assert len(build_tokens({"tokens": [entry]})) == 0

    def test_a_second_entry_with_the_same_name_is_skipped(self):
        registry = build_tokens({"tokens": [
            {"name": "a", "scope": "read", "token_hash": hash_token(READ_TOKEN)},
            {"name": "a", "scope": "control", "token_hash": hash_token(CONTROL_TOKEN)},
        ]})
        assert len(registry) == 1
        assert registry.match(CONTROL_TOKEN) is None

    def test_a_second_entry_with_the_same_secret_is_skipped(self):
        registry = build_tokens({"tokens": [
            {"name": "a", "scope": "read", "token_hash": hash_token(READ_TOKEN)},
            {"name": "b", "scope": "control", "token_hash": hash_token(READ_TOKEN)},
        ]})
        assert [t.name for t in registry] == ["a"]

    def test_tokens_that_are_not_a_list_enable_nothing(self):
        assert len(build_tokens({"tokens": {"name": "a"}})) == 0

    def test_no_tokens_block_is_an_empty_registry(self):
        assert len(build_tokens({})) == 0
        assert len(build_tokens(None)) == 0

    def test_monitors_limit_a_push_token(self):
        registry = build_tokens({"tokens": [
            {"name": "a", "scope": "push", "token_hash": hash_token(PUSH_TOKEN), "monitors": ["x"]},
        ]})
        token = registry.match(PUSH_TOKEN)
        assert token.covers_monitor("x")
        assert not token.covers_monitor("y")

    def test_monitors_on_a_read_token_are_ignored(self):
        registry = build_tokens({"tokens": [
            {"name": "a", "scope": "read", "token_hash": hash_token(READ_TOKEN), "monitors": ["x"]},
        ]})
        assert registry.match(READ_TOKEN).monitors is None


class TestScopes:
    def _token(self, scope, monitors=None):
        return ApiToken(name="t", digest=b"", scope=scope, monitors=monitors)

    def test_read_covers_api_and_metrics_gets_only(self):
        token = self._token("read")
        assert token.allows_request("GET", "/api/monitors")
        assert token.allows_request("HEAD", "/metrics")
        assert not token.allows_request("POST", "/api/monitors/x/poll")

    def test_control_covers_writes_too(self):
        token = self._token("control")
        assert token.allows_request("GET", "/api/monitors")
        assert token.allows_request("POST", "/api/notifications/mail/test")

    @pytest.mark.parametrize("scope", ["read", "control", "push"])
    def test_no_scope_reaches_the_dashboard(self, scope):
        token = self._token(scope)
        assert not token.allows_request("GET", "/")
        assert not token.allows_request("GET", "/_nicegui/client")

    def test_push_reaches_no_api_route_through_the_gate(self):
        assert not self._token("push").allows_request("GET", "/api/monitors")

    def test_only_a_push_token_covers_a_monitor(self):
        assert self._token("push").covers_monitor("any")
        assert not self._token("control").covers_monitor("any")

    def test_match_ignores_unknown_and_empty_tokens(self):
        registry = build_tokens(AUTH)
        assert registry.match("vgl_not-a-configured-token") is None
        assert registry.match("") is None
        assert registry.match(None) is None
        assert len(TokenRegistry()) == 0


class TestGate:
    def test_a_read_token_opens_the_api(self, client):
        resp = client.get("/api/monitors", headers=_bearer(READ_TOKEN))
        assert resp.status_code == 200
        assert resp.json() == {"client": "token 'prometheus'"}

    def test_a_read_token_opens_metrics(self, client):
        assert client.get("/metrics", headers=_bearer(READ_TOKEN)).status_code == 200

    def test_a_read_token_cannot_write(self, client):
        resp = client.post("/api/monitors/web/poll", headers=_bearer(READ_TOKEN))
        assert resp.status_code == 403
        assert "prometheus" in resp.json()["error"]

    def test_a_control_token_can_write_and_is_named(self, client):
        resp = client.post("/api/monitors/web/poll", headers=_bearer(CONTROL_TOKEN))
        assert resp.status_code == 200
        assert resp.json() == {"client": "token 'ops'"}

    def test_a_push_token_cannot_read_the_api(self, client):
        assert client.get("/api/monitors", headers=_bearer(PUSH_TOKEN)).status_code == 403

    def test_an_unknown_token_is_401_without_a_prompt(self, client):
        resp = client.get("/api/monitors", headers=_bearer("vgl_wrong-token-entirely-000000"))
        assert resp.status_code == 401
        assert "www-authenticate" not in resp.headers

    def test_a_token_never_opens_the_dashboard(self, client):
        resp = client.get("/", headers={**_bearer(CONTROL_TOKEN), "Accept": "text/html"})
        assert resp.status_code == 403

    def test_basic_still_works_and_names_the_account(self, client):
        basic = base64.b64encode(b"admin:secret").decode()
        resp = client.get("/api/monitors", headers={"Authorization": f"Basic {basic}"})
        assert resp.json() == {"client": "admin"}

    def test_a_session_cookie_names_the_account(self, client):
        import re
        page = client.get("/login")
        csrf = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
        client.post("/login", data={"username": "admin", "password": "secret", "csrf": csrf})
        assert client.get("/api/monitors").json() == {"client": "admin"}

    def test_a_control_write_is_logged_with_the_token_name(self, client, caplog):
        with caplog.at_level(logging.INFO):
            client.post("/api/monitors/web/poll", headers=_bearer(CONTROL_TOKEN))
        assert "token 'ops' POST /api/monitors/web/poll" in caplog.text

    def test_tokens_without_an_account_leave_auth_off_with_a_warning(self, caplog):
        with caplog.at_level(logging.WARNING):
            app = _make_app({"tokens": TOKENS})
        assert "no effect" in caplog.text
        assert TestClient(app).get("/api/monitors").json() == {"client": None}


class TestTokenCommand:
    def test_it_prints_a_token_and_a_matching_config_entry(self, capsys):
        import yaml
        assert token_command(["new", "grafana", "--scope", "read"]) == 0
        out = capsys.readouterr().out
        token = next(w for w in out.split() if w.startswith("vgl_"))
        snippet = out[out.index("auth:"):]
        assert build_tokens(yaml.safe_load(snippet)["auth"]).match(token).scope == "read"

    def test_monitors_are_only_for_push_tokens(self, capsys):
        with pytest.raises(SystemExit):
            token_command(["new", "grafana", "--scope", "read", "--monitor", "x"])

    def test_an_unknown_scope_is_refused(self, capsys):
        with pytest.raises(SystemExit):
            token_command(["new", "grafana", "--scope", "admin"])

    def test_main_dispatches_the_subcommand(self, capsys):
        with pytest.raises(SystemExit) as exit_info:
            main(["token", "new", "ci", "--scope", "push", "--monitor", "nightly"])
        assert exit_info.value.code == 0
        assert 'monitors: ["nightly"]' in capsys.readouterr().out
