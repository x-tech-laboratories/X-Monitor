"""The plugin detail view: header, action buttons and the plugin's own UI."""

import asyncio
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional
from nicegui import ui
from x_monitor.core.contracts import ActionButtonSpec, EngineLike
from ..components import action_button, notify_client, on_data_event, page_header
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
    names = action_names(plugin.get_actions())
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
    """Renders the Poll Now button, the mute switch and the plugin's declared action buttons."""
    # A poll or action can outlast the view it was started from, so its notice goes through the client instead of the view's slot.
    client = actions_row.client
    with actions_row:
        async def poll_now():
            await plugin.run_cycle()
            notify_client(client, f'{plugin.name} polled', type='positive')
        # The one filled button on the view; everything else is a bordered ghost so the accent keeps meaning "the action".
        action_button('Poll Now', on_click=poll_now, icon='refresh', weight='filled')
        render_mute_button(engine, plugin)

        info = await plugin.present()
        for action in info.get('actions', []):
            if action.get('kind') == 'toggle':
                _render_toggle(plugin, action, client)
                continue

            async def do_action(aid=action['action_id']):
                success, _ = await plugin.run_action(aid)
                notify_client(client, 'Action completed successfully' if success else 'Action failed',
                              type='positive' if success else 'negative')

            action_button(action['name'], on_click=do_action,
                          icon=action.get('icon', 'play_arrow'),
                          danger=action.get('variant') == 'danger')


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
    """A switch that shows the toggle's state metric and runs its on or off action when flipped."""
    busy = False

    def reported() -> Optional[bool]:
        record = plugin.data.latest_metric(action['metric'])
        return None if record is None else record.value > 0.5

    async def flipped(event):
        nonlocal busy
        # Syncing the switch to the metric also fires this, and then there is nothing to do.
        if busy or event.value == reported():
            return
        busy = True
        switch.disable()
        action_id = action['on_action_id'] if event.value else action['off_action_id']
        word = 'on' if event.value else 'off'
        success = False
        try:
            success, _ = await plugin.run_action(action_id)
            # The poll reads the state back, so the switch shows what the target did rather than what was asked.
            if success:
                await plugin.run_cycle()
        finally:
            busy = False
            sync()
        if success:
            notify_client(client, f"{action['name']}: {word}", type='positive')
        else:
            notify_client(client, f"{action['name']} could not be switched {word}", type='negative')

    def sync():
        if busy:
            return
        state = reported()
        switch.value = bool(state)
        # A monitor that has not reported the state yet has nothing for the switch to show.
        switch.set_enabled(state is not None)

    switch = ui.switch(action['name'], on_change=flipped).props('dense')
    on_data_event(sync)
