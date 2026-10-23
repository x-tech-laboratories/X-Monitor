"""The sidebar tree: a node per place a monitor appears, labelled by the edge that holds it."""

from types import SimpleNamespace

from x_monitor.core.coordination.monitor_graph import Link, resolve_links
from x_monitor.core.ui.sidebar import branch_ids, build_tree_nodes, monitor_for_key


def _node(node_id, *children):
    return SimpleNamespace(id=node_id, name=node_id.title(), children=list(children), links={})


def _engine():
    host = _node('a', _node('a-cpu'))
    domain = _node('compute', Link('a-cpu', 'Host A'), Link('a'))
    db = SimpleNamespace(latest_statuses=lambda: {'a-cpu': 'failed'})
    return SimpleNamespace(plugins=resolve_links([host, domain]), db=db)


def _keys(nodes):
    return [k for n in nodes for k in [n['id'], *_keys(n.get('children') or [])]]


class TestTreeNodes:
    def test_a_monitor_in_two_places_gets_a_distinct_key_in_each(self):
        engine = _engine()
        keys = _keys(build_tree_nodes(engine, engine.plugins))
        assert keys == ['a', 'a/a-cpu', 'compute', 'compute/a-cpu', 'compute/a', 'compute/a/a-cpu']

    def test_each_place_shows_its_own_label_and_the_shared_status(self):
        engine = _engine()
        host, domain = build_tree_nodes(engine, engine.plugins)
        assert host['children'][0]['label'] == 'A-Cpu'
        assert domain['children'][0]['label'] == 'Host A'
        assert host['children'][0]['color'] == domain['children'][0]['color']

    def test_a_key_leads_back_to_its_monitor(self):
        engine = _engine()
        nodes = build_tree_nodes(engine, engine.plugins)
        assert monitor_for_key(nodes, 'compute/a/a-cpu') == 'a-cpu'
        assert monitor_for_key(nodes, 'missing') is None

    def test_branch_keys_cover_every_place(self):
        engine = _engine()
        assert branch_ids(build_tree_nodes(engine, engine.plugins)) == ['a', 'compute', 'compute/a']
