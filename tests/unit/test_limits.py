from x_monitor.core.ui.spec import threshold_color
from x_monitor.plugins.base.plugin_helpers import floor_level_for, level_for, limit_from, limits_text


class TestLimitFrom:
    def test_absent_key_takes_the_default(self):
        assert limit_from({}, 'warning', 70) == 70.0

    def test_absent_key_without_a_default_is_off(self):
        assert limit_from({}, 'warning') is None

    def test_null_turns_the_level_off_despite_a_default(self):
        assert limit_from({'threshold': None}, 'threshold', 85) is None

    def test_set_value_is_read_as_a_float(self):
        assert limit_from({'threshold': '90'}, 'threshold', 85) == 90.0


class TestLevelFor:
    def test_both_limits(self):
        assert [level_for(v, 50, 80) for v in (30, 50, 80)] == ['online', 'warning', 'failed']

    def test_warning_only_never_fails(self):
        assert level_for(1e9, 50, None) == 'warning'

    def test_threshold_only_never_warns(self):
        assert [level_for(v, None, 80) for v in (79, 80)] == ['online', 'failed']

    def test_no_limits_is_always_online(self):
        assert level_for(1e9, None, None) == 'online'


class TestFloorLevelFor:
    def test_both_limits(self):
        assert [floor_level_for(v, 40, 20) for v in (50, 40, 20)] == ['online', 'warning', 'failed']

    def test_warning_only_never_fails(self):
        assert floor_level_for(0, 40, None) == 'warning'

    def test_threshold_only_never_warns(self):
        assert [floor_level_for(v, None, 20) for v in (21, 20)] == ['online', 'failed']


class TestLimitsText:
    def test_both(self):
        assert limits_text(70, 85, '%') == 'warn 70% / fail 85%'

    def test_one_level_off(self):
        assert limits_text(200, None, '%') == 'warn 200%'
        assert limits_text(None, 85) == 'fail 85'

    def test_none(self):
        assert limits_text(None, None) == 'no limits'


class TestThresholdColor:
    def test_warning_only(self):
        assert threshold_color(50, None)(1e9) == 'warning'

    def test_threshold_only(self):
        assert threshold_color(None, 80)(60) == 'online'
        assert threshold_color(None, 80)(80) == 'failed'
