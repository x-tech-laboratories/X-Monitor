"""Notification controls: a monitor's Notifications toggle button, and the dialog that tests channels and lists mutes."""

from typing import Any

from nicegui import ui

from x_monitor.core.contracts import EngineLike
from ..components import action_button, dialog_card, set_pressed, toggle_button


def render_mute_button(engine: EngineLike, plugin: Any) -> None:
    """The Notifications toggle button: pressed sends this monitor's notifications, released mutes them, or a group's for everything in it."""
    notifications = engine.notifications
    if not notifications.channels:
        return

    window = notifications.maintenance_for(plugin.id)
    if window is not None:
        action_button(f'In maintenance: {window}', icon='construction').props('disable')

    @ui.refreshable
    def toggle() -> None:
        muter = notifications.muted_by(plugin.id)
        if muter is not None and muter != plugin.id:
            group = notifications.monitor_name(muter)
            toggle_button(f'Muted by {group}', icon='notifications_off').disable()
            return
        sending = muter is None

        def clicked() -> None:
            notifications.set_muted(plugin.id, sending)
            toggle.refresh()
            ui.notify(f'{plugin.name} {"muted" if sending else "unmuted"}', type='positive')

        button = toggle_button('Notifications', icon='notifications' if sending else 'notifications_off',
                               on_click=clicked)
        set_pressed(button, sending)

    toggle()


def open_notifications_dialog(engine: EngineLike) -> None:
    """A dialog listing each channel with a test button, and every muted monitor with an unmute button."""
    notifications = engine.notifications

    async def send_test(channel_id: str) -> None:
        # A failed test is the answer the operator asked for, so it is shown rather than raised.
        try:
            await notifications.send_test(channel_id)
        except Exception as e:
            ui.notify(f'Test to {channel_id} failed: {e}', type='negative')
            return
        ui.notify(f'Test sent to {channel_id}', type='positive')

    @ui.refreshable
    def muted_list() -> None:
        muted = sorted(notifications.muted_monitors(), key=lambda p: p.name.lower())
        if not muted:
            ui.label('No monitors are muted.').classes('halon-caption')
            return
        with ui.column().classes('halon-list'):
            for plugin in muted:
                def unmute(p=plugin) -> None:
                    notifications.set_muted(p.id, False)
                    ui.notify(f'{p.name} unmuted', type='positive')
                    muted_list.refresh()

                with ui.row().classes('halon-list-row'):
                    ui.label(plugin.name)
                    action_button('Unmute', on_click=unmute, icon='notifications', weight='flat')

    with ui.dialog() as dialog:
        body, footer = dialog_card('Notifications', width='32rem')
        with body:
            with ui.column().classes('w-full gap-0'):
                ui.label('Channels').classes('halon-label')
                with ui.column().classes('halon-list'):
                    for channel_id, channel in notifications.channels.items():
                        with ui.row().classes('halon-list-row'):
                            with ui.column().classes('gap-0 min-w-0'):
                                ui.label(channel_id)
                                ui.label(channel.TYPE).classes('halon-caption')
                            action_button('Send test', on_click=lambda c=channel_id: send_test(c),
                                          icon='send', weight='flat').mark(f'test-{channel_id}')
            if notifications.windows:
                with ui.column().classes('w-full gap-0'):
                    ui.label('Maintenance').classes('halon-label')
                    active = notifications.active_windows()
                    with ui.column().classes('halon-list'):
                        for window in notifications.windows:
                            with ui.row().classes('halon-list-row'):
                                with ui.column().classes('gap-0 min-w-0'):
                                    ui.label(window.name)
                                    ui.label(window.describe()).classes('halon-caption')
                                if window in active:
                                    ui.label('Active now').classes('halon-badge halon-badge-warning')
            with ui.column().classes('w-full gap-0'):
                ui.label('Muted').classes('halon-label')
                muted_list()
        with footer:
            action_button('Close', on_click=dialog.close, icon=None)
    dialog.open()
