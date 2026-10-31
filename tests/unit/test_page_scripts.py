"""The scripts the dashboard adds to every page it serves."""

import pytest
from nicegui import context, ui
from nicegui.testing import User

from x_monitor.core.ui.main_dashboard import add_page_scripts

pytest_plugins = ['nicegui.testing.user_plugin']
pytestmark = pytest.mark.nicegui_main_file(None)


async def test_the_page_drops_the_performance_marks_the_browser_would_keep(user: User):
    built = {}

    @ui.page('/')
    def _page():
        add_page_scripts()
        built['client'] = context.client

    await user.open('/')
    head = built['client']._head_html
    assert 'performance.clearMarks()' in head and 'performance.clearMeasures()' in head
