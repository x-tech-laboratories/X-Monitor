"""Container states from `<runtime> ps` over SSH — sampled locally by the
agent on agent-backed hosts — with a restart action for each expected
container, a Prune action, and image update detection. Config: runtime
(docker by default), expect_running, stopped_warning, update_check_interval,
update_warning, registries, prune_volumes, prune_all_images. Any container
named in expect_running that is not running makes the status failed; other
stopped containers are warning when stopped_warning is on, while
created/paused ones count as benign. A missing runtime binary or an
unreachable host reports unavailable rather than failed.

Update detection: the target reports each container's image reference and
its image's RepoDigests, and Vigil itself asks the image's registry for the
tag's current digest on the slower update_check_interval, through an async
io_call that awaits the engine's HTTP connector. A container whose image's
RepoDigests lack that digest has an update available; one pinned by digest or
running a locally built image is unknown. A registry failure is only logged."""

import time
from typing import Any, Dict, List, Optional, Tuple, Union

from vigil.plugins.base.plugin_base import Plugin
from vigil.plugins.base.plugin_helpers import parse_duration, resolve_secret
from vigil.plugins.containers.registry import (
    ImageRef, RegistryAuth, check_images, local_digests, normalise_registry, parse_reference,
)
from vigil.core.connectors.types import ActionPlan, CmdResult, Command, CollectResult

_PS_FMT = "ps -a --format '{{.Names}}\t{{.State}}'"

_IMAGES_MARK = '@@vigil-images'
_DIGESTS_MARK = '@@vigil-digests'

_RUNNING_STATES = {'running', 'up'}
_BENIGN_STATES = {'created', 'paused'}

_DEFAULT_UPDATE_CHECK_INTERVAL = 6 * 3600
_REGISTRY_TIMEOUT = 10.0
_PRUNE_TIMEOUT = 600.0

_UPDATE_TEXT = {
    'available': 'Update available',
    'current': 'Up to date',
    'pinned': 'Pinned by digest',
    'local': 'Local image',
    'pending': 'Not checked yet',
    'error': 'Check failed',
    'unknown': 'Unknown',
}


def _classify_containers(stdout: str):
    """Split the tab-separated name/state ps lines into running, stopped, and benign (created/paused) name lists."""
    running: List[str] = []
    stopped: List[str] = []
    benign: List[str] = []
    for name, state in _ps_rows(stdout):
        state_word = state.split()[0] if state else ''
        if state_word in _RUNNING_STATES:
            running.append(name)
        elif state_word in _BENIGN_STATES:
            benign.append(name)
        else:
            stopped.append(name)
    return running, stopped, benign


def _ps_rows(stdout: str) -> List[Tuple[str, str]]:
    """The (name, lower-cased state) pairs in the ps section's tab-separated lines."""
    rows = []
    for line in stdout.splitlines():
        if '\t' not in line:
            continue
        name, state = line.split('\t', 1)
        name, state = name.strip(), state.strip().lower()
        if name:
            rows.append((name, state))
    return rows


def _split_sections(stdout: str) -> Tuple[str, str, str]:
    """Splits the collection output into its ps, container-image and image-digest sections."""
    sections = {'ps': [], _IMAGES_MARK: [], _DIGESTS_MARK: []}
    current = sections['ps']
    for line in stdout.splitlines():
        if line.strip() in (_IMAGES_MARK, _DIGESTS_MARK):
            current = sections[line.strip()]
            continue
        current.append(line)
    return tuple('\n'.join(sections[k]) for k in ('ps', _IMAGES_MARK, _DIGESTS_MARK))


def _strip_id(image_id: str) -> str:
    return image_id.strip().removeprefix('sha256:')


def _container_images(images: str, digests: str) -> Dict[str, Tuple[str, Tuple[str, ...]]]:
    """Maps each container name to its image reference and that image's RepoDigests."""
    repo_digests: Dict[str, Tuple[str, ...]] = {}
    for line in digests.splitlines():
        image_id, _, entries = line.partition('\t')
        if image_id.strip():
            repo_digests[_strip_id(image_id)] = tuple(entries.split())
    found = {}
    for line in images.splitlines():
        parts = line.split('\t')
        if len(parts) != 3:
            continue
        name, image, image_id = parts
        found[name.strip().lstrip('/')] = (image.strip(), repo_digests.get(_strip_id(image_id), ()))
    return found


class Containers(Plugin):
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.runtime = config.get('runtime', 'docker')
        self.expect_running = set(config.get('expect_running', []) or [])
        self.stopped_warning = bool(config.get('stopped_warning', True))
        self.update_check_interval = parse_duration(
            config.get('update_check_interval', _DEFAULT_UPDATE_CHECK_INTERVAL))
        self.update_warning = bool(config.get('update_warning', False))
        self.registries = _registry_auths(config.get('registries'))
        self.prune_volumes = bool(config.get('prune_volumes', False))
        self.prune_all_images = bool(config.get('prune_all_images', False))
        # The latest parsed ps rows plus each container's image, kept so a registry check can re-judge them.
        self._containers: Optional[List[Dict[str, Any]]] = None
        # Each checked reference's remote digest, kept between checks.
        self._remote: Dict[str, str] = {}
        self._remote_errors: Dict[str, str] = {}
        self._checked = False
        self._next_check = 0.0

    SAMPLED = True

    @property
    def checks_updates(self) -> bool:
        return self.update_check_interval > 0

    def commands(self) -> List[Command]:
        if not self.checks_updates:
            return [Command(f"{self.runtime} {_PS_FMT} 2>&1")]
        return [Command(self._inventory_script())]

    def _inventory_script(self) -> str:
        """The ps listing followed by each container's image reference and image id, then each image's RepoDigests."""
        rt = self.runtime
        image_field = '{{.ImageName}}' if rt == 'podman' else '{{.Config.Image}}'
        return (
            f"{rt} {_PS_FMT} 2>&1 || exit; "
            f"echo {_IMAGES_MARK}; "
            f"ids=$({rt} ps -aq 2>/dev/null); "
            f"[ -z \"$ids\" ] || {rt} container inspect --format '{{{{.Name}}}}\t{image_field}\t{{{{.Image}}}}' $ids 2>/dev/null; "
            f"echo {_DIGESTS_MARK}; "
            f"imgs=$([ -z \"$ids\" ] || {rt} container inspect --format '{{{{.Image}}}}' $ids 2>/dev/null | sort -u); "
            f"[ -z \"$imgs\" ] || {rt} image inspect --format '{{{{.Id}}}}\t{{{{join .RepoDigests \" \"}}}}' $imgs 2>/dev/null; "
            "true"
        )

    def subscriptions(self):
        # Registry checks ride the poll, so a monitor that checks updates is polled rather than sampled.
        if self.checks_updates:
            return []
        return super().subscriptions()

    def parse(self, results: List[CmdResult]) -> CollectResult:
        """Turns the `<runtime> ps` output into a CollectResult with total/running/
        stopped counts and a status where a missing expected container is failed,
        other stopped containers are warning (when stopped_warning), and a missing
        runtime binary or an unreachable host is unavailable."""
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr

        combined = f"{stdout}\n{stderr}".lower()
        if ret != 0 and ('command not found' in combined or 'not found' in combined):
            return CollectResult.unavailable(f"{self.runtime} not installed on target")
        if ret == -1:
            return CollectResult.unavailable(f"'{self.runtime} ps' did not run: {stderr}")
        if ret != 0:
            return CollectResult.failed(f"'{self.runtime} ps' failed: {stderr}")

        ps, images, digests = _split_sections(stdout)
        by_name = _container_images(images, digests)
        self._containers = [
            {'name': name, 'state': state, 'image': by_name.get(name, ('', ()))[0],
             'repo_digests': by_name.get(name, ('', ()))[1]}
            for name, state in _ps_rows(ps)
        ]
        return self._verdict(ps)

    def _verdict(self, ps: str) -> CollectResult:
        """The counts, table rows and status for the latest ps listing, judged with the latest registry check."""
        running, stopped, benign = _classify_containers(ps)
        total = len(running) + len(stopped) + len(benign)
        metrics = {
            'containers_total': float(total),
            'containers_running': float(len(running)),
            'containers_stopped': float(len(stopped)),
        }
        rows = self._rows()
        outdated = sorted({r['image_key'] for r in rows if r.get('update_state') == 'available'})
        if self.checks_updates and self._checked:
            metrics['images_update_available'] = float(len(outdated))
        snapshot = [{k: v for k, v in r.items() if k != 'image_key'} for r in rows]

        if total == 0:
            return CollectResult(metrics=metrics, snapshot=snapshot,
                                 logs=[("No containers found", "INFO")], status='online')

        update_note = f"; image updates available: {', '.join(outdated)}" if outdated else ''
        running_set = set(running)
        missing = sorted(self.expect_running - running_set)
        if missing:
            logs = [(f"Expected containers not running: {', '.join(missing)}", "ERROR")]
            if stopped:
                logs.append((f"Stopped: {', '.join(stopped)}", "WARNING"))
            return CollectResult(metrics=metrics, snapshot=snapshot, logs=logs, status='failed')

        if self.stopped_warning and stopped:
            return CollectResult(
                metrics=metrics, snapshot=snapshot,
                logs=[(f"{len(running)} running, {len(stopped)} stopped: {', '.join(stopped)}{update_note}",
                       "WARNING")],
                status='warning',
            )

        if self.update_warning and outdated:
            return CollectResult(
                metrics=metrics, snapshot=snapshot,
                logs=[(f"{len(running)} running{update_note}", "WARNING")],
                status='warning',
            )

        return CollectResult(
            metrics=metrics, snapshot=snapshot,
            logs=[(f"{len(running)} running, {len(stopped)} stopped, {len(benign)} paused/created{update_note}",
                   "INFO")],
            status='online',
        )

    def _rows(self) -> List[Dict[str, Any]]:
        """One table row per container, with its update verdict when update checks are on."""
        rows = []
        for c in self._containers or []:
            row = {'name': c['name'], 'state': c['state'], 'image': c['image'] or '--'}
            if self.checks_updates:
                ref = parse_reference(c['image'])
                state = self._update_state(ref, c['repo_digests'])
                row['update_state'] = state
                row['update'] = _UPDATE_TEXT[state]
                row['image_key'] = ref.key if ref else ''
            rows.append(row)
        return rows

    def _update_state(self, ref: Optional[ImageRef], repo_digests) -> str:
        """Whether the container's image matches the digest its registry now serves for the tag."""
        if ref is None:
            return 'unknown'
        if ref.digest:
            return 'pinned'
        local = local_digests(repo_digests, ref)
        if not local:
            return 'local'
        remote = self._remote.get(ref.key)
        if remote is None:
            return 'error' if ref.key in self._remote_errors else 'pending'
        return 'current' if remote in local else 'available'

    def _checkable_refs(self) -> List[ImageRef]:
        """The distinct tagged references a registry can be asked about, in first-seen order."""
        refs: Dict[str, ImageRef] = {}
        for c in self._containers or []:
            ref = parse_reference(c['image'])
            if ref is None or ref.digest or ref.key in refs:
                continue
            if local_digests(c['repo_digests'], ref):
                refs[ref.key] = ref
        return list(refs.values())

    def io_call(self):
        # A registry check replaces one poll when due; every other cycle runs the ps command above.
        if not self.checks_updates or self._containers is None or time.monotonic() < self._next_check:
            return None
        refs = self._checkable_refs()
        if not refs:
            return None

        async def _check_registries():
            self._next_check = time.monotonic() + self.update_check_interval
            found = await check_images(self.engine.http_fetch, refs, self.registries, _REGISTRY_TIMEOUT)
            return {'registry_check': found}

        return _check_registries

    def parse_results(self, results: List[Any]) -> CollectResult:
        if results and isinstance(results[0], dict) and 'registry_check' in results[0]:
            return self._parse_registry_check(results[0]['registry_check'])
        return self.parse(results)

    def _parse_registry_check(self, found: Dict[str, Any]) -> CollectResult:
        """Records each looked-up digest and re-judges the last ps listing with them; a failed lookup is logged only."""
        errors = []
        for key, answer in found.items():
            if answer.digest:
                self._remote[key] = answer.digest
                self._remote_errors.pop(key, None)
            else:
                self._remote_errors[key] = answer.error or 'no digest'
                errors.append(answer.error or f"{key}: no digest")
        self._checked = True

        ps = ''.join(f"{c['name']}\t{c['state']}\n" for c in self._containers or [])
        result = self._verdict(ps)
        outdated = int(result.metrics.get('images_update_available', 0))
        checked = len(found) - len(errors)
        logs = [(f"Registry check: {checked} of {len(found)} image(s) checked, {outdated} with an update", "INFO")]
        if errors:
            logs.append((f"Registry check failed for {len(errors)} image(s): {'; '.join(errors)[:500]}", "WARNING"))
        result.logs = logs + result.logs
        return result

    def get_actions(self) -> List[Dict[str, str]]:
        actions = []
        for cname in sorted(self.expect_running):
            actions.append({
                'name': f'Restart {cname}',
                'action_id': f'restart:{cname}',
                'variant': 'primary',
                'icon': 'restart_alt',
            })
        return actions

    def plan_action(self, action_id: str, **kwargs) -> Optional[Union[ActionPlan, CollectResult]]:
        if action_id.startswith('restart:'):
            cname = action_id.split(':', 1)[1]
            if cname not in self.expect_running:
                return CollectResult.failed(f"Refusing to restart unlisted container {cname!r}")
            return ActionPlan(f"{self.runtime} restart {_shquote(cname)}")
        if action_id == 'prune':
            return ActionPlan(f"{self.prune_command} 2>&1", timeout=_PRUNE_TIMEOUT)
        return None

    @property
    def prune_command(self) -> str:
        flags = ['-f']
        if self.prune_all_images:
            flags.append('-a')
        if self.prune_volumes:
            flags.append('--volumes')
        return f"{self.runtime} system prune {' '.join(flags)}"

    @property
    def _prune_confirm(self) -> str:
        images = 'every image no container uses' if self.prune_all_images else 'dangling images'
        volumes = ', every volume no container uses (with its data)' if self.prune_volumes else ''
        text = (f"Run `{self.prune_command}` on {self.target}? It deletes every stopped container, "
                f"unused networks, {images}{volumes} and the build cache. This cannot be undone.")
        # The button's confirm text is a format template, so literal braces are doubled.
        return text.replace('{', '{{').replace('}', '}}')

    def interpret_action(self, action_id: str, result: CmdResult, **kwargs):
        if action_id == 'prune':
            return self._interpret_prune(result)
        if action_id.startswith('restart:') and result.exit_code != 0:
            cname = action_id.split(':', 1)[1]
            return CollectResult.failed(f"Restart of {cname} failed: {result.stderr}")
        return result.exit_code == 0

    def _interpret_prune(self, result: CmdResult) -> CollectResult:
        """Logs the prune's outcome as an event and hands its summary back to show the user; the status is left alone."""
        output = f"{result.stdout}\n{result.stderr}".strip()
        if result.exit_code != 0:
            message = f"Prune failed (exit {result.exit_code}): {output[-300:] or 'no output'}"
            return CollectResult(logs=[(message, "ERROR")], metadata={'content': message}, success=False)
        summary = _prune_summary(output)
        return CollectResult(logs=[(f"Ran `{self.prune_command}`: {summary}", "INFO")],
                             metadata={'content': summary}, success=True)

    @property
    def UI_SPEC(self):
        top = ['host_card', 'total_card', 'running_card', 'stopped_card']
        cards = {
            'total_card': {'metric': 'containers_total', 'title': 'CONTAINERS', 'format': 'int'},
            'running_card': {
                'metric': 'containers_running', 'title': 'RUNNING', 'format': 'int',
                'color': 'containers_always_online',
            },
            'stopped_card': {
                'metric': 'containers_stopped', 'title': 'STOPPED', 'format': 'int',
                'color': 'nonzero_warning',
            },
        }
        columns = [
            {'name': 'name', 'label': 'Container', 'field': 'name', 'sortable': True, 'align': 'left'},
            {'name': 'state', 'label': 'State', 'field': 'state', 'sortable': True, 'align': 'left'},
            {'name': 'image', 'label': 'Image', 'field': 'image', 'sortable': True, 'align': 'left'},
        ]
        if self.checks_updates:
            top.append('updates_card')
            cards['updates_card'] = {'metric': 'images_update_available', 'title': 'IMAGE UPDATES',
                                     'format': 'int', 'color': 'nonzero_warning'}
            columns.append({'name': 'update', 'label': 'Update', 'field': 'update', 'sortable': True,
                            'align': 'left', 'cell_color_by': _update_color})
        return {
            'layout': [top, ['tools'], ['containers'], ['events']],
            'cards': cards,
            'buttons': {
                'tools': [
                    {'id': 'prune', 'label': 'Prune', 'icon': 'delete_sweep', 'color': 'negative',
                     'confirm': self._prune_confirm},
                ],
            },
            'tables': {'containers': {'row_key': 'name', 'columns': columns}},
            'events': True,
        }


def _prune_summary(output: str) -> str:
    """The space a prune reclaimed and how many objects of each kind it deleted, from docker's or podman's report."""
    counts: Dict[str, int] = {}
    section = None
    reclaimed = None
    for raw in output.splitlines():
        line = raw.strip()
        lower = line.lower()
        if not line:
            continue
        if lower.startswith('total reclaimed space'):
            reclaimed = line.split(':', 1)[1].strip() if ':' in line else None
            section = None
        elif lower.startswith('deleted ') and not lower.startswith('deleted: '):
            section = lower[len('deleted '):].rstrip(':').strip()
            counts.setdefault(section, 0)
        elif section and not lower.startswith('untagged:'):
            counts[section] += 1
    text = f"Reclaimed {reclaimed or '0B'}"
    deleted = [f"{kind}: {n}" for kind, n in counts.items() if n]
    return f"{text} ({', '.join(deleted)})" if deleted else text


def _update_color(row: Dict[str, Any]) -> Optional[str]:
    return 'warning' if row.get('update_state') == 'available' else None


def _registry_auths(registries: Optional[Dict[str, Any]]) -> Dict[str, RegistryAuth]:
    """Per-registry credentials from config, keyed by the registry host references name."""
    auths = {}
    for host, entry in (registries or {}).items():
        entry = entry or {}
        auths[normalise_registry(str(host))] = RegistryAuth(
            username=entry.get('username'),
            password=resolve_secret(entry.get('password'), entry.get('password_command')),
            insecure=bool(entry.get('insecure', False)),
        )
    return auths


from vigil.core.ui.spec import register_color_rule


@register_color_rule('containers_always_online')
def _running_color(v):
    return None if v is None else 'online'


def _shquote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"
