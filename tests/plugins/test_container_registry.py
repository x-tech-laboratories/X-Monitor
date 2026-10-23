import json

import pytest

from x_monitor.core.connectors.types import HttpResult
from x_monitor.plugins.containers.registry import (
    MANIFEST_ACCEPT, RegistryAuth, check_images, local_digests, parse_challenge,
    parse_reference, remote_digest,
)

pytestmark = pytest.mark.asyncio

NEW = 'sha256:' + 'b' * 64
OLD = 'sha256:' + 'a' * 64
HUB_CHALLENGE = ('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",'
                 'scope="repository:library/nginx:pull"')


class FakeRegistry:
    """Answers manifest requests like a registry behind a bearer-token challenge."""

    def __init__(self, digest=NEW, challenge=HUB_CHALLENGE, token='tok', status=200,
                 head_digest=True):
        self.digest = digest
        self.challenge = challenge
        self.token = token
        self.status = status
        self.head_digest = head_digest
        self.calls = []

    async def __call__(self, req):
        self.calls.append(req)
        if '/token' in req.url:
            return HttpResult(200, json.dumps({'token': self.token}))
        auth = (req.headers or {}).get('Authorization')
        if self.challenge and auth != f'Bearer {self.token}' and req.auth is None:
            return HttpResult(401, '', headers={'www-authenticate': self.challenge})
        if self.status != 200:
            return HttpResult(self.status, '')
        if req.method == 'HEAD' and not self.head_digest:
            return HttpResult(200, '')
        return HttpResult(200, '{}', headers={'docker-content-digest': self.digest})


class TestParseReference:
    @pytest.mark.parametrize('ref, key', [
        ('nginx', 'docker.io/library/nginx:latest'),
        ('nginx:1.25', 'docker.io/library/nginx:1.25'),
        ('someone/app:2', 'docker.io/someone/app:2'),
        ('docker.io/library/nginx:alpine', 'docker.io/library/nginx:alpine'),
        ('index.docker.io/library/nginx', 'docker.io/library/nginx:latest'),
        ('ghcr.io/owner/repo:stable', 'ghcr.io/owner/repo:stable'),
        ('quay.io/prometheus/node-exporter', 'quay.io/prometheus/node-exporter:latest'),
        ('localhost:5000/app', 'localhost:5000/app:latest'),
        ('registry.example.com:5000/team/app:1.2', 'registry.example.com:5000/team/app:1.2'),
    ])
    def test_normalised_key(self, ref, key):
        assert parse_reference(ref).key == key

    def test_docker_hub_api_host(self):
        assert parse_reference('nginx').api_host == 'registry-1.docker.io'
        assert parse_reference('ghcr.io/o/r').api_host == 'ghcr.io'

    def test_digest_pinned(self):
        ref = parse_reference(f'nginx@{OLD}')
        assert ref.digest == OLD and ref.tag is None

    def test_tag_and_digest(self):
        ref = parse_reference(f'nginx:1.25@{OLD}')
        assert ref.digest == OLD and ref.tag == '1.25'

    @pytest.mark.parametrize('ref', ['', '   ', 'a' * 64, 'sha256:' + 'c' * 64])
    def test_not_a_reference(self, ref):
        assert parse_reference(ref) is None


class TestLocalDigests:
    def test_matches_same_repository_in_any_spelling(self):
        ref = parse_reference('nginx:latest')
        entries = [f'nginx@{OLD}', f'docker.io/library/nginx@{NEW}', f'ghcr.io/x/nginx@sha256:{"d" * 64}']
        assert local_digests(entries, ref) == {OLD, NEW}

    def test_other_repository_ignored(self):
        assert local_digests([f'redis@{OLD}'], parse_reference('nginx')) == set()


class TestParseChallenge:
    def test_bearer(self):
        kind, params = parse_challenge(HUB_CHALLENGE)
        assert kind == 'bearer'
        assert params['realm'] == 'https://auth.docker.io/token'
        assert params['service'] == 'registry.docker.io'

    def test_empty(self):
        assert parse_challenge('') == ('', {})


class TestRemoteDigest:
    async def test_anonymous_bearer_flow(self):
        fetch = FakeRegistry()
        found = await remote_digest(fetch, parse_reference('nginx'), None, 5)
        assert found.digest == NEW and found.error is None
        head, token, retry = fetch.calls
        assert head.method == 'HEAD'
        assert head.url == 'https://registry-1.docker.io/v2/library/nginx/manifests/latest'
        assert head.headers['Accept'] == MANIFEST_ACCEPT
        assert 'application/vnd.oci.image.index.v1+json' in MANIFEST_ACCEPT
        assert token.url.startswith('https://auth.docker.io/token?')
        assert 'service=registry.docker.io' in token.url
        assert 'scope=repository%3Alibrary%2Fnginx%3Apull' in token.url
        assert token.auth is None
        assert retry.headers['Authorization'] == 'Bearer tok'

    async def test_scope_built_when_challenge_omits_it(self):
        fetch = FakeRegistry(challenge='Bearer realm="https://ghcr.io/token",service="ghcr.io"')
        await remote_digest(fetch, parse_reference('ghcr.io/owner/repo:1'), None, 5)
        assert 'scope=repository%3Aowner%2Frepo%3Apull' in fetch.calls[1].url

    async def test_credentials_sent_to_token_realm(self):
        fetch = FakeRegistry()
        auth = RegistryAuth('robot', 'secret')
        await remote_digest(fetch, parse_reference('nginx'), auth, 5)
        assert fetch.calls[1].auth == ('robot', 'secret')

    async def test_basic_challenge_retries_with_credentials(self):
        fetch = FakeRegistry(challenge='Basic realm="registry"')
        found = await remote_digest(fetch, parse_reference('registry.example.com/app:1'),
                                    RegistryAuth('u', 'p'), 5)
        assert found.digest == NEW
        assert fetch.calls[-1].auth == ('u', 'p')

    async def test_basic_challenge_without_credentials_is_an_error(self):
        fetch = FakeRegistry(challenge='Basic realm="registry"')
        found = await remote_digest(fetch, parse_reference('registry.example.com/app:1'), None, 5)
        assert found.digest is None and '401' in found.error

    async def test_insecure_registry_uses_http(self):
        fetch = FakeRegistry(challenge=None)
        await remote_digest(fetch, parse_reference('localhost:5000/app'), RegistryAuth(insecure=True), 5)
        assert fetch.calls[0].url == 'http://localhost:5000/v2/app/manifests/latest'

    async def test_get_fallback_when_head_lacks_digest(self):
        fetch = FakeRegistry(head_digest=False)
        found = await remote_digest(fetch, parse_reference('nginx'), None, 5)
        assert found.digest == NEW
        assert fetch.calls[-1].method == 'GET'
        assert fetch.calls[-1].headers['Authorization'] == 'Bearer tok'

    @pytest.mark.parametrize('status, text', [(404, 'not found'), (429, 'rate limit'), (500, 'HTTP 500')])
    async def test_http_errors_named(self, status, text):
        fetch = FakeRegistry(status=status)
        found = await remote_digest(fetch, parse_reference('nginx'), None, 5)
        assert found.digest is None and text in found.error and found.reachable

    async def test_token_failure(self):
        async def fetch(req):
            if '/token' in req.url:
                return HttpResult(403, 'no')
            return HttpResult(401, '', headers={'www-authenticate': HUB_CHALLENGE})
        found = await remote_digest(fetch, parse_reference('nginx'), None, 5)
        assert found.digest is None and 'token request' in found.error

    async def test_token_response_not_json(self):
        async def fetch(req):
            if '/token' in req.url:
                return HttpResult(200, '<html>')
            return HttpResult(401, '', headers={'www-authenticate': HUB_CHALLENGE})
        found = await remote_digest(fetch, parse_reference('nginx'), None, 5)
        assert 'not JSON' in found.error

    async def test_access_token_field_accepted(self):
        async def fetch(req):
            if '/token' in req.url:
                return HttpResult(200, json.dumps({'access_token': 'at'}))
            if (req.headers or {}).get('Authorization') == 'Bearer at':
                return HttpResult(200, '', headers={'docker-content-digest': NEW})
            return HttpResult(401, '', headers={'www-authenticate': HUB_CHALLENGE})
        found = await remote_digest(fetch, parse_reference('nginx'), None, 5)
        assert found.digest == NEW

    async def test_unreachable(self):
        async def fetch(req):
            return HttpResult(None, '', error='connection refused')
        found = await remote_digest(fetch, parse_reference('nginx'), None, 5)
        assert found.reachable is False and 'connection refused' in found.error


class TestCheckImages:
    async def test_unreachable_registry_skips_its_other_images_only(self):
        calls = []

        async def fetch(req):
            calls.append(req.url)
            if 'registry.example.com' in req.url:
                return HttpResult(None, '', error='timeout')
            return HttpResult(200, '', headers={'docker-content-digest': NEW})

        refs = [parse_reference(r) for r in
                ('registry.example.com/a:1', 'registry.example.com/b:1', 'ghcr.io/o/r:1')]
        found = await check_images(fetch, refs, {}, 5)
        assert len([u for u in calls if 'registry.example.com' in u]) == 1
        assert 'skipped' in found['registry.example.com/b:1'].error
        assert found['ghcr.io/o/r:1'].digest == NEW

    async def test_exception_costs_only_its_own_image(self):
        async def fetch(req):
            if 'broken' in req.url:
                raise ValueError('bad header')
            return HttpResult(200, '', headers={'docker-content-digest': NEW})

        refs = [parse_reference('ghcr.io/o/broken:1'), parse_reference('ghcr.io/o/fine:1')]
        found = await check_images(fetch, refs, {}, 5)
        assert 'bad header' in found['ghcr.io/o/broken:1'].error
        assert found['ghcr.io/o/fine:1'].digest == NEW

    async def test_credentials_chosen_by_registry(self):
        fetch = FakeRegistry(challenge='Basic realm="r"')
        auths = {'registry.example.com': RegistryAuth('u', 'p')}
        found = await check_images(fetch, [parse_reference('registry.example.com/app:1')], auths, 5)
        assert found['registry.example.com/app:1'].digest == NEW
