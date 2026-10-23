"""Image references and the registry lookup behind the containers plugin's
update detection. parse_reference() reads an image reference the way docker
does (Docker Hub's `library/` prefix included); remote_digest() asks the
registry's v2 API for a tag's current manifest digest, answering a 401 with
the anonymous or credentialed bearer-token flow its challenge names. Every
request goes through the engine's HTTP connector via the fetch callable."""

import json
import re
from dataclasses import dataclass, replace
from typing import Awaitable, Callable, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urlencode

from x_monitor.core.connectors.types import HttpRequest, HttpResult

DOCKER_HUB = 'docker.io'
_DOCKER_HUB_API = 'registry-1.docker.io'
_DOCKER_HUB_ALIASES = {'docker.io', 'index.docker.io', 'registry-1.docker.io'}

# A tag may point at a multi-arch index or a single manifest, so every kind is accepted.
MANIFEST_ACCEPT = ', '.join((
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
))

_IMAGE_ID = re.compile(r'^(sha256:)?[0-9a-f]{64}$')
_CHALLENGE_PARAM = re.compile(r'(\w+)="([^"]*)"')

Fetch = Callable[[HttpRequest], Awaitable[HttpResult]]


@dataclass(frozen=True)
class ImageRef:
    registry: str
    repository: str
    tag: Optional[str]
    digest: Optional[str]

    @property
    def name(self) -> str:
        """The registry and repository, the part RepoDigests entries share with the reference."""
        return f"{self.registry}/{self.repository}"

    @property
    def key(self) -> str:
        """The normalised reference, used to cache one lookup per tag."""
        if self.digest:
            return f"{self.name}@{self.digest}"
        return f"{self.name}:{self.tag}"

    @property
    def api_host(self) -> str:
        return _DOCKER_HUB_API if self.registry == DOCKER_HUB else self.registry


@dataclass(frozen=True)
class RegistryAuth:
    username: Optional[str] = None
    password: Optional[str] = None
    insecure: bool = False

    @property
    def basic(self) -> Optional[Tuple[str, str]]:
        return (self.username, self.password or '') if self.username else None


@dataclass(frozen=True)
class RemoteDigest:
    digest: Optional[str] = None
    error: Optional[str] = None
    reachable: bool = True


def normalise_registry(host: str) -> str:
    """A registry host as references name it, with Docker Hub's aliases folded to docker.io."""
    host = host.strip().lower()
    return DOCKER_HUB if host in _DOCKER_HUB_ALIASES else host


def parse_reference(ref: str) -> Optional[ImageRef]:
    """Parses `[registry/]repo[:tag][@digest]`, or returns None for a bare image id or an empty string."""
    ref = (ref or '').strip()
    if not ref or _IMAGE_ID.match(ref):
        return None
    digest = None
    if '@' in ref:
        ref, digest = ref.split('@', 1)
    tag = None
    if ':' in ref.rsplit('/', 1)[-1]:
        ref, tag = ref.rsplit(':', 1)
    first, sep, rest = ref.partition('/')
    if sep and ('.' in first or ':' in first or first == 'localhost'):
        registry, repository = normalise_registry(first), rest
    else:
        registry, repository = DOCKER_HUB, ref
    if registry == DOCKER_HUB and '/' not in repository:
        repository = f"library/{repository}"
    if not repository:
        return None
    if tag is None and digest is None:
        tag = 'latest'
    return ImageRef(registry, repository.lower(), tag, digest)


def local_digests(repo_digests: Iterable[str], ref: ImageRef) -> Set[str]:
    """The manifest digests an image's RepoDigests record for the same repository as `ref`."""
    digests = set()
    for entry in repo_digests:
        parsed = parse_reference(entry)
        if parsed and parsed.digest and parsed.name == ref.name:
            digests.add(parsed.digest)
    return digests


def parse_challenge(header: str) -> Tuple[str, Dict[str, str]]:
    """Splits a WWW-Authenticate header into its lower-cased scheme and its quoted parameters."""
    scheme, _, rest = (header or '').strip().partition(' ')
    return scheme.lower(), dict(_CHALLENGE_PARAM.findall(rest))


async def _bearer_token(fetch: Fetch, params: Dict[str, str], ref: ImageRef,
                        auth: Optional[RegistryAuth], timeout: float) -> Tuple[Optional[str], Optional[str]]:
    """Returns (token, error) from the realm a bearer challenge names."""
    realm = params['realm']
    query = {'service': params.get('service'),
             'scope': params.get('scope') or f"repository:{ref.repository}:pull"}
    joiner = '&' if '?' in realm else '?'
    url = realm + joiner + urlencode({k: v for k, v in query.items() if v})
    resp = await fetch(HttpRequest(url, auth=auth.basic if auth else None, timeout=timeout))
    if resp.status_code != 200:
        why = resp.error if resp.status_code is None else f"HTTP {resp.status_code}"
        return None, f"token request for {ref.key} failed: {why}"
    try:
        body = json.loads(resp.text)
    except ValueError:
        return None, f"token response for {ref.key} was not JSON"
    token = (body.get('token') or body.get('access_token')) if isinstance(body, dict) else None
    if not token:
        return None, f"token response for {ref.key} carried no token"
    return token, None


async def remote_digest(fetch: Fetch, ref: ImageRef, auth: Optional[RegistryAuth],
                        timeout: float) -> RemoteDigest:
    """The digest the registry serves for `ref`'s tag now, read from a HEAD's
    Docker-Content-Digest header, with a GET as fallback for registries that
    leave it off a HEAD."""
    scheme = 'http' if auth and auth.insecure else 'https'
    url = f"{scheme}://{ref.api_host}/v2/{ref.repository}/manifests/{ref.tag}"
    request = HttpRequest(url, method='HEAD', headers={'Accept': MANIFEST_ACCEPT}, timeout=timeout)
    resp = await fetch(request)
    if resp.status_code == 401:
        kind, params = parse_challenge(resp.headers.get('www-authenticate', ''))
        if kind == 'bearer' and params.get('realm'):
            token, error = await _bearer_token(fetch, params, ref, auth, timeout)
            if token is None:
                return RemoteDigest(error=error)
            request = replace(request, headers={**request.headers, 'Authorization': f"Bearer {token}"})
            resp = await fetch(request)
        elif kind == 'basic' and auth and auth.basic:
            request = replace(request, auth=auth.basic)
            resp = await fetch(request)
    if resp.status_code is None:
        return RemoteDigest(error=f"{ref.api_host} unreachable: {resp.error}", reachable=False)
    if resp.status_code == 200 and not resp.headers.get('docker-content-digest'):
        resp = await fetch(replace(request, method='GET'))
    if resp.status_code != 200:
        return RemoteDigest(error=f"{ref.key}: {_http_problem(resp.status_code)}")
    digest = resp.headers.get('docker-content-digest')
    if not digest:
        return RemoteDigest(error=f"{ref.key}: registry sent no Docker-Content-Digest")
    return RemoteDigest(digest=digest)


def _http_problem(status: Optional[int]) -> str:
    if status == 401:
        return "registry refused access (HTTP 401): the repository is private or missing; set credentials under registries"
    if status == 404:
        return "tag not found in the registry (HTTP 404)"
    if status == 429:
        return "registry rate limit reached (HTTP 429)"
    return f"registry answered HTTP {status}"


async def check_images(fetch: Fetch, refs: List[ImageRef], auths: Dict[str, RegistryAuth],
                       timeout: float) -> Dict[str, RemoteDigest]:
    """Looks up each reference in turn, keyed by ImageRef.key, skipping the rest
    of a registry's references once it proves unreachable."""
    results: Dict[str, RemoteDigest] = {}
    down: Set[str] = set()
    for ref in refs:
        if ref.registry in down:
            results[ref.key] = RemoteDigest(error=f"{ref.api_host} unreachable, skipped", reachable=False)
            continue
        # One malformed registry answer must not cost the other images their check.
        try:
            found = await remote_digest(fetch, ref, auths.get(ref.registry), timeout)
        except Exception as e:
            found = RemoteDigest(error=f"{ref.key}: {type(e).__name__}: {e}")
        if not found.reachable:
            down.add(ref.registry)
        results[ref.key] = found
    return results
