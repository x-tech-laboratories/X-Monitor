import json
import time

import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.containers import Containers
from x_monitor.core.connectors.types import CmdResult, HttpResult
from x_monitor.core.database.database import db, StatusHistory, Metric


def _latest_status(pid="test-ctr"):
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == pid
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric, name="test-ctr"):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == name) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _cfg(**extra):
    base = {"name": "test-ctr", "id": "test-ctr", "ssh_config": {"host": "test.host"}}
    base.update(extra)
    return base


def _ps(*rows):
    return "".join(f"{name}\t{state}\n" for name, state in rows)


class TestContainersCollection:
    async def test_all_running_online(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running"), ("db", "running")), ""))
        assert _latest_status() == "online"
        assert _latest_metric("containers_running") == pytest.approx(2.0)
        assert _latest_metric("containers_stopped") == pytest.approx(0.0)

    async def test_stopped_container_warning(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running"), ("db", "exited")), ""))
        assert _latest_status() == "warning"
        assert _latest_metric("containers_stopped") == pytest.approx(1.0)

    async def test_stopped_warning_disabled_online(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg(stopped_warning=False))
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running"), ("db", "exited")), ""))
        assert _latest_status() == "online"

    async def test_expected_missing_failed(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg(expect_running=["db"]))
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running"), ("db", "exited")), ""))
        assert _latest_status() == "failed"

    async def test_expected_running_online(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg(expect_running=["web", "db"]))
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running"), ("db", "running")), ""))
        assert _latest_status() == "online"

    async def test_paused_is_benign(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running"), ("job", "paused")), ""))
        assert _latest_status() == "online"

    async def test_no_containers_online(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, "", ""))
        assert _latest_status() == "online"

    async def test_runtime_missing_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(127, "", "bash: docker: command not found"))
        assert _latest_status() == "unavailable"

    async def test_unreachable_host_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(-1, "", "Agent 'h' is not connected"))
        assert _latest_status() == "unavailable"

    async def test_podman_runtime_used(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg(runtime="podman"))
        commands = p.commands()
        assert commands[0].text.startswith("podman ")
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running")), ""))
        assert _latest_status() == "online"


class TestContainersActions:
    async def test_restart_listed_container(self, make_plugin):
        p = make_plugin(Containers, _cfg(expect_running=["web"]))
        plan = p.plan_action("restart:web")
        assert "docker restart" in plan.command and "web" in plan.command
        assert p.interpret_action("restart:web", CmdResult(0, "", "")) is True

    async def test_refuse_unlisted_container(self, make_plugin):
        p = make_plugin(Containers, _cfg(expect_running=["web"]))
        plan = p.plan_action("restart:evil")
        assert plan.success is False
        assert plan.logs

    async def test_actions_list_from_expected(self, make_plugin):
        p = make_plugin(Containers, _cfg(expect_running=["web", "db"]))
        ids = {a["action_id"] for a in p.get_actions()}
        assert ids == {"restart:web", "restart:db"}


NEW = 'sha256:' + 'b' * 64
OLD = 'sha256:' + 'a' * 64
HUB_CHALLENGE = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'


def _inventory(rows, images=(), digests=()):
    """Collection output in the inventory script's shape: ps rows, container images, image digests."""
    out = _ps(*rows) + "@@x-monitor-images\n"
    out += "".join(f"/{name}\t{image}\tsha256:{image_id}\n" for name, image, image_id in images)
    out += "@@x-monitor-digests\n"
    out += "".join(f"sha256:{image_id}\t{' '.join(entries)}\n" for image_id, entries in digests)
    return out


def _nginx(local_digest=OLD, image="nginx:latest"):
    return _inventory([("web", "running")], [("web", image, "i1")], [("i1", [f"nginx@{local_digest}"])])


class FakeHub:
    """Serves one digest per repository behind Docker Hub's anonymous token challenge."""

    def __init__(self, digests=None, fail=False):
        self.digests = digests or {'library/nginx': NEW}
        self.fail = fail
        self.calls = []

    def __call__(self, req):
        self.calls.append(req)
        if self.fail:
            return HttpResult(None, '', error='connection refused')
        if '/token' in req.url:
            return HttpResult(200, json.dumps({'token': 'tok'}))
        if (req.headers or {}).get('Authorization') != 'Bearer tok':
            return HttpResult(401, '', headers={'www-authenticate': HUB_CHALLENGE})
        repo = req.url.split('/v2/', 1)[1].split('/manifests/', 1)[0]
        if repo not in self.digests:
            return HttpResult(404, '')
        return HttpResult(200, '', headers={'docker-content-digest': self.digests[repo]})

    def manifest_calls(self):
        return [c for c in self.calls if '/manifests/' in c.url and 'Authorization' in (c.headers or {})]


async def _check(plugin, run_io_cycle_async, hub):
    plugin.engine.http_fetch_handler = hub
    assert plugin.io_call() is not None
    return await run_io_cycle_async(plugin)


def _rows(plugin):
    return {r['name']: r for r in plugin.data.latest_snapshot(default=[])}


class TestContainersInventory:
    async def test_inventory_command_when_update_checks_on(self, make_plugin):
        p = make_plugin(Containers, _cfg())
        text = p.commands()[0].text
        assert "container inspect" in text and "{{.Config.Image}}" in text
        assert "image inspect" in text and "{{join .RepoDigests" in text
        assert "|| exit" in text and text.endswith("true")

    async def test_podman_reads_image_name(self, make_plugin):
        p = make_plugin(Containers, _cfg(runtime="podman"))
        text = p.commands()[0].text
        assert "{{.ImageName}}" in text and "{{.Config.Image}}" not in text

    async def test_plain_ps_when_update_checks_off(self, make_plugin):
        p = make_plugin(Containers, _cfg(update_check_interval=0))
        assert p.commands()[0].text == "docker ps -a --format '{{.Names}}\t{{.State}}' 2>&1"

    async def test_sampled_only_without_update_checks(self, make_plugin):
        assert make_plugin(Containers, _cfg()).subscriptions() == []
        off = make_plugin(Containers, _cfg(update_check_interval=0))
        assert [s.kind for s in off.subscriptions()] == ['sample']

    async def test_rows_carry_image_and_pending_update(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        result = run_cycle(p, lambda c: CmdResult(0, _nginx(), ""))
        row = _rows(p)['web']
        assert row['image'] == "nginx:latest" and row['state'] == "running"
        assert row['update'] == "Not checked yet"
        assert 'images_update_available' not in result.metrics
        assert _latest_status() == "online"

    async def test_rows_without_update_column_when_off(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg(update_check_interval=0))
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running")), ""))
        assert _rows(p)['web'] == {'name': 'web', 'state': 'running', 'image': '--'}

    async def test_missing_image_sections_tolerated(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running")), ""))
        assert _rows(p)['web']['update'] == "Unknown"
        assert p.io_call() is None

    async def test_pinned_and_local_images_are_not_checked(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        out = _inventory(
            [("pinned", "running"), ("built", "running")],
            [("pinned", f"nginx@{OLD}", "i1"), ("built", "myapp:dev", "i2")],
            [("i1", [f"nginx@{OLD}"]), ("i2", [])],
        )
        run_cycle(p, lambda c: CmdResult(0, out, ""))
        rows = _rows(p)
        assert rows['pinned']['update'] == "Pinned by digest"
        assert rows['built']['update'] == "Local image"
        assert p.io_call() is None


class TestContainersUpdateCheck:
    async def test_update_available(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        result = await _check(p, run_io_cycle_async, FakeHub())
        assert result.metrics['images_update_available'] == 1.0
        assert _latest_metric('images_update_available') == pytest.approx(1.0)
        assert _rows(p)['web']['update'] == "Update available"
        assert _latest_status() == "online"
        assert any('docker.io/library/nginx:latest' in m for m, _ in result.logs)

    async def test_up_to_date(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _nginx(NEW), ""))
        result = await _check(p, run_io_cycle_async, FakeHub())
        assert result.metrics['images_update_available'] == 0.0
        assert _rows(p)['web']['update'] == "Up to date"

    async def test_update_warning_opt_in(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg(update_warning=True))
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        await _check(p, run_io_cycle_async, FakeHub())
        assert _latest_status() == "warning"
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        assert _latest_status() == "warning"

    async def test_expected_missing_stays_failed_on_check_cycle(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg(expect_running=["db"]))
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        await _check(p, run_io_cycle_async, FakeHub())
        assert _latest_status() == "failed"

    async def test_registry_failure_only_logged(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg(update_warning=True))
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        result = await _check(p, run_io_cycle_async, FakeHub(fail=True))
        assert _latest_status() == "online"
        assert result.metrics['images_update_available'] == 0.0
        assert _rows(p)['web']['update'] == "Check failed"
        assert any(level == "WARNING" and 'connection refused' in m for m, level in result.logs)

    async def test_failed_check_keeps_the_last_known_digest(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg(update_check_interval="1s"))
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        await _check(p, run_io_cycle_async, FakeHub())
        p._next_check = 0.0
        await _check(p, run_io_cycle_async, FakeHub(fail=True))
        assert _rows(p)['web']['update'] == "Update available"

    async def test_repull_is_current_without_a_new_check(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        await _check(p, run_io_cycle_async, FakeHub())
        result = run_cycle(p, lambda c: CmdResult(0, _nginx(NEW), ""))
        assert _rows(p)['web']['update'] == "Up to date"
        assert result.metrics['images_update_available'] == 0.0

    async def test_check_waits_for_its_interval(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg(update_check_interval="6h"))
        assert p.io_call() is None
        run_cycle(p, lambda c: CmdResult(0, _nginx(OLD), ""))
        await _check(p, run_io_cycle_async, FakeHub())
        assert p.io_call() is None
        assert p._next_check > time.monotonic() + 5 * 3600
        p._next_check = time.monotonic() - 1
        assert p.io_call() is not None

    async def test_one_lookup_per_distinct_image(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg())
        out = _inventory(
            [("a", "running"), ("b", "exited"), ("c", "running")],
            [("a", "nginx:latest", "i1"), ("b", "docker.io/library/nginx:latest", "i1"),
             ("c", "redis:7", "i2")],
            [("i1", [f"nginx@{OLD}"]), ("i2", [f"redis@{NEW}"])],
        )
        run_cycle(p, lambda c: CmdResult(0, out, ""))
        hub = FakeHub({'library/nginx': NEW, 'library/redis': NEW})
        result = await _check(p, run_io_cycle_async, hub)
        assert len(hub.manifest_calls()) == 2
        assert result.metrics['images_update_available'] == 1.0
        rows = _rows(p)
        assert rows['a']['update'] == rows['b']['update'] == "Update available"
        assert rows['c']['update'] == "Up to date"

    async def test_container_on_an_older_image_than_the_tag(self, make_plugin, run_cycle, run_io_cycle_async):
        p = make_plugin(Containers, _cfg())
        out = _inventory(
            [("old", "running"), ("new", "running")],
            [("old", "nginx:latest", "i1"), ("new", "nginx:latest", "i2")],
            [("i1", [f"nginx@{OLD}"]), ("i2", [f"nginx@{NEW}"])],
        )
        run_cycle(p, lambda c: CmdResult(0, out, ""))
        await _check(p, run_io_cycle_async, FakeHub())
        rows = _rows(p)
        assert rows['old']['update'] == "Update available"
        assert rows['new']['update'] == "Up to date"

    async def test_registry_credentials_from_config(self, make_plugin):
        p = make_plugin(Containers, _cfg(registries={
            'index.docker.io': {'username': 'robot', 'password': 'pw'},
            'registry.example.com:5000': {'username': 'u', 'password_command': 'echo secret',
                                          'insecure': True},
        }))
        assert p.registries['docker.io'].basic == ('robot', 'pw')
        example = p.registries['registry.example.com:5000']
        assert example.basic == ('u', 'secret') and example.insecure

    async def test_ui_spec_update_column_and_card(self, make_plugin):
        on = make_plugin(Containers, _cfg()).UI_SPEC
        assert 'updates_card' in on['cards']
        assert [c['name'] for c in on['tables']['containers']['columns']][-1] == 'update'
        off = make_plugin(Containers, _cfg(update_check_interval=0)).UI_SPEC
        assert 'updates_card' not in off['cards']
        assert 'update' not in [c['name'] for c in off['tables']['containers']['columns']]

    async def test_update_cell_colored_warning(self, make_plugin):
        spec = make_plugin(Containers, _cfg()).UI_SPEC
        rule = spec['tables']['containers']['columns'][-1]['cell_color_by']
        assert rule({'update_state': 'available'}) == 'warning'
        assert rule({'update_state': 'current'}) is None


DOCKER_PRUNE_OUTPUT = """Deleted Containers:
4a7f7eebae0f
1f3b5c2d9e8a

Deleted Networks:
old_default

Deleted Images:
untagged: nginx@sha256:aaaa
deleted: sha256:bbbb
deleted: sha256:cccc

Total reclaimed space: 1.2GB
"""

PODMAN_PRUNE_OUTPUT = """Deleted Containers
4a7f7eebae0f
Deleted Pods
Deleted Images
9f8e7d6c5b4a
Total reclaimed space: 300MB
"""


class TestContainersPrune:
    async def test_default_prune_command(self, make_plugin):
        p = make_plugin(Containers, _cfg())
        plan = p.plan_action("prune")
        assert plan.command == "docker system prune -f 2>&1"
        assert plan.timeout and plan.timeout >= 300

    async def test_prune_flags_from_config(self, make_plugin):
        p = make_plugin(Containers, _cfg(runtime="podman", prune_volumes=True, prune_all_images=True))
        assert p.plan_action("prune").command == "podman system prune -f -a --volumes 2>&1"

    async def test_docker_output_summarised(self, make_plugin):
        p = make_plugin(Containers, _cfg())
        outcome = p.interpret_action("prune", CmdResult(0, DOCKER_PRUNE_OUTPUT, ""))
        assert outcome.success is True
        summary = outcome.metadata['content']
        assert summary == "Reclaimed 1.2GB (containers: 2, networks: 1, images: 2)"
        assert outcome.status is None
        assert outcome.logs == [(f"Ran `docker system prune -f`: {summary}", "INFO")]

    async def test_podman_output_summarised(self, make_plugin):
        p = make_plugin(Containers, _cfg(runtime="podman"))
        outcome = p.interpret_action("prune", CmdResult(0, PODMAN_PRUNE_OUTPUT, ""))
        assert outcome.metadata['content'] == "Reclaimed 300MB (containers: 1, images: 1)"

    async def test_nothing_to_prune(self, make_plugin):
        p = make_plugin(Containers, _cfg())
        outcome = p.interpret_action("prune", CmdResult(0, "Total reclaimed space: 0B\n", ""))
        assert outcome.metadata['content'] == "Reclaimed 0B"

    async def test_failed_prune_logged_without_changing_status(self, make_plugin, run_cycle):
        p = make_plugin(Containers, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _ps(("web", "running")), ""))
        outcome = p.interpret_action("prune", CmdResult(1, "Error response from daemon: a prune operation is already running", ""))
        assert outcome.success is False and outcome.status is None
        assert "already running" in outcome.metadata['content']
        assert outcome.logs[0][1] == "ERROR"
        p.storage.apply(outcome)
        assert _latest_status() == "online"

    async def test_prune_button_confirms_what_it_deletes(self, make_plugin):
        from x_monitor.core.ui.components import _substitute
        p = make_plugin(Containers, _cfg(prune_volumes=True, prune_all_images=True))
        button = p.UI_SPEC['buttons']['tools'][0]
        assert button['id'] == 'prune' and button['color'] == 'negative'
        text = _substitute(button['confirm'], None, p)
        assert "docker system prune -f -a --volumes" in text
        assert "every image no container uses" in text and "every volume" in text
        assert ['tools'] in p.UI_SPEC['layout']

    async def test_default_confirm_names_dangling_images_only(self, make_plugin):
        from x_monitor.core.ui.components import _substitute
        p = make_plugin(Containers, _cfg())
        text = _substitute(p.UI_SPEC['buttons']['tools'][0]['confirm'], None, p)
        assert "dangling images" in text and "volume" not in text


class TestUiSpec:
    async def test_running_and_stopped_containers_are_one_share(self, make_plugin):
        spec = make_plugin(Containers, _cfg()).UI_SPEC
        card = spec['cards']['running_card']
        assert card['kind'] == 'share'
        assert [(p['metric'], p['color']) for p in card['parts']] == [
            ('containers_running', 'online'), ('containers_stopped', 'warning')]
        assert 'stopped_card' not in spec['cards']
        assert all('stopped_card' not in row for row in spec['layout'])
        assert ['containers'] in spec['layout']
