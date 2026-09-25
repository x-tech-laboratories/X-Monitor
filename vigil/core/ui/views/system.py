"""The header's system menu and the dialog that changes logging verbosity at runtime."""

from nicegui import ui

from vigil.core.contracts import EngineLike
from vigil.core.settings.log_levels import LEVELS, ROOT
from ..components import action_button, card


def open_log_levels_dialog(engine: EngineLike) -> None:
    """A dialog listing the current log levels, with a form to change one and a reset for each named logger."""

    @ui.refreshable
    def current() -> None:
        for name, level in engine.log_levels().items():
            with ui.row().classes('w-full items-center justify-between gap-2 no-wrap'):
                with ui.column().classes('gap-0').style('min-width: 0'):
                    ui.label(name).classes('break-all')
                    ui.label(level).classes('halon-caption')
                if name != ROOT:
                    action_button('Reset', on_click=lambda n=name: apply(n, None), icon='undo',
                                  weight='flat').mark(f'reset-{name}')

    def apply(logger: str, level) -> None:
        # A bad logger or level name is the operator's to fix, so it is shown rather than raised.
        try:
            engine.set_log_level(logger, level, source='dashboard')
        except ValueError as e:
            ui.notify(str(e), type='negative')
            return
        ui.notify(f'{logger or ROOT} is now {level or "inherited"}', type='positive')
        current.refresh()

    with ui.dialog() as dialog, card('w-full').style('max-width: 36rem;'):
        ui.label('Log levels').classes('halon-title-section mb-4')
        ui.label('Changes apply at once and last until Vigil restarts or the config sets them again.').classes(
            'halon-caption mb-2')
        current()
        ui.separator().classes('my-2')
        ui.label('Change').classes('halon-label')
        with ui.row().classes('w-full items-end gap-2 no-wrap'):
            logger = ui.select([ROOT, *engine.known_loggers()], value=ROOT, label='Logger',
                               with_input=True, new_value_mode='add-unique').classes('flex-1').mark('logger')
            level = ui.select(list(LEVELS), value='DEBUG', label='Level').mark('level')
            action_button('Apply', on_click=lambda: apply(logger.value, level.value),
                          icon='check', weight='flat').mark('apply')
        with ui.row().classes('w-full justify-end mt-4'):
            action_button('Close', on_click=dialog.close, icon=None, weight='flat')
    dialog.open()


def render_system_menu(engine: EngineLike) -> None:
    """The header button whose menu holds Vigil's own runtime controls."""
    with ui.button(icon='tune', color=None).props('flat dense round'):
        ui.tooltip('System')
        with ui.menu():
            ui.menu_item('Log levels', on_click=lambda: open_log_levels_dialog(engine))
