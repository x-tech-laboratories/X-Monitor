from x_monitor.core.ui.views.overview import _RECENT_EVENT_COLUMNS, _metric_rows


class TestRecentMetricRows:
    def test_a_float_value_is_cut_to_two_decimals(self):
        rows = _metric_rows([{'timestamp': '2026-10-21T22:35:13.509105', 'value': 27.257606506347656}])
        assert rows[0]['value'] == '27.26'

    def test_a_whole_value_shows_no_decimals(self):
        assert _metric_rows([{'timestamp': '', 'value': 20.0}])[0]['value'] == '20'
        assert _metric_rows([{'timestamp': '', 'value': 105}])[0]['value'] == '105'

    def test_a_missing_value_stays_empty(self):
        assert _metric_rows([{'timestamp': '', 'value': None}])[0]['value'] is None

    def test_the_timestamp_is_cut_to_the_second(self):
        rows = _metric_rows([{'timestamp': '2026-10-21T22:35:13.509105', 'value': 1}])
        assert rows[0]['timestamp'] == '2026-10-21 22:35:13'


class TestRecentEventColumns:
    def test_the_message_truncates_so_the_table_fits_its_half_width_column(self):
        message = next(c for c in _RECENT_EVENT_COLUMNS if c['name'] == 'message')
        assert 'halon-cell-truncate' in message['classes']
