"""The monitor graph: links between groups, edge labels, and walks that visit each monitor once."""

from types import SimpleNamespace

from x_monitor.core.coordination.monitor_graph import (
    Link, all_monitors, child_label, parent_ids, resolve_links,
)


def _node(node_id, *children):
    return SimpleNamespace(id=node_id, name=node_id.title(), children=list(children), links={})


def _by_host_and_domain():
    """Two hosts each holding a cpu, and a second root grouping both cpus under one domain."""
    host_a = _node('a', _node('a-cpu'))
    host_b = _node('b', _node('b-cpu'))
    domain = _node('compute', Link('a-cpu', 'A'), Link('b-cpu', 'B'))
    roots = resolve_links([_node('by-host', host_a, host_b), _node('by-domain', domain)])
    return roots, host_a, host_b, domain


class TestResolveLinks:
    def test_a_link_becomes_the_same_monitor_its_definition_made(self):
        _, host_a, host_b, domain = _by_host_and_domain()
        assert domain.children == [host_a.children[0], host_b.children[0]]

    def test_a_link_labels_only_its_own_edge(self):
        _, host_a, _, domain = _by_host_and_domain()
        cpu = host_a.children[0]
        assert child_label(domain, cpu) == 'A'
        assert child_label(host_a, cpu) == 'A-Cpu'

    def test_a_link_without_a_name_shows_the_monitor_name(self):
        host = _node('a', _node('a-cpu'))
        domain = _node('compute', Link('a-cpu'))
        resolve_links([host, domain])
        assert child_label(domain, host.children[0]) == 'A-Cpu'

    def test_a_link_may_name_a_monitor_defined_later(self):
        domain = _node('compute', Link('a-cpu'))
        host = _node('a', _node('a-cpu'))
        resolve_links([domain, host])
        assert domain.children == host.children

    def test_a_top_level_link_is_dropped(self, caplog):
        sensors = _node('sensors')
        assert resolve_links([sensors, Link('sensors')]) == [sensors]
        assert 'top-level' in caplog.text

    def test_a_link_to_an_unknown_id_is_dropped(self, caplog):
        domain = _node('compute', Link('nowhere'))
        resolve_links([domain])
        assert domain.children == []
        assert 'nowhere' in caplog.text

    def test_a_link_back_to_an_ancestor_is_dropped_and_definitions_stay(self, caplog):
        leaf = _node('leaf')
        mid = _node('mid', leaf)
        root = _node('root', mid)
        leaf.children.append(Link('root'))
        # A group linking to the leaf from elsewhere must not cost the definition edges their place.
        resolve_links([_node('other', Link('leaf')), root])
        assert leaf.children == [] and mid.children == [leaf] and root.children == [mid]
        assert 'cycle' in caplog.text

    def test_a_link_to_itself_is_dropped(self):
        group = _node('g', Link('g'))
        resolve_links([group])
        assert group.children == []


class TestWalks:
    def test_a_monitor_held_twice_is_visited_once(self):
        roots, *_ = _by_host_and_domain()
        engine = SimpleNamespace(plugins=roots)
        assert [p.id for p in all_monitors(engine)] == [
            'by-host', 'a', 'a-cpu', 'b', 'b-cpu', 'by-domain', 'compute']

    def test_a_monitor_has_every_group_that_holds_it_as_a_parent(self):
        roots, *_ = _by_host_and_domain()
        parents = parent_ids(roots)
        assert parents['a-cpu'] == {'a', 'compute'}
