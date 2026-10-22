"""The pure geometry behind the chart widgets: how full a bar is, which strip cells are up,
how a whole splits into shares, and how several histories line up on one axis."""

import pytest

from x_monitor.core.ui import charts
from x_monitor.core.ui.theme import STATUS_COLORS


class TestFillPercent:
    def test_a_value_is_its_share_of_the_maximum(self):
        assert charts.fill_percent(54, maximum=80) == pytest.approx(67.5)

    def test_a_value_past_the_maximum_fills_the_bar_and_no_further(self):
        assert charts.fill_percent(140) == 100.0

    def test_a_negative_value_leaves_the_bar_empty(self):
        assert charts.fill_percent(-3) == 0.0

    def test_no_reading_leaves_the_bar_empty(self):
        assert charts.fill_percent(None) == 0.0

    def test_a_zero_maximum_leaves_the_bar_empty_rather_than_dividing_by_zero(self):
        assert charts.fill_percent(5, maximum=0) == 0.0


class TestColorFor:
    def test_a_status_name_takes_its_status_color(self):
        assert charts.color_for('warning') == STATUS_COLORS['warning']

    def test_a_named_series_color_takes_its_token(self):
        assert charts.color_for('series-2') == 'var(--series-2)'

    def test_no_name_falls_back_to_the_accent(self):
        assert charts.color_for(None) == 'var(--accent)'


class TestGaugeStyle:
    def test_the_arc_fills_its_share_of_the_sweep(self):
        style = charts.gauge_style(50, 'red')
        assert 'red 0deg 135.0deg' in style

    def test_the_arc_opens_at_the_bottom(self):
        assert 'from 225deg' in charts.gauge_style(0, 'red')

    def test_the_gap_below_the_sweep_stays_clear(self):
        assert 'transparent 270deg' in charts.gauge_style(100, 'red')


class TestStripStates:
    def test_readings_above_the_line_are_up_and_the_rest_down(self):
        assert charts.strip_states([1, 0, 1], cells=3) == ['online', 'failed', 'online']

    def test_a_short_history_is_padded_at_its_old_end(self):
        assert charts.strip_states([1], cells=3) == ['unavailable', 'unavailable', 'online']

    def test_only_the_newest_cells_are_kept(self):
        assert charts.strip_states([0, 0, 1, 1], cells=2) == ['online', 'online']

    def test_a_missing_reading_is_no_data_rather_than_down(self):
        assert charts.strip_states([None, 1], cells=2) == ['unavailable', 'online']

    def test_the_up_line_is_configurable(self):
        assert charts.strip_states([3, 7], up_above=5, cells=2) == ['failed', 'online']


class TestUpShare:
    def test_cells_with_no_data_do_not_count_against_uptime(self):
        assert charts.up_share(['unavailable', 'online', 'failed', 'online']) == pytest.approx(200 / 3)

    def test_no_measured_cells_has_no_share(self):
        assert charts.up_share(['unavailable', 'unavailable']) is None


class TestStripStyle:
    def test_each_cell_takes_its_state_color(self):
        style = charts.strip_style(['online', 'failed'])
        assert STATUS_COLORS['online'] in style and STATUS_COLORS['failed'] in style

    def test_a_cell_with_no_data_takes_the_track_color(self):
        assert 'var(--surface-secondary)' in charts.strip_style(['unavailable'])


class TestSharePercents:
    def test_each_part_is_its_share_of_the_total(self):
        assert charts.share_percents([1, 3]) == [25.0, 75.0]

    def test_a_missing_part_counts_as_zero(self):
        assert charts.share_percents([None, 2]) == [0.0, 100.0]

    def test_nothing_to_share_leaves_every_part_empty(self):
        assert charts.share_percents([0, None]) == [0.0, 0.0]


class TestAlignSeries:
    def test_series_share_the_first_ones_timestamps(self):
        times, columns = charts.align_series([[('a', 1), ('b', 2)], [('a', 5), ('b', 6)]])
        assert times == ['a', 'b']
        assert columns == [[1, 2], [5, 6]]

    def test_a_shorter_history_is_padded_at_its_old_end(self):
        _, columns = charts.align_series([[('a', 1), ('b', 2), ('c', 3)], [('c', 9)]])
        assert columns[1] == [None, None, 9]

    def test_a_longer_history_keeps_only_its_newest_readings(self):
        _, columns = charts.align_series([[('b', 2)], [('a', 8), ('b', 9)]])
        assert columns[1] == [9]

    def test_no_history_yet_is_empty(self):
        assert charts.align_series([[], []]) == ([], [[], []])


class TestSeriesOptions:
    def test_a_stack_piles_every_series_as_an_area(self):
        options = charts.series_options('stack', ['a', 'b'])
        assert all(s.get('stack') == 'total' and 'areaStyle' in s for s in options['series'])

    def test_a_mirror_labels_the_lower_series_by_its_size(self):
        options = charts.series_options('mirror', ['down', 'up'])
        assert options['yAxis']['axisLabel'][':formatter'] == 'value => Math.abs(value)'

    def test_plain_lines_fill_only_the_first_series(self):
        options = charts.series_options('lines', ['a', 'b', 'c'])
        assert ['areaStyle' in s for s in options['series']] == [True, False, False]

    def test_the_legend_names_every_series(self):
        assert charts.series_options('lines', ['1m', '5m'])['legend']['data'] == ['1m', '5m']


class TestCardMetricNames:
    def test_a_gauge_reads_its_metric(self):
        assert charts.card_metric_names({'kind': 'gauge', 'metric': 'cpu_pct'}) == ['cpu_pct']

    def test_a_share_reads_every_part(self):
        spec = {'kind': 'share', 'parts': [{'metric': 'a'}, {'metric': 'b'}]}
        assert charts.card_metric_names(spec) == ['a', 'b']

    def test_a_strip_reads_history_rather_than_the_page_model(self):
        assert charts.card_metric_names({'kind': 'strip', 'metric': 'up'}) == []
