"""The monitor graph: links between views, edge labels, and walks that visit each monitor once."""

from types import SimpleNamespace

from x_monitor.core.coordination.monitor_graph import (
    Link, View, all_monitors, child_label, iter_monitors, parent_ids, resolve_links,
)


def _node(node_id, *children):
    return SimpleNamespace(id=node_id, name=node_id.title(), children=list(children), links={})


def _by_host_and_domain():
    """Two hosts each holding a cpu, and a second view grouping both cpus under one domain."""
    host_a = _node('a', _node('a-cpu'))
    host_b = _node('b', _node('b-cpu'))
    domain = _node('compute', Link('a-cpu', 'A'), Link('b-cpu', 'B'))
    views = [View('By host', [host_a, host_b]), View('By domain', [domain])]
    resolve_links(views)
    return views, host_a, host_b, domain


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
        resolve_links([View('one', [host, domain])])
        assert child_label(domain, host.children[0]) == 'A-Cpu'

    def test_a_link_may_name_a_monitor_defined_later(self):
        domain = _node('compute', Link('a-cpu'))
        host = _node('a', _node('a-cpu'))
        resolve_links([View('one', [domain, host])])
        assert domain.children == host.children

    def test_a_view_root_can_be_a_link(self):
        sensors = _node('sensors')
        second = View('two', [Link('sensors')])
        resolve_links([View('one', [sensors]), second])
        assert second.children == [sensors]

    def test_a_link_to_an_unknown_id_is_dropped(self, caplog):
        domain = _node('compute', Link('nowhere'))
        resolve_links([View('one', [domain])])
        assert domain.children == []
        assert 'nowhere' in caplog.text

    def test_a_link_back_to_an_ancestor_is_dropped_and_definitions_stay(self, caplog):
        leaf = _node('leaf')
        mid = _node('mid', leaf)
        root = _node('root', mid)
        leaf.children.append(Link('root'))
        # A view entering at the leaf must not cost the definition edges their place.
        resolve_links([View('one', [root]), View('two', [Link('leaf')])])
        assert leaf.children == [] and mid.children == [leaf] and root.children == [mid]
        assert 'cycle' in caplog.text

    def test_a_link_to_itself_is_dropped(self):
        group = _node('g', Link('g'))
        resolve_links([View('one', [group])])
        assert group.children == []


class TestWalks:
    def test_a_monitor_held_twice_is_visited_once(self):
        views, *_ = _by_host_and_domain()
        engine = SimpleNamespace(views=views, plugins=views[0].children)
        assert [p.id for p in all_monitors(engine)] == ['a', 'a-cpu', 'b', 'b-cpu', 'compute']

    def test_walks_fall_back_to_the_plugin_list_without_views(self):
        root = _node('root', _node('leaf'))
        assert [p.id for p in all_monitors(SimpleNamespace(plugins=[root]))] == ['root', 'leaf']

    def test_a_monitor_has_every_group_that_holds_it_as_a_parent(self):
        views, *_ = _by_host_and_domain()
        parents = parent_ids(iter_monitors(r for v in views for r in v.children))
        assert parents['a-cpu'] == {'a', 'compute'}
