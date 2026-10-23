"""Reusable NiceGUI building blocks shared by the UI_SPEC renderer and plugin views."""
import asyncio
from typing import Optional
from nicegui import context, ui
from x_monitor.core.contracts import RefreshCallback
from .tables import data_table, set_rows
from .theme import STATUS_COLORS


def offload(read_fn):
    """Wrap a blocking store read as a coroutine that runs it on the default executor."""
    async def _run(*args, **kwargs):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: read_fn(*args, **kwargs))
    return _run


def refresh_rows(table, new_rows) -> None:
    """Replace a table's rows only when they changed, so unchanged tables send nothing."""
    set_rows(table, new_rows)


def on_data_event(callback: RefreshCallback, run_now: bool = True):
    """Refresh on push: register `callback` on the current client's shared
    scheduler, which the Database Engine's change bus wakes whenever anything
    is written. `run_now=False` defers the first tick to the next scheduler
    tick instead of firing inline during construction."""
    from x_monitor.core.ui.model import schedule_callback
    schedule_callback(callback, run_now=run_now)


LABEL_CLASS = 'halon-label'
VALUE_CLASS = 'halon-value'
SECTION_CLASS = 'halon-title-section'
HOVER_CLASS = 'halon-row-hover cursor-pointer'


def card(classes: str = '', padding: bool = True, title: Optional[str] = None):
    """A flat panel on the content pane, delimited by a hairline and never a
    shadow. A title becomes the panel's header strip; a flush panel holds a
    table or a toolbar edge to edge."""
    flush = '' if padding else ' halon-card--flush'
    panel = ui.card().classes(f'halon-card{flush} {classes}')
    if title is not None:
        with panel:
            card_header(title)
    return panel


def card_header(title: str):
    """The caps header strip across the top of a panel; add actions inside it with `with`."""
    with ui.row().classes('halon-card-header') as header:
        ui.label(title).classes('halon-card-title')
    return header


def table_block(classes: str = 'w-full'):
    """The column a table lives in: its heading line, anything between, then the bordered table."""
    return ui.column().classes(f'halon-table-block {classes}')


def table_heading(title: Optional[str] = None):
    """A table's title line, above and outside its border; add filters or actions inside it with `with`."""
    with ui.row().classes('halon-table-heading') as heading:
        if title:
            ui.label(title).classes('halon-table-title')
    return heading


def table_wrap():
    """The hairline frame that holds only the table: its header row, its rows, and its pager."""
    return ui.element('div').classes('halon-table-wrap')


def show_state(label, state: str, text: Optional[str] = None) -> None:
    """Mark a card value with its status: a state word becomes a badge, a measured number takes the status color."""
    text = label.text if text is None else text
    label.classes(remove=' '.join(['halon-badge', *STATUS_BADGES.values()]))
    if any(char.isdigit() for char in text):
        label.style(f"color: {STATUS_COLORS.get(state, STATUS_COLORS['unavailable'])}")
    else:
        label.style(remove='color: inherit')
        label.classes(add=f"halon-badge {STATUS_BADGES.get(state, '')}")


def info_card(title: str, value: str = '--', value_classes: str = VALUE_CLASS, card_classes: str = 'flex-1 min-w-[9rem]'):
    """Render a small labeled-value panel and return the value label for later binding."""
    with card(f'halon-stat {card_classes}'):
        ui.label(title).classes(LABEL_CLASS)
        # A value is a heading, and headings are never accent-colored (§6.8);
        # only a status rule may recolor one, and then to a status token.
        return ui.label(value).classes(f'{value_classes} w-full')


def page_header(title: str, lede: Optional[str] = None):
    """The view's title and optional one-line lede, returned as (heading column, actions row) for callers to add to."""
    with ui.row().classes('halon-page-header no-wrap'):
        with ui.column().classes('gap-0 min-w-0') as heading:
            ui.label(title).classes('halon-title-page break-words')
            if lede:
                ui.label(lede).classes('halon-lede')
        actions = ui.row().classes('halon-page-actions')
    return heading, actions


def dialog_card(title: str, width: str = '36rem'):
    """A dialog's frame: title bar, body and a footer for its buttons, returned as (body, footer)."""
    with ui.card().classes('halon-dialog').style(f'width: {width}'):
        ui.label(title).classes('halon-dialog-title')
        body = ui.column().classes('halon-dialog-body')
        footer = ui.row().classes('halon-dialog-footer')
    return body, footer


def labeled_input(label: str, **kwargs):
    """A text input with its label stacked above it, since a 32px control has no room for a floating one."""
    with ui.column().classes('halon-field'):
        ui.label(label).classes('halon-field-label')
        return ui.input(**kwargs).props('outlined dense').classes('w-full')


def action_button(text: str, on_click=None, icon: str = 'play_arrow',
                  weight: str = 'default', danger: bool = False):
    """One of the three button weights of §6.1: 'filled' for the single
    primary action on a view, 'default' for ordinary ones, 'flat' for anything
    repeated. Destructive actions swap the accent for the danger token."""
    classes = {'filled': 'halon-button-filled', 'flat': 'halon-button-flat'}.get(weight, 'halon-button')
    if danger:
        classes += ' halon-button-danger'
    # color=None keeps Quasar from adding bg-primary/text-white, whose
    # !important cascade layer outranks any author rule (§8, framework layer).
    return ui.button(text, icon=icon, on_click=on_click, color=None).props('no-caps').classes(classes)


def toggle_button(text: str, icon: str, on_click=None):
    """A bordered button that stays pressed while what it controls is on; set_pressed shows which."""
    return action_button(text, on_click=on_click, icon=icon).props('aria-pressed=false')


def set_pressed(button, pressed: bool):
    """Shows a toggle button as on, with its glyph and label in the accent, or as off."""
    button.classes(add='halon-button-active' if pressed else None, remove=None if pressed else 'halon-button-active')
    button.props(f'aria-pressed={"true" if pressed else "false"}')


def icon_button(icon: str, tooltip: str, on_click=None):
    """A square flat button holding only a glyph, with its name as a tooltip."""
    with ui.button(icon=icon, on_click=on_click, color=None).props('flat no-caps').classes('halon-icon-button') as button:
        ui.tooltip(tooltip)
    return button


def section_title(text: str, classes: str = ''):
    """Render a heading over a block of panels."""
    return ui.label(text).classes(f'{SECTION_CLASS} {classes}')

# Every feed table shows its level as a badge: errors and warnings filled with their status, the rest neutral.
LEVEL_CELL_SLOT = '''
    <q-td :props="props">
        <span class="halon-badge"
              :class="{ 'halon-badge-danger': props.row.level === 'ERROR',
                        'halon-badge-warning': props.row.level === 'WARNING' }">
            {{ props.row.level.charAt(0) + props.row.level.slice(1).toLowerCase() }}
        </span>
    </q-td>
'''

# The badge each monitor state is drawn with; a state with no fill of its own stays neutral.
STATUS_BADGES = {'online': 'halon-badge-success', 'info': 'halon-badge-info', 'failed': 'halon-badge-danger', 'warning': 'halon-badge-warning'}

STATUS_CELL_SLOT = '''
    <q-td :props="props">
        <span class="halon-badge" :class="props.row.status_badge">{{ props.row.status }}</span>
    </q-td>
'''


def feed_columns(target_label: Optional[str] = None, sortable: tuple = (),
                 message_classes: str = '') -> list:
    """Build the shared time/level/message column set, optionally with a target column."""
    columns = [
        {'name': 'timestamp', 'label': 'Time', 'field': 'timestamp', 'align': 'left',
         'sortable': 'timestamp' in sortable},
        {'name': 'level', 'label': 'Level', 'field': 'level', 'align': 'left',
         'sortable': 'level' in sortable},
    ]
    if target_label:
        columns.append({'name': 'target', 'label': target_label, 'field': 'target',
                        'align': 'left', 'sortable': 'target' in sortable})
    columns.append({'name': 'message', 'label': 'Message', 'field': 'message',
                    'align': 'left', 'classes': message_classes})
    return columns


def _feed_table(page, read, title: str, full_height: bool):
    """A time/level/message table over any store read; the log and event
    tables differ only in what they read."""
    with table_block():
        heading = table_heading(title)
        with table_wrap():
            columns = feed_columns(
                sortable=('timestamp',),
                message_classes='halon-cell-wrap font-mono' if full_height else 'halon-cell-wrap')
            table = data_table(columns=columns, filter_into=heading).classes('w-full').props('flat')
            table.add_slot('body-cell-level', LEVEL_CELL_SLOT)
            if full_height:
                table.props('virtual-scroll')

    async def update():
        refresh_rows(table, await offload(read)())

    page.on_refresh(update)
    return table

def log_table(page, target: str, filter_prefix: str = '', title: str = 'Recent logs',
             limit: int = 15, full_height: bool = False):
    """Render a feed table over the target's recent log lines."""
    return _feed_table(
        page, lambda: page.plugin.data.log_lines(target, filter_prefix, limit=limit),
        title, full_height)

def event_table(page, plugin_name: str, plugin_id: str = '', target: str = '',
                title: str = 'Recent events', limit: int = 100,
                full_height: bool = False):
    """Render a feed table over the plugin's recent events."""
    prefix = f"[{plugin_name}] "
    return _feed_table(
        page, lambda: page.plugin.data.plugin_events(plugin_id, prefix, target, limit=limit),
        title, full_height)


def history_chart(page, title: str, plugin_id: str, metric_name: str, limit: int = 30):
    """Render a line chart of one metric's recent history, repainted on push and scheme flips."""
    from x_monitor.core.ui import theme

    with card('w-full', title=title):
        chart = ui.echart({
            'tooltip': {'trigger': 'axis'},
            'grid': {'left': 4, 'right': 8, 'top': 8, 'bottom': 4, 'containLabel': True},
            'xAxis': {'type': 'category', 'data': []},
            'yAxis': {'type': 'value', 'splitLine': {'show': False}},
            'series': [{
                'data': [],
                'type': 'line',
                'smooth': True,
                'areaStyle': {'opacity': 0.1},
            }]
        }).classes('w-full h-64')

        def _repaint(colors):
            # ECharts paints to a canvas and cannot resolve the tokens, so the
            # axes and the line are recolored whenever the client's scheme flips.
            chart.options['textStyle'] = {'fontFamily': colors['font']}
            chart.options['series'][0]['color'] = colors['accent']
            for axis in ('xAxis', 'yAxis'):
                chart.options[axis]['axisLine'] = {'lineStyle': {'color': colors['border']}}
                chart.options[axis]['axisLabel'] = {'color': colors['text_secondary']}
            chart.update()

        theme.on_scheme_change(_repaint)

        def _read():
            history = page.plugin.data.metric_history(plugin_id, metric_name, limit=limit)
            return (
                [m.timestamp.strftime('%H:%M:%S') for m in history],
                [m.value for m in history],
            )

        def _apply(data):
            x, y = data
            if x == chart.options['xAxis']['data'] and y == chart.options['series'][0]['data']:
                return
            chart.options['xAxis']['data'] = x
            chart.options['series'][0]['data'] = y
            chart.update()

        async def update():
            _apply(await offload(_read)())

        page.on_refresh(update)
        return chart

def chip_label(label: str, value: str, color: Optional[str] = None):
    """A status *region*: tinted, not filled, so its text stays ordinary body
    text (§6.7). `color` is a status token, composited at 15% by halon.css."""
    style = f'--halon-tint-color: {color}' if color else ''
    return ui.label(f'{label}: {value}' if label else value).classes('halon-tint').style(style)


def _resolve_repeat_items(plugin, repeat_spec: dict) -> list:
    source = repeat_spec.get('source', 'snapshot')

    if source == 'setting':
        import json
        key = repeat_spec.get('setting_key', '').format(plugin_id=plugin.id)
        raw = plugin.data.get_setting(key)
        if not raw:
            return []
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return []
        if not isinstance(data, list):
            return []
        # A list of plain strings (e.g. DNS answers) becomes {'label': ..., 'value': ...}
        # items so the same item_label/item_value machinery applies uniformly.
        return [
            item if isinstance(item, dict) else {'label': item, 'value': item}
            for item in data
        ]

    if source == 'metrics_prefix':
        return _resolve_metrics_prefix_items(plugin, repeat_spec)

    return plugin.data.latest_snapshot(default=[])


def _scan_metric_family(plugin, prefix: str, suffix: str, exclude: set) -> dict:
    """Returns {stripped_key: latest_value} for metric names matching prefix/suffix."""
    latest: dict = {}
    for record in plugin.data.latest_collector_metrics():
        name = record.metric_name
        if name in exclude:
            continue
        if prefix and not name.startswith(prefix):
            continue
        if suffix and not name.endswith(suffix):
            continue
        key = name
        if prefix:
            key = key.removeprefix(prefix)
        if suffix:
            key = key.removesuffix(suffix)
        latest[key] = record.value
    return latest


def _resolve_metrics_prefix_items(plugin, repeat_spec: dict) -> list:
    """Items discovered from metric names matching a prefix/suffix pattern
    rather than a snapshot blob — for plugins that record one (or more)
    metric(s) per dynamic item (folder_<name>_gb, fs_<name>_used_pct,
    gpu<N>_util, ...). `fields` (optional) lets multiple metric families
    sharing the same stripped key merge into one item dict, e.g.
    fs_<key>_used_pct + fs_<key>_inodes_pct -> {'key':.., 'used_pct':..,
    'inodes_pct':..}. Without `fields`, falls back to the single
    metrics_prefix/metrics_suffix pair -> {'key':.., 'value':..}."""
    exclude = set(repeat_spec.get('metrics_exclude', []))

    fields = repeat_spec.get('fields')
    if fields:
        merged: dict = {}
        for field in fields:
            family = _scan_metric_family(
                plugin, field.get('prefix', ''), field.get('suffix', ''), exclude)
            for key, value in family.items():
                merged.setdefault(key, {'key': key})[field['name']] = value
        items = list(merged.values())
    else:
        family = _scan_metric_family(
            plugin, repeat_spec.get('metrics_prefix', ''),
            repeat_spec.get('metrics_suffix', ''), exclude)
        items = [{'key': key, 'value': value} for key, value in family.items()]

    items.sort(key=lambda i: i['key'])
    return items


_LABEL_TRANSFORMS = {
    'slashes': lambda s: '/' + s.replace('_', '/') if s != 'root' else '/',
    'spaces_upper': lambda s: s.replace('_', ' ').upper(),
    'none': lambda s: s,
}


REPEAT_PANELS = ('bars', 'tiles')


def _largest_bar_value(items: list, bar_value: str) -> float:
    """The largest numeric meter value among the items, or zero when none has one."""
    values = [item.get(bar_value) for item in items]
    return max((value for value in values if isinstance(value, (int, float))), default=0.0)


def render_repeat_card(plugin, page, repeat_spec: dict, title: Optional[str] = None):
    """Render one chip, card, meter or tile per item resolved from a repeat spec's data source;
    meters and tiles sit together in one titled panel."""
    from x_monitor.core.ui import charts
    from x_monitor.core.ui.spec import FORMATTERS, ITEM_COLOR_RULES, ITEM_FORMATTERS, resolve
    from x_monitor.core.ui.theme import STATUS_COLORS

    source = repeat_spec.get('source', 'snapshot')
    container_kind = repeat_spec.get('container', 'chips')
    default_label = 'key' if source == 'metrics_prefix' else 'label'
    default_value = 'value'
    item_label = repeat_spec.get('item_label', default_label)
    item_value = repeat_spec.get('item_value', default_value)
    item_format = repeat_spec.get('item_format')
    formatter = resolve(FORMATTERS, item_format)
    item_format_fn_name = repeat_spec.get('item_format_fn')
    item_format_fn = resolve(ITEM_FORMATTERS, item_format_fn_name)
    label_transform = _LABEL_TRANSFORMS.get(repeat_spec.get('label_transform', 'none'))
    label_prefix = repeat_spec.get('item_label_prefix', '')
    label_suffix = repeat_spec.get('item_label_suffix', '')
    color_rule_name = repeat_spec.get('item_color_by')
    color_rule = resolve(ITEM_COLOR_RULES, color_rule_name)
    empty_text = repeat_spec.get('empty_text', 'No data')
    bar_value = repeat_spec.get('bar_value', item_value)
    bar_max = repeat_spec.get('bar_max', 100.0)
    bar_marker = repeat_spec.get('bar_marker')

    if container_kind in REPEAT_PANELS:
        with card('w-full', title=title):
            container = ui.element('div').classes(f'halon-repeat-{container_kind}')
    else:
        wrap_style = (
            'display: flex; flex-wrap: wrap; gap: var(--space-4); width: 100%'
            if container_kind == 'chips' else
            'display: flex; flex-wrap: wrap; gap: var(--space-5); width: 100%'
        )
        container = ui.element('div').style(wrap_style)
    last_items = [None]

    def render():
        items = _resolve_repeat_items(plugin, repeat_spec)
        # Rebuilding is the costly part, so a refresh that finds the same items sends nothing.
        if items == last_items[0]:
            return
        last_items[0] = items
        container.clear()
        if not items:
            with container:
                ui.label(empty_text).classes('halon-caption')
            return
        scale = _largest_bar_value(items, bar_value) if bar_max == 'largest' else bar_max
        with container:
            for item in items:
                raw_label = str(item.get(item_label, ''))
                label = label_transform(raw_label) if raw_label else raw_label
                if label:
                    label = f'{label_prefix}{label}{label_suffix}'
                if item_format_fn:
                    value = item_format_fn(item)
                else:
                    raw_value = item.get(item_value)
                    value = formatter(raw_value) if formatter else str(raw_value)
                state = color_rule(item) if color_rule else None
                color = STATUS_COLORS.get(state) if state else None
                if container_kind == 'chips':
                    chip_label(label, value, color)
                elif container_kind == 'bars':
                    charts.meter_row(label or '--', value,
                                     charts.fill_percent(item.get(bar_value), scale),
                                     color or charts.color_for(None), bar_marker)
                elif container_kind == 'tiles':
                    charts.status_tile(label or '--', value, state)
                else:
                    info_card(label or '--', value)

    page.on_refresh(render)


def render_buttons(plugin, button_specs: list):
    """Render a row of action buttons from button specs, honoring their visibility predicates."""
    from x_monitor.core.ui.spec import ENABLED_PREDICATES, resolve

    # The click runs as its own task, which starts with no slot, so the page's
    # client is captured here and re-entered before anything is rendered.
    client = context.client

    with ui.row().classes('items-center').style('gap: var(--space-4)'):
        for spec in button_specs:
            predicate_name = spec.get('visible_if')
            if predicate_name:
                predicate = resolve(ENABLED_PREDICATES, predicate_name)
                if predicate is not None and not predicate(plugin):
                    continue

            async def _click(_e=None, s=spec):
                with client:
                    if s.get('kind') == 'dialog':
                        await open_dialog_impl(plugin, s['dialog'])
                        return
                    if s.get('confirm') and not await confirmed(_substitute(s['confirm'], None, plugin)):
                        return
                    success, content = await plugin.run_action(s['id'])
                    if s.get('notify', True):
                        ui.notify(
                            _outcome_notice(s.get('label', s['id']), success, content),
                            type='positive' if success else 'negative',
                        )
                    if success:
                        await follow_action_job(plugin, s['id'])

            action_button(
                spec.get('label', spec['id']), icon=spec.get('icon'),
                weight='flat' if spec.get('flat', True) else 'default',
                danger=spec.get('color') in ('negative', 'danger'),
                on_click=lambda e, c=_click: asyncio.create_task(c(e)),
            )


def notify_client(client, message: str, **kwargs) -> None:
    """Notifies the viewer an action started from, even after their view changed while it ran; a closed tab gets nothing."""
    from nicegui import Client
    if Client.instances.get(client.id) is not client:
        return
    with client:
        ui.notify(message, **kwargs)


async def confirmed(text: str) -> bool:
    """Asks the user to confirm `text` and resolves True only on an explicit yes."""
    with ui.dialog() as dialog:
        body, footer = dialog_card('Please confirm', width='28rem')
        with body:
            ui.label(text).style('white-space: pre-wrap;')
        with footer:
            action_button('Cancel', on_click=lambda: dialog.submit(False), icon=None)
            action_button('Confirm', on_click=lambda: dialog.submit(True), icon=None, weight='filled', danger=True)
    return bool(await dialog)


def _outcome_notice(label: str, success: bool, content: str) -> str:
    """What to tell the user after an action: its own short message when it gave one, else whether it worked."""
    if content and len(content) <= 200:
        return content
    return f'{label} {"succeeded" if success else "failed"}'


def _substitute(template: str, row: Optional[dict], plugin) -> str:
    """Fills a dialog title or confirm template from the row and the plugin, a missing attribute reading as empty."""
    class _PluginProxy:
        def __getattr__(self, key):
            return getattr(plugin, key, '')

        __getitem__ = __getattr__
    return template.format(row=row or {}, plugin=_PluginProxy())


async def open_dialog_impl(plugin, dialog_name: str, row: Optional[dict] = None):
    """Open a named read or edit dialog from the plugin's dialog specs."""
    from x_monitor.core.ui.spec import _dialog_spec_for
    spec = _dialog_spec_for(plugin, dialog_name)
    if spec is None:
        ui.notify(f'Unknown dialog {dialog_name!r}', type='negative')
        return

    title = _substitute(spec.get('title', dialog_name), row, plugin)

    def _resolve_params(params_spec: dict) -> dict:
        return {kwarg: (row or {}).get(field) for kwarg, field in (params_spec or {}).items()}

    if spec['kind'] == 'read':
        ok, content = await plugin.run_action(spec['action_id'], **_resolve_params(spec.get('params')))
        if not ok:
            ui.notify(content or 'Action failed', type='negative')
            return
        if await follow_action_job(plugin, spec['action_id']):
            return
        with ui.dialog() as dialog:
            body, footer = dialog_card(title, width='48rem')
            with body:
                if spec.get('render') == 'textarea_readonly':
                    ui.textarea(value=content).props('readonly autogrow outlined').classes('w-full font-mono')
                else:
                    ui.label(content).classes('font-mono halon-caption').style('white-space: pre-wrap;')
            with footer:
                action_button('Close', on_click=dialog.close, icon=None)
        dialog.open()
        return

    if spec['kind'] == 'edit':
        ok, content = await plugin.run_action(
            spec['load_action_id'], **_resolve_params(spec.get('load_params')))
        if not ok:
            ui.notify(content or 'Unable to load content', type='negative')
            return
        with ui.dialog() as dialog:
            body, footer = dialog_card(title, width='48rem')
            with body:
                editor = ui.textarea(value=content).props('autogrow outlined').classes('w-full font-mono')
            with footer:
                action_button('Cancel', on_click=dialog.close, icon=None)

                async def save():
                    save_kwargs = _resolve_params(spec.get('save_params'))
                    save_kwargs[spec.get('save_content_kwarg', 'content')] = editor.value
                    save_ok, _ = await plugin.run_action(spec['save_action_id'], **save_kwargs)
                    ui.notify(
                        spec.get('success_message', 'Saved') if save_ok else 'Save failed',
                        type='positive' if save_ok else 'negative',
                    )
                    if save_ok:
                        dialog.close()

                action_button('Save', on_click=save, icon=None, weight='filled')
        dialog.open()
        return

    if spec['kind'] == 'form':
        with ui.dialog() as dialog:
            body, footer = dialog_card(title)
            with body:
                inputs = {field['name']: _form_input(plugin, field) for field in spec.get('fields', [])}
                output = ui.textarea().props('readonly autogrow outlined').classes('w-full font-mono')
                output.set_visibility(False)
            with footer:
                action_button('Close', on_click=dialog.close, icon=None)

                async def submit():
                    kwargs = _resolve_params(spec.get('params'))
                    values = form_values(inputs)
                    kwargs.update(values)
                    if spec.get('confirm') and not await confirmed(
                            _substitute(spec['confirm'], {**(row or {}), **values}, plugin)):
                        return
                    ok, content = await plugin.run_action(spec['action_id'], **kwargs)
                    if not ok:
                        ui.notify(content or 'Action failed', type='negative')
                    if content:
                        output.value = content
                        output.set_visibility(True)

                action_button(spec.get('submit_label', 'Run'), on_click=submit, icon=None, weight='filled')
        dialog.open()
        return


def form_options(plugin, field: dict):
    """The choices a select field offers: its own `options`, or the plugin attribute `options_attr` names."""
    if 'options_attr' in field:
        return getattr(plugin, field['options_attr'], None) or []
    return field.get('options') or []


def form_values(inputs: dict) -> dict:
    """Each form input's value by field name, text trimmed and checkboxes kept as booleans."""
    values = {}
    for name, element in inputs.items():
        value = element.value
        values[name] = value if isinstance(value, bool) else str(value or '').strip()
    return values


def _form_input(plugin, field: dict):
    """One form field's input: a checkbox, a select when it has options, else a text box."""
    label = field.get('label', field['name'])
    if field.get('type') == 'checkbox':
        return ui.checkbox(label, value=bool(field.get('default', False)))
    if 'options' in field or 'options_attr' in field:
        options = form_options(plugin, field)
        default = getattr(plugin, field['default_attr'], None) if 'default_attr' in field else field.get('default')
        if default not in options:
            default = next(iter(options), None)
        with ui.column().classes('halon-field'):
            ui.label(label).classes('halon-field-label')
            return ui.select(options, value=default).props('outlined dense').classes('w-full')
    return labeled_input(label, value=field.get('default', ''), placeholder=field.get('placeholder', ''))


def _color_rules(columns: list) -> list:
    """Each column that colors its cells, paired with the rule that picks the color."""
    from x_monitor.core.ui.spec import ITEM_COLOR_RULES, resolve
    pairs = []
    for col in columns:
        rule = resolve(ITEM_COLOR_RULES, col['cell_color_by']) if col.get('cell_color_by') else None
        if rule is not None:
            pairs.append((col, rule))
    return pairs


def render_table_with_actions(plugin, page, table_spec: dict, filter_spec: Optional[dict] = None):
    """Render a data table with optional per-row action buttons, toggle-button cells, cell coloring and filtering."""
    from x_monitor.core.ui.spec import ENABLED_PREDICATES, resolve
    from x_monitor.core.ui.theme import STATUS_COLORS

    row_key = table_spec.get('row_key', 'id')
    columns = list(table_spec.get('columns', []))
    row_actions = [
        a for a in table_spec.get('row_actions', [])
        if not a.get('visible_if') or (resolve(ENABLED_PREDICATES, a['visible_if']) or (lambda p: True))(plugin)
    ]

    # ui.table JSON-encodes its columns, so a callable cell_color_by must not reach it.
    render_columns = [{k: v for k, v in col.items() if k not in ('cell_color_by', 'toggle')} for col in columns]
    toggle_columns = [col for col in columns if col.get('toggle')]
    busy_toggles = set()
    if row_actions:
        render_columns = render_columns + [
            {'name': 'actions', 'label': '', 'field': 'actions', 'sortable': False, 'align': 'center'},
        ]

    filter_spec = filter_spec or {}
    with table_block():
        heading = table_heading(table_spec.get('title'))
        with table_wrap():
            table = data_table(columns=render_columns, row_key=row_key,
                               filter_fields=filter_spec.get('fields'),
                               filter_placeholder=filter_spec.get('placeholder', 'Filter'),
                               filter_into=heading, tree=table_spec.get('tree')).classes('w-full').props('flat')

    color_rules = _color_rules(columns)
    for col, _ in color_rules:
        # A colored word is a state and takes a badge; a colored number stays a mark in the status color.
        table.add_slot(f'body-cell-{col["name"]}', f'''
            <q-td :props="props">
                <span v-if="/\\d/.test(String(props.row.{col['field']}))"
                      :style="{{ color: props.row._color_{col['name']} }}">{{{{ props.row.{col['field']} }}}}</span>
                <span v-else class="halon-badge" :class="props.row._badge_{col['name']}">{{{{ props.row.{col['field']} }}}}</span>
            </q-td>
        ''')

    for col in toggle_columns:
        # A value the toggle button cannot show, such as a static unit's boot state, stays as plain text.
        table.add_slot(f'body-cell-{col["name"]}', f'''
            <q-td :props="props">
                <q-btn v-if="props.row._toggle_{col['name']} !== null" flat dense no-caps
                       class="halon-cell-toggle"
                       :class="{{ 'halon-button-active': props.row._toggle_{col['name']} }}"
                       :aria-pressed="String(props.row._toggle_{col['name']})"
                       :disable="props.row._toggle_busy_{col['name']}"
                       :label="String(props.row.{col['field']})"
                       @click="$parent.$emit('toggle_{col['name']}', {{row: props.row, value: !props.row._toggle_{col['name']}}})" />
                <span v-else>{{{{ props.row.{col['field']} }}}}</span>
            </q-td>
        ''')

    if row_actions:
        # Row buttons repeat once per row, so they take the flat weight: a
        # secondary glyph that goes accent on hover. Only a destructive one
        # spends a color, and it spends the danger token (§6.1).
        buttons_html = ''.join(
            f'''<q-btn flat no-caps icon="{a['icon']}"
                       class="{'halon-button-danger' if a.get('color') == 'negative' else ''}"
                       @click="$parent.$emit('{a['id']}', props.row)"
                       title="{a.get('tooltip', '')}" />'''
            for a in row_actions
        )
        table.add_slot('body-cell-actions', f'''
<q-td :props="props">
  <div class="row items-center justify-center halon-row-actions">
    {buttons_html}
  </div>
</q-td>
''')

    async def _handle_action(e, action: dict):
        row = e.args or {}
        if action.get('kind') == 'dialog':
            await open_dialog_impl(plugin, action['dialog'], row=row)
            return
        if action.get('confirm') and not await confirmed(_substitute(action['confirm'], row, plugin)):
            return
        params = {kwarg: row.get(field) for kwarg, field in action.get('params', {}).items()}
        action_id = action.get('action_id', action['id'])
        success, content = await plugin.run_action(action_id, **params)
        if action.get('notify', True):
            label = action.get('tooltip', action_id).replace('_', ' ').title()
            notify_client(table.client, _outcome_notice(label, success, content),
                          type='positive' if success else 'negative')
        # A failed or inline action leaves no running job, so this opens nothing for one.
        with table.client:
            await follow_action_job(plugin, action_id)

    for action in row_actions:
        table.on(action['id'], lambda e, a=action: asyncio.create_task(_handle_action(e, a)))

    async def _handle_toggle(e, col: dict):
        toggle = col['toggle']
        row = (e.args or {}).get('row') or {}
        wanted = bool((e.args or {}).get('value'))
        busy_key = (col['name'], row.get(row_key))
        if busy_key in busy_toggles:
            return
        busy_toggles.add(busy_key)
        update_table()
        params = {kwarg: row.get(field) for kwarg, field in toggle.get('params', {}).items()}
        action_id = toggle['on_action_id'] if wanted else toggle['off_action_id']
        success, content = False, ''
        try:
            success, content = await plugin.run_action(action_id, **params)
            # The poll reads the state back, so the button shows what the target did rather than what was asked.
            if success:
                await plugin.run_cycle()
        finally:
            busy_toggles.discard(busy_key)
            update_table()
        label = f"{col.get('label', col['name'])} {'on' if wanted else 'off'}: {row.get(row_key)}"
        notify_client(table.client, _outcome_notice(label, success, content),
                      type='positive' if success else 'negative')

    for col in toggle_columns:
        table.on(f'toggle_{col["name"]}', lambda e, c=col: asyncio.create_task(_handle_toggle(e, c)))

    def _rows():
        rows_attr = table_spec.get('rows_attr')
        if rows_attr:
            rows = list(getattr(plugin, rows_attr))
        else:
            rows = _resolve_repeat_items(plugin, {'source': table_spec.get('source', 'snapshot')})
        for col, rule in color_rules:
            for row in rows:
                state = rule(row)
                row[f"_color_{col['name']}"] = STATUS_COLORS.get(state, STATUS_COLORS['online']) if state else STATUS_COLORS['online']
                row[f"_badge_{col['name']}"] = STATUS_BADGES.get(state or 'online', '')
        for col in toggle_columns:
            for row in rows:
                row[f"_toggle_{col['name']}"] = toggle_position(col['toggle'], row.get(col['field']))
                row[f"_toggle_busy_{col['name']}"] = (col['name'], row.get(row_key)) in busy_toggles
        return rows

    def update_table():
        refresh_rows(table, _rows())

    page.on_refresh(update_table)
    update_table()
    return table


def toggle_position(toggle: dict, value) -> Optional[bool]:
    """Whether a toggle cell shows pressed for a row value: on, off, or None when the value is neither."""
    if value in toggle.get('on', ()):
        return True
    if value in toggle.get('off', ()):
        return False
    return None


def render_job_panel(plugin, spec: dict):
    """Render the progress line and history table for a plugin's jobs, with run/cancel controls when the spec names a run action."""
    from x_monitor.core.ui.spec import ENABLED_PREDICATES, resolve
    from x_monitor.core.ui.theme import STATUS_COLORS
    from x_monitor.plugins.base.plugin_helpers import format_duration

    history_limit = spec.get('history_limit', 10)
    enabled_name = spec.get('enabled_if')
    enabled_predicate = (resolve(ENABLED_PREDICATES, enabled_name) or (lambda p: True)) if enabled_name else (lambda p: True)

    run_btn = cancel_btn = None
    with table_block():
        with table_heading(spec.get('title', 'Jobs')):
            if spec.get('run_action_id'):
                with ui.row().classes('halon-table-actions'):
                    run_btn = action_button(
                        spec.get('run_label', 'Run'), icon=spec.get('run_icon', 'play_arrow'),
                        weight='filled',
                        on_click=lambda: asyncio.create_task(_start(plugin, spec)),
                    )
                    cancel_btn = action_button(
                        spec.get('cancel_label', 'Cancel'), icon=spec.get('cancel_icon', 'stop'),
                        danger=True,
                        on_click=lambda: asyncio.create_task(_cancel(plugin)),
                    )

        with ui.row() as progress_row:
            progress_label = ui.label('').classes('halon-caption font-mono')

        with table_wrap():
            jobs_table = data_table(
                columns=[
                    {'name': 'started', 'label': 'Started', 'field': 'started', 'align': 'left'},
                    {'name': 'kind', 'label': 'Kind', 'field': 'kind', 'align': 'left'},
                    {'name': 'state', 'label': 'State', 'field': 'state', 'align': 'left'},
                    {'name': 'duration', 'label': 'Duration', 'field': 'duration', 'align': 'left',
                     'sort_field': 'duration_seconds'},
                    {'name': 'log', 'label': '', 'field': 'id', 'sortable': False, 'align': 'center'},
                ],
                row_key='id', filter_input=False,
            ).classes('w-full').props('flat')
            jobs_table.add_slot('body-cell-log', '''
<q-td :props="props">
  <div class="row items-center justify-center halon-row-actions">
    <q-btn flat no-caps icon="article" title="Log" @click="$parent.$emit('show_log', props.row)" />
  </div>
</q-td>
''')
            jobs_table.on('show_log', lambda e: show_job_log(plugin, (e.args or {}).get('id')))

        last_progress_color = [None]

        def update():
            running = plugin.jobs.is_running()
            enabled = enabled_predicate(plugin)
            if run_btn is not None:
                run_btn.set_enabled(enabled and not running)
                cancel_btn.set_visibility(running)

            if running:
                job = plugin.data.job(plugin.jobs.current_id())
                progress_label.text = (job or {}).get('progress') or 'Starting...'
                color = STATUS_COLORS['online']
            elif not enabled:
                progress_label.text = spec.get('disabled_text', 'Not available — check monitor configuration')
                color = STATUS_COLORS['unavailable']
            else:
                progress_label.text = ''
                color = None
            progress_row.set_visibility(bool(progress_label.text))
            if color is not None and color != last_progress_color[0]:
                last_progress_color[0] = color
                progress_label.style(f"color: {color}")

            refresh_rows(jobs_table, [
                {
                    'id': j['id'], 'started': j['started'], 'kind': j['kind'],
                    'state': j['state'], 'duration': format_duration(j['duration']),
                    'duration_seconds': j['duration'],
                }
                for j in plugin.jobs.recent(limit=history_limit)
            ])

        on_data_event(update)


def _job_summary(job: dict) -> str:
    """The dialog's one-line description of a job: when it started, its state and how it ended."""
    from x_monitor.plugins.base.plugin_helpers import format_duration
    parts = [f"Started {job['started']}", job['state']]
    if job.get('exit_code') is not None:
        parts.append(f"exit {job['exit_code']}")
    parts.append(format_duration(job['duration']))
    return ' · '.join(parts)


def _job_title(plugin, job: dict) -> str:
    """A job's name in its log dialog: the action's name for a detached action, else its kind."""
    from x_monitor.core.coordination.action_jobs import action_label
    from x_monitor.core.coordination.jobs import action_id_of
    action_id = action_id_of(job['kind'])
    return action_label(plugin, action_id) if action_id is not None else job['kind'].capitalize()


async def follow_action_job(plugin, action_id: str) -> bool:
    """Open the live log of this action's detached run when one is going, returning whether one was."""
    jobs = getattr(plugin, 'jobs', None)
    job = jobs.action_job(action_id) if jobs is not None else None
    if job is None:
        return False
    await show_job_log(plugin, job['id'])
    return True


async def show_job_log(plugin, job_id: Optional[int]):
    """Open a dialog with a job's command and output, following new lines until the job ends."""
    job = plugin.data.job(job_id) if job_id is not None else None
    if job is None:
        ui.notify('That job is no longer kept', type='warning')
        return
    with ui.dialog() as dialog:
        body, footer = dialog_card(f"{_job_title(plugin, job)} log", width='64rem')
        with body:
            summary = ui.label(_job_summary(job)).classes('halon-caption')
            ui.label(job['command']).classes('font-mono halon-caption halon-job-command')
            error = ui.label(job.get('error') or '').classes('halon-caption halon-text-danger')
            error.set_visibility(bool(job.get('error')))
            output = ui.log().classes('w-full font-mono halon-job-log')
            empty = ui.label('No output').classes('halon-caption')
        with footer:
            action_button('Close', on_click=dialog.close, icon=None)
    shown = [-1]

    async def refresh():
        current = plugin.data.job(job_id) or job
        lines = await plugin.jobs.log(job_id)
        for line in lines:
            if line['seq'] > shown[0]:
                output.push(line['message'])
                shown[0] = line['seq']
        empty.set_visibility(shown[0] < 0)
        summary.text = _job_summary(current)
        error.text = current.get('error') or ''
        error.set_visibility(bool(current.get('error')))
        if current['state'] != 'running':
            follow.deactivate()

    with dialog:
        follow = ui.timer(2.0, refresh)
    dialog.on_value_change(lambda e: dialog.delete() if not e.value else None)
    dialog.open()


async def _start(plugin, spec: dict):
    if plugin.jobs.is_running():
        ui.notify('A job is already running', type='warning')
        return
    ui.notify(f"{spec.get('run_label', 'Job')} started", type='positive')
    asyncio.create_task(plugin.run_action(spec['run_action_id']))


async def _cancel(plugin):
    if await plugin.jobs.cancel():
        ui.notify('Cancellation requested', type='warning')
    else:
        ui.notify('No job is running', type='info')


def render_host_card(target: str):
    """Render the standard card naming the monitored host."""
    return info_card('TARGET HOST', target)

def render_status_card(page, plugin_id: str, metric_name: str, title: str = 'STATUS',
                       on_text: str = 'ACTIVE', off_text: str = 'INACTIVE',
                       value_classes: str = VALUE_CLASS):
    """Render an on/off status card bound to a 0-or-1 metric."""
    lbl = info_card(title, 'Checking...', value_classes=value_classes)
    page.track_metric(metric_name)

    def _on_off_text(value):
        if value is None:
            return 'Checking...'
        return on_text if value > 0.5 else off_text

    lbl.bind_text_from(page.model, ('metrics', metric_name), backward=_on_off_text)

    def update_color():
        value = page.model.metrics.get(metric_name)
        if value is not None:
            is_on = value > 0.5
            show_state(lbl, 'online' if is_on else 'failed', _on_off_text(value))

    page.on_refresh(update_color)
    return lbl
