"""GPU utilization, memory, temperature, power and clock for NVIDIA, AMD and
Intel cards, from nvidia-smi and /sys/class/drm in one command. No GPU at all,
a probe timeout, or a wedged NVIDIA driver is unavailable; nvidia-smi reporting
an error of its own is failed."""

import json
import re
import time

from typing import Any, Dict, List, Optional

from vigil.plugins.base.signal_plugin import SignalPlugin, worst_status as _worst
from vigil.core.connectors.types import CmdResult, CollectResult, Command, Status
from vigil.core.settings.config_schema import PluginConfig
from vigil.plugins.base.plugin_helpers import level_for

_PCI_VENDORS = {'nvidia': '0x10de', 'amd': '0x1002', 'intel': '0x8086'}
_VENDOR_NAMES = {'nvidia': 'NVIDIA', 'amd': 'AMD', 'intel': 'Intel'}
_VENDOR_BY_ID = {pci_id: vendor for vendor, pci_id in _PCI_VENDORS.items()}

_NVIDIA_QUERY = (
    "nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,"
    "power.draw,clocks.sm --format=csv,noheader,nounits"
)

# The sysfs files read per card; missing ones stay unexpanded and grep -s skips them silently.
_SYSFS_FILES = ' '.join('"$d"/' + path for path in (
    'device/gpu_busy_percent', 'device/mem_busy_percent',
    'device/mem_info_vram_used', 'device/mem_info_vram_total', 'device/pp_dpm_sclk',
    'gt_act_freq_mhz', 'device/tile0/gt0/freqs/act_freq',
)) + ' ' + ' '.join('"$d"/device/hwmon/hwmon*/' + name for name in (
    'temp*_input', 'temp*_label', 'power1_average', 'power1_input',
))

# hwmon temperature labels mapped to the metric suffix they feed.
_TEMP_LABELS = {'edge': 'temp', 'pkg': 'temp', 'junction': 'temp_junction',
                'mem': 'temp_mem', 'vram': 'temp_mem'}


def _nvidia_script() -> str:
    return ("if command -v nvidia-smi >/dev/null 2>&1; then "
            f"echo @@NVIDIA; {_NVIDIA_QUERY} 2>&1; echo \"@@NVIDIA_EXIT $?\"; "
            "else echo @@NVIDIA_MISSING; fi")


def _sysfs_script(vendor_ids: List[str], intel_gpu_top: bool) -> str:
    """Shell that prints each AMD/Intel card's sysfs readings, skipping a runtime-suspended card so polling never wakes it."""
    igt = (" if [ \"$v\" = 0x8086 ] && command -v intel_gpu_top >/dev/null 2>&1; then"
           " echo @@IGT; timeout -s INT 2 intel_gpu_top -J -s 500 -d \"drm:/dev/dri/${d##*/}\" 2>/dev/null;"
           " echo; echo @@IGT_END; fi;") if intel_gpu_top else ''
    return (
        "for d in /sys/class/drm/card*; do"
        " case \"${d##*/}\" in *-*) continue;; esac;"
        " { read -r v < \"$d/device/vendor\"; } 2>/dev/null || continue;"
        f" case \"$v\" in {'|'.join(vendor_ids)}) ;; *) continue;; esac;"
        " echo \"@@CARD ${d##*/} $v\";"
        " rt=; { read -r rt < \"$d/device/power/runtime_status\"; } 2>/dev/null;"
        " if [ \"$rt\" = suspended ]; then echo @@ASLEEP; continue; fi;"
        f" grep -Hs . {_SYSFS_FILES};"
        f"{igt}"
        " done"
    )


def _pci_script() -> str:
    """Shell that prints the vendor of every display-class PCI device, which numbers the cards stably."""
    return ("for c in /sys/bus/pci/devices/*/class; do"
            " { read -r cls < \"$c\"; } 2>/dev/null || continue;"
            " case \"$cls\" in 0x03*) { read -r v < \"${c%/class}/vendor\"; } 2>/dev/null"
            " && echo \"@@PCI $v\";; esac; done")


def _float(value: Optional[str]) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


def _parse_nvidia_rows(lines: List[str]) -> List[Dict[str, Any]]:
    """Parse nvidia-smi CSV rows into one card dict per GPU; power and clock are optional since some cards report [N/A]."""
    cards = []
    for line in lines:
        fields = [field.strip() for field in line.split(',')]
        if len(fields) < 5:
            continue
        try:
            index     = int(fields[0])
            util      = float(fields[1])
            mem_used  = float(fields[2])
            mem_total = float(fields[3])
            temp      = float(fields[4])
        except ValueError:
            continue
        metrics = {'util': util, 'temp': temp,
                   'mem_pct': (100.0 * mem_used / mem_total) if mem_total > 0 else 0.0}
        for key, field in (('power_w', 5), ('clock_mhz', 6)):
            value = _float(fields[field]) if len(fields) > field else None
            if value is not None:
                metrics[key] = value
        cards.append({'index': index, 'vendor': 'nvidia', 'metrics': metrics})
    return cards


def _looks_absent(text: str) -> bool:
    """True when nvidia-smi's error says the GPU or its driver is missing rather than broken."""
    text = text.lower()
    return ('command not found' in text or 'not found' in text
            or "couldn't communicate" in text or 'no devices' in text)


def _intel_gpu_top_sample(text: str) -> Optional[Dict[str, Any]]:
    """The last complete sample in intel_gpu_top's JSON output, which may be an unterminated array of objects."""
    decoder = json.JSONDecoder()
    sample, pos = None, 0
    while True:
        start = text.find('{', pos)
        if start < 0:
            return sample
        try:
            obj, pos = decoder.raw_decode(text, start)
        except ValueError:
            return sample
        if isinstance(obj, dict) and isinstance(obj.get('engines'), dict):
            sample = obj


def _apply_intel_gpu_top(metrics: Dict[str, float], sample: Dict[str, Any]) -> None:
    """Take utilization as the busiest engine, plus GPU power and the actual clock when sysfs had none."""
    busy = [e.get('busy') for e in sample['engines'].values() if isinstance(e, dict)]
    busy = [float(b) for b in busy if isinstance(b, (int, float))]
    if busy:
        metrics['util'] = max(busy)
    power = (sample.get('power') or {}).get('GPU')
    if isinstance(power, (int, float)):
        metrics['power_w'] = float(power)
    actual = (sample.get('frequency') or {}).get('actual')
    if isinstance(actual, (int, float)) and 'clock_mhz' not in metrics:
        metrics['clock_mhz'] = float(actual)


def _sysfs_metrics(files: Dict[str, List[str]]) -> Dict[str, float]:
    """Turn one card's sysfs readings into the shared metric names."""
    def first(key: str) -> Optional[float]:
        return _float(files[key][0]) if key in files else None

    metrics: Dict[str, float] = {}
    for key, name in (('device/gpu_busy_percent', 'util'), ('device/mem_busy_percent', 'mem_busy_pct')):
        value = first(key)
        if value is not None:
            metrics[name] = value

    used, total = first('device/mem_info_vram_used'), first('device/mem_info_vram_total')
    if used is not None and total:
        metrics['mem_pct'] = 100.0 * used / total

    for line in files.get('device/pp_dpm_sclk', []):
        match = re.search(r'(\d+)\s*mhz\s*\*', line, re.IGNORECASE)
        if match:
            metrics['clock_mhz'] = float(match.group(1))
    clock = first('gt_act_freq_mhz')
    if clock is None:
        clock = first('device/tile0/gt0/freqs/act_freq')
    if clock is not None and 'clock_mhz' not in metrics:
        metrics['clock_mhz'] = clock

    temps: Dict[str, Dict[str, str]] = {}
    for key, values in files.items():
        match = re.match(r'device/hwmon/(hwmon\d+)/(temp\d+)_(input|label)$', key)
        if match:
            temps.setdefault(f'{match[1]}/{match[2]}', {})[match[3]] = values[0]
    unlabelled = []
    for sensor in sorted(temps, key=lambda s: [int(n) for n in re.findall(r'\d+', s)]):
        value = _float(temps[sensor].get('input'))
        if value is None:
            continue
        name = _TEMP_LABELS.get(temps[sensor].get('label', '').strip().lower())
        if name and name not in metrics:
            metrics[name] = value / 1000.0
        elif not name:
            unlabelled.append(value / 1000.0)
    if 'temp' not in metrics and unlabelled:
        metrics['temp'] = unlabelled[0]

    for key, values in sorted(files.items()):
        if re.match(r'device/hwmon/hwmon\d+/power1_(average|input)$', key) and 'power_w' not in metrics:
            value = _float(values[0])
            if value is not None:
                metrics['power_w'] = value / 1_000_000.0
    return metrics


def _parse_output(stdout: str) -> Dict[str, Any]:
    """Split the probe's output into its PCI inventory, sysfs cards and nvidia-smi section."""
    parsed: Dict[str, Any] = {'pci': [], 'cards': [], 'nvidia': None, 'nvidia_exit': None,
                              'nvidia_missing': False}
    card: Optional[Dict[str, Any]] = None
    block: Optional[List[str]] = None
    for line in stdout.splitlines():
        if line.startswith('@@IGT_END'):
            if card is not None and block is not None:
                card['igt'] = '\n'.join(block)
            block = None
        elif line.startswith('@@NVIDIA_EXIT'):
            parsed['nvidia'] = block or []
            parsed['nvidia_exit'] = int(_float(line.split()[-1]) or 0)
            block = None
        elif block is not None:
            block.append(line)
        elif line.startswith('@@PCI '):
            parsed['pci'].append(line.split()[-1])
        elif line.startswith('@@CARD '):
            parts = line.split()
            card = {'name': parts[1], 'vendor': _VENDOR_BY_ID.get(parts[2], parts[2]),
                    'files': {}, 'asleep': False}
            parsed['cards'].append(card)
        elif line == '@@ASLEEP' and card is not None:
            card['asleep'] = True
        elif line == '@@IGT' or line == '@@NVIDIA':
            block = []
            if line == '@@NVIDIA':
                card = None
        elif line == '@@NVIDIA_MISSING':
            parsed['nvidia_missing'] = True
            card = None
        elif card is not None and ':' in line:
            path, _, value = line.partition(':')
            prefix = f"/sys/class/drm/{card['name']}/"
            if path.startswith(prefix):
                card['files'].setdefault(path[len(prefix):], []).append(value.strip())
    return parsed


def _card_number(name: str) -> int:
    digits = re.sub(r'\D', '', name)
    return int(digits) if digits else 0


class Gpu(SignalPlugin):
    """GPU utilization, VRAM, temperature, power and clock for every NVIDIA,
    AMD and Intel card on the host, in one command per cycle. The worst card
    sets the status; each card also keeps its own metric family.

    NVIDIA cards come from nvidia-smi and keep its indices; AMD and Intel cards
    come from /sys/class/drm and are numbered after the host's NVIDIA cards.
    Intel utilization needs intel_gpu_top with perf access, and is left out
    rather than guessed from the clock when that is missing.

    A wedged NVIDIA driver leaves nvidia-smi in uninterruptible sleep, where the
    connector's terminate/kill has no effect, so every poll would strand another
    process until the host reboots. Repeated timeouts therefore suspend
    nvidia-smi instead of adding one stuck process per interval, while the other
    cards keep reporting."""

    _COMMAND_TIMEOUT = 15.0

    def __init__(self, name: str, config: PluginConfig):
        super().__init__(name, config)
        self.util_warning   = float(config.get('util_warning',   85))
        self.util_threshold = float(config.get('util_threshold', 95))
        self.mem_warning    = float(config.get('mem_warning',    85))
        self.mem_threshold  = float(config.get('mem_threshold',  95))
        self.temp_warning   = float(config.get('temp_warning',   80))
        self.temp_threshold = float(config.get('temp_threshold', 90))
        self.timeout_trip     = int(config.get('timeout_trip',      2))
        self.suspend_seconds  = float(config.get('suspend_seconds', 1800.0))
        self.intel_gpu_top    = bool(config.get('intel_gpu_top', True))
        self.vendors, self._unknown_vendors = self._vendors(config.get('vendor', 'auto'))
        self._consecutive_timeouts = 0
        self._suspended_until = 0.0

    @staticmethod
    def _vendors(value: Any) -> tuple:
        """The vendors to probe from `vendor:` (auto, one name, or a list), plus any names it did not recognise."""
        names = value if isinstance(value, list) else str(value).replace(',', ' ').split()
        names = [str(n).strip().lower() for n in names]
        unknown = [n for n in names if n not in _PCI_VENDORS and n != 'auto']
        known = [v for v in _PCI_VENDORS if v in names]
        if 'auto' in names or not known:
            return list(_PCI_VENDORS), unknown
        return known, unknown

    def _suspended(self) -> bool:
        return time.monotonic() < self._suspended_until

    def _card_level(self, metrics: Dict[str, float]) -> str:
        levels = []
        if 'util' in metrics:
            levels.append(level_for(metrics['util'], self.util_warning, self.util_threshold))
        if 'mem_pct' in metrics:
            levels.append(level_for(metrics['mem_pct'], self.mem_warning, self.mem_threshold))
        if 'temp' in metrics:
            levels.append(level_for(metrics['temp'], self.temp_warning, self.temp_threshold))
        return _worst(levels)

    def _item_level(self, item):
        """Color one card's chip by its own worst reading against this monitor's thresholds."""
        return item.get('level') or 'online'

    @staticmethod
    def _item_text(item: Dict[str, Any]) -> str:
        """One card's readings in a line: utilization, VRAM, temperature, power and clock where known."""
        if item.get('asleep'):
            return 'asleep'
        parts = [f"{item['util']:.0f}%" if item.get('util') is not None else 'util ?']
        if item.get('mem_pct') is not None:
            parts.append(f"VRAM {item['mem_pct']:.0f}%")
        if item.get('temp') is not None:
            parts.append(f"{item['temp']:.0f}°C")
        if item.get('power_w') is not None:
            parts.append(f"{item['power_w']:.0f} W")
        if item.get('clock_mhz') is not None:
            parts.append(f"{item['clock_mhz']:.0f} MHz")
        return '  ·  '.join(parts)

    SAMPLED = True

    def commands(self) -> List[Command]:
        parts = [_pci_script()]
        sysfs_ids = [_PCI_VENDORS[v] for v in self.vendors if v != 'nvidia']
        if sysfs_ids:
            parts.append(_sysfs_script(sysfs_ids, self.intel_gpu_top and 'intel' in self.vendors))
        if 'nvidia' in self.vendors and not self._suspended():
            parts.append(_nvidia_script())
        parts.append('exit 0')
        return [Command('; '.join(parts), timeout=self._COMMAND_TIMEOUT)]

    def _suspended_message(self) -> str:
        minutes = self.suspend_seconds / 60.0
        return (f"nvidia-smi timed out {self._consecutive_timeouts}x and could not be killed — the "
                f"driver is wedged and only a reboot clears it; probe suspended for {minutes:.0f}m")

    def _nvidia_cards(self, parsed: Dict[str, Any], notes: List[str]) -> tuple:
        """NVIDIA cards from the nvidia-smi section, and whether nvidia-smi reported an error of its own."""
        if 'nvidia' not in self.vendors:
            return [], False
        has_nvidia = _PCI_VENDORS['nvidia'] in parsed['pci']
        if self._suspended():
            if has_nvidia:
                notes.append(self._suspended_message())
            return [], False
        if parsed['nvidia_missing'] or parsed['nvidia'] is None:
            if has_nvidia:
                notes.append("an NVIDIA GPU is present but nvidia-smi is not installed")
            return [], False
        lines, code = parsed['nvidia'], parsed['nvidia_exit']
        text = '\n'.join(lines).strip()
        if code:
            if _looks_absent(text):
                if has_nvidia:
                    notes.append(f"nvidia-smi found no usable GPU: {text}")
                return [], False
            notes.append(f"nvidia-smi failed: {text}")
            return [], True
        cards = _parse_nvidia_rows(lines)
        if not cards and text:
            notes.append(f"no GPUs parsed from nvidia-smi output: {text!r}")
        return cards, False

    def _sysfs_cards(self, parsed: Dict[str, Any], first_index: int, notes: List[str]) -> List[Dict[str, Any]]:
        """AMD and Intel cards from sysfs, numbered from first_index in DRM card order."""
        cards = []
        no_intel_util = []
        for offset, raw in enumerate(sorted(parsed['cards'], key=lambda c: _card_number(c['name']))):
            index = first_index + offset
            if raw['asleep']:
                cards.append({'index': index, 'vendor': raw['vendor'], 'asleep': True,
                              'metrics': {'util': 0.0}})
                continue
            metrics = _sysfs_metrics(raw['files'])
            sample = _intel_gpu_top_sample(raw.get('igt', ''))
            if sample is not None:
                _apply_intel_gpu_top(metrics, sample)
            if raw['vendor'] == 'intel' and 'util' not in metrics:
                no_intel_util.append(f"GPU {index}")
            cards.append({'index': index, 'vendor': raw['vendor'], 'asleep': False, 'metrics': metrics})
        if no_intel_util:
            reason = ('intel_gpu_top gave no sample (it needs CAP_PERFMON or '
                      'kernel.perf_event_paranoid <= 0)' if self.intel_gpu_top
                      else 'intel_gpu_top is turned off')
            notes.append(f"utilization unknown for Intel {', '.join(no_intel_util)}: {reason}")
        return cards

    def parse(self, results: List[CmdResult]) -> CollectResult:
        """Turns the combined probe output into per-card and peak metrics, a
        per-card snapshot, one summary log line, and the worst card's status;
        a wedged driver trips the suspend breaker and no GPU at all reports
        unavailable."""
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr

        if ret != 0 and 'timed out after' in stderr.lower():
            self._consecutive_timeouts += 1
            if self._consecutive_timeouts >= self.timeout_trip and 'nvidia' in self.vendors:
                self._suspended_until = time.monotonic() + self.suspend_seconds
                return CollectResult.unavailable(self._suspended_message())
            return CollectResult.unavailable(f"GPU collection failed: {stderr}")
        if ret != 0:
            return CollectResult.unavailable(f"GPU collection failed: {stderr}")
        if not self._suspended():
            self._consecutive_timeouts = 0

        parsed = _parse_output(stdout)
        notes: List[str] = []
        if self._unknown_vendors:
            notes.append(f"ignored unknown vendor {', '.join(self._unknown_vendors)} "
                         "(expected auto, nvidia, amd or intel)")
        nvidia_cards, nvidia_error = self._nvidia_cards(parsed, notes)
        nvidia_count = max([parsed['pci'].count(_PCI_VENDORS['nvidia'])]
                           + [c['index'] + 1 for c in nvidia_cards])
        cards = nvidia_cards + self._sysfs_cards(parsed, nvidia_count, notes)

        if not cards:
            if nvidia_error:
                return CollectResult.failed(f"GPU collection failed: {'; '.join(notes)}")
            wanted = ', '.join(_VENDOR_NAMES[v] for v in self.vendors)
            reason = '; '.join(notes) if notes else f"no {wanted} GPU found"
            return CollectResult.unavailable(f"No GPU to report: {reason}")

        metrics: Dict[str, float] = {}
        snapshot = []
        levels = ['failed'] if nvidia_error else []
        for card in cards:
            index, card_metrics = card['index'], card['metrics']
            for key, value in card_metrics.items():
                metrics[f'gpu{index}_{key}'] = value
            level = self._card_level(card_metrics)
            levels.append(level)
            snapshot.append({'label': f"GPU {index} {_VENDOR_NAMES.get(card['vendor'], card['vendor'])}",
                             'asleep': card.get('asleep', False), 'level': str(level), **card_metrics})

        summary = []
        for key, name, text in (('util', 'gpu_util', '{:.0f}% util'),
                                ('mem_pct', 'gpu_mem_pct', '{:.0f}% VRAM'),
                                ('temp', 'gpu_temp', '{:.0f}°C')):
            values = [c['metrics'][key] for c in cards if key in c['metrics']]
            if values:
                metrics[name] = max(values)
                summary.append(text.format(metrics[name]))

        status = _worst(levels)
        message = f"{len(cards)} GPU(s): peak {', '.join(summary)}" if summary else f"{len(cards)} GPU(s)"
        if notes:
            message += f" ({'; '.join(notes)})"
        return CollectResult(
            metrics=metrics,
            logs=[(message, Status(status).log_level)],
            status=status,
            snapshot=snapshot,
        )

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'gpu_util_card': {'metric': 'gpu_util', 'title': 'GPU', 'format': 'percent0',
                              'color': {'warning': self.util_warning, 'threshold': self.util_threshold}},
            'gpu_mem_card': {'metric': 'gpu_mem_pct', 'title': 'VRAM', 'format': 'percent0',
                             'color': {'warning': self.mem_warning, 'threshold': self.mem_threshold}},
            'gpu_temp_card': {'metric': 'gpu_temp', 'title': 'GPU TEMP', 'format': 'temp_c0',
                              'color': {'warning': self.temp_warning, 'threshold': self.temp_threshold}},
            'gpus': {
                'repeat': {
                    'source': 'snapshot',
                    'item_format_fn': self._item_text,
                    'item_color_by': self._item_level,
                    'empty_text': 'No GPUs found',
                },
            },
        }

    def card_row(self) -> List[str]:
        return ['gpu_util_card', 'gpu_mem_card', 'gpu_temp_card']

    def rows(self) -> List[List[str]]:
        return [['gpus']]

    def charts(self) -> Dict[str, Dict[str, Any]]:
        return {'gpu_chart': {'metric': 'gpu_util', 'title': 'GPU UTILIZATION (%)'}}
