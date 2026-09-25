"""Confirmation and dialog-title templates fill in row fields and plugin attributes."""

from types import SimpleNamespace

from vigil.core.ui.components import _substitute


def test_fills_a_plugin_attribute():
    plugin = SimpleNamespace(repo='/srv/backup')
    assert _substitute('Prune {plugin.repo}?', None, plugin) == 'Prune /srv/backup?'


def test_a_missing_plugin_attribute_reads_as_empty():
    assert _substitute('[{plugin.nope}]', None, SimpleNamespace()) == '[]'


def test_fills_a_row_field():
    assert _substitute('Delete {row[name]}?', {'name': 'a1'}, SimpleNamespace()) == 'Delete a1?'
