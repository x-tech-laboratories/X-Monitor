"""The overview's fleet sections, built from stand-in monitors and readings: host tiles,
reachability strips, backup ages, deployments and vulnerability findings."""

from types import SimpleNamespace

import pytest

from x_monitor.core.ui.views import fleet


def monitor(monitor_id, name=None, kind='group', children=(), **extra):
    return SimpleNamespace(id=monitor_id, name=name or monitor_id, config={'type': kind},
                           children=list(children), **extra)


def readings(values):
    """A latest-metric reader over {(monitor_id, metric): value}."""
    return lambda monitor_id, name: values.get((monitor_id, name))


@pytest.fixture
def roots():
    heimdall = monitor('heimdall', 'Heimdall', children=[
        monitor('heimdall-up', 'Availability', 'uptime'),
        monitor('heimdall-cpu', 'CPU', 'cpu'),
        monitor('backups', 'Backups', children=[
            monitor('borgmatic', 'Borgmatic', children=[
                monitor('heimdall-disk', 'On Disk', 'borg', max_age=86400),
            ]),
        ]),
        monitor('heimdall-scan', 'Vulnerability Scan', 'vuln_scan'),
        monitor('heimdall-nixos', 'Heimdall', 'nixos_upgrade'),
    ])
    odin = monitor('odin', 'Odin', children=[
        monitor('odin-up', 'Availability', 'uptime'),
        monitor('odin-http', 'Web', 'http'),
    ])
    return [heimdall, odin]


class TestPrimaryRoots:
    def test_every_root_of_the_tree_is_a_host(self):
        engine = SimpleNamespace(plugins=[monitor('a'), monitor('b')])
        assert [r.id for r in fleet.primary_roots(engine)] == ['a', 'b']


class TestLeavesWithPaths:
    def test_each_leaf_carries_the_groups_between_it_and_the_root(self, roots):
        paths = {leaf.id: path for leaf, path in fleet.leaves_with_paths(roots[0])}
        assert paths['heimdall-disk'] == ['Backups', 'Borgmatic']
        assert paths['heimdall-cpu'] == []

    def test_a_leaf_held_by_two_groups_appears_once(self):
        shared = monitor('shared', kind='cpu')
        root = monitor('root', children=[monitor('a', children=[shared]), monitor('b', children=[shared])])
        assert [leaf.id for leaf, _ in fleet.leaves_with_paths(root)] == ['shared']

    def test_a_root_with_no_children_is_its_own_leaf(self):
        lone = monitor('lone', kind='uptime')
        assert [leaf.id for leaf, _ in fleet.leaves_with_paths(lone)] == ['lone']


class TestHostTiles:
    def test_a_host_takes_its_worst_monitors_state(self, roots):
        tiles = fleet.build_host_tiles(roots, {'heimdall-cpu': 'warning', 'heimdall-up': 'failed'})
        assert tiles[0].state == 'failed'

    def test_the_caption_counts_monitors_and_names_only_the_trouble(self, roots):
        statuses = {m: 'online' for m in ('heimdall-up', 'heimdall-cpu', 'heimdall-disk',
                                          'heimdall-scan', 'heimdall-nixos')}
        statuses['heimdall-cpu'] = 'warning'
        assert fleet.build_host_tiles(roots, statuses)[0].caption == '5 monitors · 1 warning'

    def test_a_monitor_with_no_status_yet_counts_as_unavailable(self, roots):
        tile = fleet.build_host_tiles(roots, {'odin-up': 'online'})[1]
        assert tile.counts == {'online': 1, 'warning': 0, 'failed': 0, 'unavailable': 1}


class TestStripRows:
    def test_every_reachability_monitor_gets_a_strip_of_its_up_metric(self, roots):
        rows = fleet.build_strip_rows(roots)
        assert [(r.host, r.name, r.metric) for r in rows] == [
            ('Heimdall', 'Availability', 'up'),
            ('Odin', 'Availability', 'up'),
            ('Odin', 'Web', 'probe_ok'),
        ]


class TestBackupRows:
    def test_a_backup_at_its_max_age_fills_half_its_meter(self, roots):
        rows = fleet.build_backup_rows(roots, {'heimdall-disk': 'online'},
                                       readings({('heimdall-disk', 'last_backup_epoch'): 1000.0}),
                                       now=1000.0 + 86400)
        assert rows[0].percent == pytest.approx(50.0)
        assert rows[0].value_text == '1 Day ago'

    def test_the_label_names_the_host_and_the_tool_that_owns_the_repository(self, roots):
        rows = fleet.build_backup_rows(roots, {}, readings({}), now=0)
        assert rows[0].label == 'Heimdall · Borgmatic › On Disk'

    def test_a_repository_with_no_archive_yet_says_so(self, roots):
        rows = fleet.build_backup_rows(roots, {}, readings({}), now=0)
        assert (rows[0].value_text, rows[0].percent, rows[0].state) == ('No archive yet', 0.0, 'unavailable')


class TestDeployTiles:
    def test_a_deployment_shows_its_generation_and_sync(self, roots):
        tiles = fleet.build_deploy_tiles(roots, {'heimdall-nixos': 'online'}, readings({
            ('heimdall-nixos', 'generation'): 812.0, ('heimdall-nixos', 'up_to_date'): 1.0}))
        assert (tiles[0].name, tiles[0].state, tiles[0].caption) == ('Heimdall', 'online', 'gen 812 · in sync')

    def test_a_pending_reboot_and_drift_are_both_named(self, roots):
        tiles = fleet.build_deploy_tiles(roots, {}, readings({
            ('heimdall-nixos', 'reboot_required'): 1.0, ('heimdall-nixos', 'up_to_date'): 0.0}))
        assert tiles[0].caption == 'reboot pending · drift'

    def test_a_deployment_not_checked_yet_says_so(self, roots):
        assert fleet.build_deploy_tiles(roots, {}, readings({}))[0].caption == 'not checked yet'


class TestFindingRows:
    def test_a_scan_splits_its_findings_and_counts_open_ports(self, roots):
        rows = fleet.build_finding_rows(roots, readings({
            ('heimdall-scan', 'vulnerable'): 1.0, ('heimdall-scan', 'suspected'): 2.0,
            ('heimdall-scan', 'noted'): 9.0, ('heimdall-scan', 'open_ports'): 14.0}))
        assert (rows[0].name, rows[0].vulnerable, rows[0].suspected, rows[0].noted) == ('Heimdall', 1.0, 2.0, 9.0)
        assert rows[0].text == '1 · 2 · 9 · 14 open ports'

    def test_a_scan_not_run_yet_counts_nothing(self, roots):
        assert fleet.build_finding_rows(roots, readings({}))[0].text == '0 · 0 · 0'


class TestReadFleet:
    def test_only_the_sections_on_the_page_are_built(self, roots):
        db = SimpleNamespace(latest_statuses=lambda: {}, latest_metric=lambda *_: None,
                             metric_history=lambda *_a, **_k: [])
        model, _ = fleet.read_fleet(SimpleNamespace(db=db), roots, {'hosts', 'findings'}, [])
        assert set(model) == {'hosts', 'findings'}

    def test_each_strip_reads_its_monitors_up_metric(self, roots):
        asked = []

        def history(monitor_id, metric, limit):
            asked.append((monitor_id, metric, limit))
            return [SimpleNamespace(value=1.0)]

        db = SimpleNamespace(latest_statuses=lambda: {}, latest_metric=lambda *_: None, metric_history=history)
        rows = fleet.build_strip_rows(roots)
        _, histories = fleet.read_fleet(SimpleNamespace(db=db), roots, set(), rows)
        assert histories == [[1.0], [1.0], [1.0]]
        assert asked[2] == ('odin-http', 'probe_ok', fleet.charts.STRIP_CELLS)
