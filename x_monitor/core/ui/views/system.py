"""The header's system menu: reloading config.yaml, and the dialog that changes logging verbosity at runtime."""

from nicegui import ui

from x_monitor.core.contracts import EngineLike
from x_monitor.core.settings.log_levels import LEVELS, ROOT
from ..components import action_button, dialog_card, icon_button


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

    with ui.dialog() as dialog:
        body, footer = dialog_card('Log levels')
        with body:
            ui.label('Changes apply at once and last until X-Monitor restarts or the config sets them again.'
                     ).classes('halon-caption')
            current()
            ui.separator()
            ui.label('Change').classes('halon-label')
            with ui.row().classes('w-full items-end gap-2 no-wrap'):
                logger = ui.select([ROOT, *engine.known_loggers()], value=ROOT, label='Logger',
                                   with_input=True, new_value_mode='add-unique').classes('flex-1').mark('logger')
                level = ui.select(list(LEVELS), value='DEBUG', label='Level').mark('level')
                action_button('Apply', on_click=lambda: apply(logger.value, level.value),
                              icon='check', weight='flat').mark('apply')
        with footer:
            action_button('Close', on_click=dialog.close, icon=None)
    dialog.open()


async def reload_config(engine: EngineLike) -> None:
    """Re-read config.yaml now and say what changed, or why nothing did."""
    result = await engine.reload_config('dashboard')
    ui.notify(result.summary(), type='positive' if result.ok and not result.restart_required
              else 'warning' if result.ok else 'negative', multi_line=True)


def render_system_menu(engine: EngineLike) -> None:
    """The header button whose menu holds X-Monitor's own runtime controls."""
    with icon_button('tune', 'System'):
        with ui.menu():
            ui.menu_item('Reload config', on_click=lambda: reload_config(engine))
            ui.menu_item('Log levels', on_click=lambda: open_log_levels_dialog(engine))
