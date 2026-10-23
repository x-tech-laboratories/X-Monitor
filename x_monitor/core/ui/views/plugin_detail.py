"""The plugin detail view: header, action buttons and the plugin's own UI."""

import asyncio
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional
from nicegui import ui
from x_monitor.core.contracts import ActionButtonSpec, EngineLike
from ..components import (
    _outcome_notice, action_button, confirmed, notify_client, on_data_event, open_dialog_impl, page_header,
    set_pressed, toggle_button,
)
from .notifications import render_mute_button


def render_plugin_detail(engine: EngineLike, switch_view: Callable, plugin: Any):
    """Renders one plugin's page: name header, action row and its render_ui output."""
    heading, actions_row = page_header(plugin.name, _lede(plugin))
    with heading:
        _render_schedule(plugin)

    asyncio.create_task(_render_actions(engine, plugin, actions_row))

    plugin.render_ui()


def _render_schedule(plugin: Any):
    """Renders one caption per scheduled action, naming it as its button does and giving its next run."""
    entries = getattr(plugin, 'scheduled_actions', [])
    if not entries:
        return
    names = action_names(plugin.all_actions())
    for entry in entries:
        upcoming = entry.cron.next_after(datetime.now())
        when = f"next {upcoming:%a %d %b %H:%M}" if upcoming else 'never'
        ui.label(f"Scheduled: {names.get(entry.action, entry.action)} · {entry.cron.expression} · {when}") \
            .classes('halon-caption')


def _lede(plugin: Any) -> str:
    """The monitor's type and the host it watches, as one line under its name; a group watches no host of its own."""
    kind = str(getattr(plugin, 'config', {}).get('type', '')).replace('_', ' ')
    target = None if getattr(plugin, 'children', None) else getattr(plugin, 'target', None)
    return ' · '.join(str(part) for part in (kind, target) if part)


async def _render_actions(engine: EngineLike, plugin: Any, actions_row: Any):
    """Renders the Poll Now button, the Notifications toggle and the plugin's declared action buttons."""
    # A poll or action can outlast the view it was started from, so its notice goes through the client instead of the view's slot.
    client = actions_row.client
    with actions_row:
        polling = False

        async def poll_now():
            nonlocal polling
            if polling:
                return
            polling = True
            # The button takes the accent only while a poll runs, so the fill means "working" rather than "click me".
            poll_button.text = 'Polling...'
            poll_button.classes(add='halon-button-filled', remove='halon-button')
            try:
                await plugin.run_cycle()
            finally:
                polling = False
                poll_button.text = 'Poll Now'
                poll_button.classes(add='halon-button', remove='halon-button-filled')
            notify_client(client, f'{plugin.name} polled', type='positive')

        poll_button = action_button('Poll Now', on_click=poll_now, icon='refresh')
        render_mute_button(engine, plugin)

        info = await plugin.present()
        actions = info.get('actions', [])
        for action in actions:
            if action.get('kind') == 'toggle':
                _render_toggle(plugin, action, client)
            else:
                _render_action(plugin, action, client)
        if getattr(plugin, 'jobs', None) is not None and any(action.get('job') for action in actions):
            _render_cancel(plugin, client)


def _render_action(plugin: Any, action: ActionButtonSpec, client: Any):
    """An action button that follows plugin.action_state: hidden, greyed out, normal, or filled while it runs."""
    def state() -> str:
        return plugin.action_state(action) if hasattr(plugin, 'action_state') else 'normal'

    async def clicked():
        # A filled button is already running, so a second click would only be refused.
        if state() != 'normal':
            return
        if action.get('kind') == 'dialog':
            await open_dialog_impl(plugin, action['dialog'])
            return
        if action.get('confirm') and not await confirmed(action['confirm']):
            return
        success, content = await plugin.run_action(action['action_id'])
        notify_client(client, _outcome_notice(action['name'], success, content),
                      type='positive' if success else 'negative')

    def sync():
        current = state()
        button.set_visibility(current != 'hidden')
        button.set_enabled(current != 'disabled')
        filled = current == 'accent'
        button.classes(add='halon-button-filled' if filled else 'halon-button',
                       remove='halon-button' if filled else 'halon-button-filled')

    button = action_button(action['name'], on_click=clicked, icon=action.get('icon', 'play_arrow'),
                           danger=action.get('variant') == 'danger')
    on_data_event(sync)


def _render_cancel(plugin: Any, client: Any):
    """A Cancel button for the plugin's running job, shown only while one runs."""
    async def clicked():
        if await plugin.jobs.cancel():
            notify_client(client, 'Cancellation requested', type='warning')
        else:
            notify_client(client, 'No job is running', type='info')

    def sync():
        button.set_visibility(plugin.jobs.is_running())

    button = action_button('Cancel', on_click=clicked, icon='stop', danger=True)
    on_data_event(sync)


def action_names(actions: List[ActionButtonSpec]) -> Dict[str, str]:
    """Maps each action id to the label a person sees for it; a toggle's two ids get its name plus on or off."""
    names = {}
    for action in actions:
        if action.get('kind') == 'toggle':
            names[action['on_action_id']] = f"{action['name']}: on"
            names[action['off_action_id']] = f"{action['name']}: off"
        else:
            names[action['action_id']] = action['name']
    return names


def _render_toggle(plugin: Any, action: ActionButtonSpec, client: Any):
    """A toggle button, pressed while the toggle's state metric is on, that runs its on or off action when clicked."""
    busy = False

    def reported() -> Optional[bool]:
        record = plugin.data.latest_metric(action['metric'])
        return None if record is None else record.value > 0.5

    async def clicked():
        nonlocal busy
        state = reported()
        if busy or state is None:
            return
        wanted = not state
        busy = True
        button.disable()
        action_id = action['on_action_id'] if wanted else action['off_action_id']
        word = 'on' if wanted else 'off'
        success = False
        try:
            success, _ = await plugin.run_action(action_id)
            # The poll reads the state back, so the button shows what the target did rather than what was asked.
            if success:
                await plugin.run_cycle()
        finally:
            busy = False
            sync()
        if success:
            notify_client(client, f"{action['name']}: {word}", type='positive')
        else:
            notify_client(client, f"{action['name']} could not be turned {word}", type='negative')

    def sync():
        if busy:
            return
        state = reported()
        set_pressed(button, bool(state))
        # A monitor that has not reported the state yet has nothing for the button to show.
        button.set_enabled(state is not None)

    button = toggle_button(action['name'], icon=action.get('icon', 'toggle_on'), on_click=clicked)
    on_data_event(sync)
