"""The plugin detail view: header, action buttons and the plugin's own UI."""

import asyncio
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional
from nicegui import ui
from x_monitor.core.contracts import ActionButtonSpec, EngineLike
from ..components import (
    _outcome_notice, action_button, confirmed, follow_action_job, notify_client, on_data_event, open_dialog_impl,
    page_header,
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
    """Renders one caption per scheduled action, naming it as its button does and giving its next run, then one per triggered action."""
    entries = getattr(plugin, 'scheduled_actions', [])
    triggered = getattr(plugin, 'triggered_actions', None) or []
    if not entries and not triggered:
        return
    names = action_names(plugin.all_actions())
    for entry in entries:
        upcoming = entry.cron.next_after(datetime.now())
        when = f"next {upcoming:%a %d %b %H:%M}" if upcoming else 'never'
        ui.label(f"Scheduled: {names.get(entry.action, entry.action)} · {entry.cron.expression} · {when}") \
            .classes('halon-caption')
    for entry in triggered:
        ui.label(f"Triggered: {names.get(entry.action, entry.action)} · {entry.describe()}").classes('halon-caption')


def _lede(plugin: Any) -> str:
    """The monitor's type and the host it watches, as one line under its name; a group watches no host of its own."""
    kind = str(getattr(plugin, 'config', {}).get('type', ''))
    target = None if kind == 'group' else getattr(plugin, 'target', None)
    kind = kind.replace('_', ' ')
    return ' · '.join(str(part) for part in (kind, target) if part)


async def _render_actions(engine: EngineLike, plugin: Any, actions_row: Any):
    """Renders the Poll Now button, the plugin's declared action buttons and, last since every monitor has it, the Notifications toggle."""
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

        info = await plugin.present()
        actions = info.get('actions', [])
        for action in actions:
            if action.get('kind') == 'toggle':
                _render_toggle(plugin, action, client)
            elif not action.get('more'):
                _render_action(plugin, action, client)
        more = [action for action in actions if action.get('more') and action.get('kind') != 'toggle']
        if more:
            _render_more(plugin, more, client)
        if getattr(plugin, 'jobs', None) is not None and any(
                action.get('job') or action.get('detached') for action in actions):
            _render_cancel(plugin, client)
        render_mute_button(engine, plugin)


def _action_state(plugin: Any, action: ActionButtonSpec) -> str:
    """The action's state now, as plugin.action_state reports it: normal, accent, disabled or hidden."""
    return plugin.action_state(action) if hasattr(plugin, 'action_state') else 'normal'


async def _run_header_action(plugin: Any, action: ActionButtonSpec, client: Any):
    """Opens the action's dialog, or asks its confirm question and runs it, then tells the viewer how it went."""
    # An action that is running or greyed out would only be refused.
    if _action_state(plugin, action) != 'normal':
        return
    if action.get('kind') == 'dialog':
        await open_dialog_impl(plugin, action['dialog'])
        return
    if action.get('confirm') and not await confirmed(action['confirm']):
        return
    success, content = await plugin.run_action(action['action_id'])
    notify_client(client, _outcome_notice(action['name'], success, content),
                  type='positive' if success else 'negative')
    if success:
        with client:
            await follow_action_job(plugin, action['action_id'])


def _render_action(plugin: Any, action: ActionButtonSpec, client: Any):
    """An action button that follows plugin.action_state: hidden, greyed out, normal, or filled while it runs."""
    async def clicked():
        await _run_header_action(plugin, action, client)

    def sync():
        current = _action_state(plugin, action)
        button.set_visibility(current != 'hidden')
        button.set_enabled(current != 'disabled')
        filled = current == 'accent'
        button.classes(add='halon-button-filled' if filled else 'halon-button',
                       remove='halon-button' if filled else 'halon-button-filled')

    button = action_button(action['name'], on_click=clicked, icon=action.get('icon', 'play_arrow'),
                           danger=action.get('variant') == 'danger')
    on_data_event(sync)


def _render_more(plugin: Any, actions: List[ActionButtonSpec], client: Any):
    """A More button whose menu holds the less used actions; it is filled while one of them runs."""
    items = []
    with action_button('More', icon='more_horiz') as button:
        with ui.menu():
            for action in actions:
                async def clicked(a=action):
                    await _run_header_action(plugin, a, client)

                with ui.menu_item(on_click=clicked) as item:
                    with ui.item_section().props('avatar'):
                        ui.icon(action.get('icon', 'play_arrow'))
                    ui.item_section(action['name'])
                if action.get('variant') == 'danger':
                    item.classes('halon-menu-item-danger')
                items.append((action, item))

    def sync():
        states = [_action_state(plugin, action) for action, _ in items]
        for state, (_, item) in zip(states, items):
            item.set_visibility(state != 'hidden')
            item.props(remove='disable active')
            if state in ('disabled', 'accent'):
                item.props('disable' if state == 'disabled' else 'active')
        shown = [state for state in states if state != 'hidden']
        button.set_visibility(bool(shown))
        filled = 'accent' in shown
        button.classes(add='halon-button-filled' if filled else 'halon-button',
                       remove='halon-button' if filled else 'halon-button-filled')

    on_data_event(sync)


def _render_cancel(plugin: Any, client: Any):
    """A Cancel button for the plugin's running job, shown only while one runs."""
    async def clicked():
        if await plugin.jobs.cancel():
            notify_client(client, 'Cancellation requested', type='warning')
        else:
            notify_client(client, 'No job is running', type='info')

    def sync():
        button.set_visibility(plugin.jobs.any_running())

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
