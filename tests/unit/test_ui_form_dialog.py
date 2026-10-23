"""The pure pieces of a form dialog: its select choices, its submitted values and its confirm text."""

from types import SimpleNamespace

from x_monitor.core.ui.components import _substitute, form_options, form_values


class TestFormOptions:
    def test_literal_options(self):
        assert form_options(None, {'name': 'x', 'options': ['a', 'b']}) == ['a', 'b']

    def test_options_from_a_plugin_attribute(self):
        plugin = SimpleNamespace(profiles=['quiet', 'balanced'])
        assert form_options(plugin, {'name': 'x', 'options_attr': 'profiles'}) == ['quiet', 'balanced']

    def test_missing_attribute_offers_nothing(self):
        assert form_options(SimpleNamespace(), {'name': 'x', 'options_attr': 'profiles'}) == []


class TestFormValues:
    def test_text_is_trimmed_and_checkboxes_stay_booleans(self):
        inputs = {'path': SimpleNamespace(value='  /etc  '), 'reboot': SimpleNamespace(value=True),
                  'entry': SimpleNamespace(value=None)}
        assert form_values(inputs) == {'path': '/etc', 'reboot': True, 'entry': ''}


class TestSubstitute:
    def test_plugin_attribute_and_row_field(self):
        plugin = SimpleNamespace(target='host1')
        assert _substitute('Reboot {plugin.target} into {row[entry]}?', {'entry': 'x'}, plugin) == \
            'Reboot host1 into x?'

    def test_missing_attribute_reads_empty(self):
        assert _substitute('[{plugin.nothing}]', None, SimpleNamespace()) == '[]'

    def test_item_form_still_works(self):
        assert _substitute('{plugin[target]}', None, SimpleNamespace(target='host1')) == 'host1'
