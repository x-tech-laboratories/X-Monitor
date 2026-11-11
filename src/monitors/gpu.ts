// GPU utilization, memory, temperature, power and clock for NVIDIA, AMD and Intel cards, from nvidia-smi and
// /sys/class/drm in one command. No GPU at all, a probe timeout, or a wedged NVIDIA driver is unavailable; nvidia-smi
// reporting an error of its own is failed.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, LayoutRow } from "../shared/ui_spec.ts";
import { level_for, limit_from, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin, worst_status } from "./base/signal_plugin.ts";
import { float_or_null, format_fixed, parse_float, parse_int, partition, split_lines, split_words } from "./base/text_parsing.ts";

const pci_vendors: Record<string, string> = { nvidia: "0x10de", amd: "0x1002", intel: "0x8086" };
const vendor_names: Record<string, string> = { nvidia: "NVIDIA", amd: "AMD", intel: "Intel" };
const vendor_by_id: Record<string, string> = Object.fromEntries(Object.entries(pci_vendors).map(([vendor, pci_id]) => [pci_id, vendor]));

const nvidia_query = "nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm --format=csv,noheader,nounits";

// The sysfs files read per card; missing ones stay unexpanded and grep -s skips them silently.
const sysfs_files = [
  ...["device/gpu_busy_percent", "device/mem_busy_percent", "device/mem_info_vram_used", "device/mem_info_vram_total", "device/pp_dpm_sclk", "gt_act_freq_mhz", "device/tile0/gt0/freqs/act_freq"].map((path) => `"$d"/${path}`),
  ...["temp*_input", "temp*_label", "power1_average", "power1_input"].map((name) => `"$d"/device/hwmon/hwmon*/${name}`),
].join(" ");

// hwmon temperature labels mapped to the metric suffix they feed.
const temp_labels: Record<string, string> = { edge: "temp", pkg: "temp", junction: "temp_junction", mem: "temp_mem", vram: "temp_mem" };

// ── Probe scripts ────────────────────────────────────────────────────────────

function nvidia_script(): string {
  return `if command -v nvidia-smi >/dev/null 2>&1; then echo @@NVIDIA; ${nvidia_query} 2>&1; echo "@@NVIDIA_EXIT $?"; else echo @@NVIDIA_MISSING; fi`;
}

// Prints each AMD or Intel card's sysfs readings, skipping a runtime-suspended card so polling never wakes it.
function sysfs_script(vendor_ids: string[], intel_gpu_top: boolean): string {
  const igt = intel_gpu_top
    ? ' if [ "$v" = 0x8086 ] && command -v intel_gpu_top >/dev/null 2>&1; then echo @@IGT; timeout -s INT 2 intel_gpu_top -J -s 500 -d "drm:/dev/dri/${d##*/}" 2>/dev/null; echo; echo @@IGT_END; fi;'
    : "";
  return (
    "for d in /sys/class/drm/card*; do" +
    ' case "${d##*/}" in *-*) continue;; esac;' +
    ' { read -r v < "$d/device/vendor"; } 2>/dev/null || continue;' +
    ` case "$v" in ${vendor_ids.join("|")}) ;; *) continue;; esac;` +
    ' echo "@@CARD ${d##*/} $v";' +
    ' rt=; { read -r rt < "$d/device/power/runtime_status"; } 2>/dev/null;' +
    ' if [ "$rt" = suspended ]; then echo @@ASLEEP; continue; fi;' +
    ` grep -Hs . ${sysfs_files};` +
    igt +
    " done"
  );
}

// Prints the vendor of every display-class PCI device, which numbers the cards stably.
function pci_script(): string {
  return 'for c in /sys/bus/pci/devices/*/class; do { read -r cls < "$c"; } 2>/dev/null || continue; case "$cls" in 0x03*) { read -r v < "${c%/class}/vendor"; } 2>/dev/null && echo "@@PCI $v";; esac; done';
}

// ── Parsing ──────────────────────────────────────────────────────────────────

type CardMetrics = Record<string, number>;

interface GpuCard {
  index: number;
  vendor: string;
  asleep?: boolean;
  metrics: CardMetrics;
}

interface RawCard {
  name: string;
  vendor: string;
  files: Map<string, string[]>;
  asleep: boolean;
  igt?: string;
}

interface ParsedOutput {
  pci: string[];
  cards: RawCard[];
  nvidia: string[] | null;
  nvidia_exit: number | null;
  nvidia_missing: boolean;
}

function to_float(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : float_or_null(value);
}

// nvidia-smi CSV rows as one card per GPU; power and clock are optional since some cards report [N/A].
function parse_nvidia_rows(lines: string[]): GpuCard[] {
  const cards: GpuCard[] = [];
  for (const line of lines) {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 5) continue;
    let index: number, util: number, mem_used: number, mem_total: number, temp: number;
    try {
      index = parse_int(fields[0]);
      util = parse_float(fields[1]);
      mem_used = parse_float(fields[2]);
      mem_total = parse_float(fields[3]);
      temp = parse_float(fields[4]);
    } catch {
      continue;
    }
    const metrics: CardMetrics = { util, temp, mem_pct: mem_total > 0 ? (100 * mem_used) / mem_total : 0 };
    for (const [key, field] of [["power_w", 5], ["clock_mhz", 6]] as const) {
      const value = fields.length > field ? to_float(fields[field]) : null;
      if (value !== null) metrics[key] = value;
    }
    cards.push({ index, vendor: "nvidia", metrics });
  }
  return cards;
}

// Whether nvidia-smi's error says the GPU or its driver is missing rather than broken.
function looks_absent(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("command not found") || lower.includes("not found") || lower.includes("couldn't communicate") || lower.includes("no devices");
}

// The end of the JSON value that starts at `start`, or -1 when the text stops before it closes.
function json_value_end(text: string, start: number): number {
  let depth = 0;
  let in_string = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (in_string) {
      if (character === "\\") index++;
      else if (character === '"') in_string = false;
    } else if (character === '"') {
      in_string = true;
    } else if (character === "{" || character === "[") {
      depth++;
    } else if (character === "}" || character === "]") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

// The last complete sample in intel_gpu_top's JSON output, which may be an unterminated array of objects.
export function intel_gpu_top_sample(text: string): Record<string, unknown> | null {
  let sample: Record<string, unknown> | null = null;
  let position = 0;
  for (;;) {
    const start = text.indexOf("{", position);
    if (start < 0) return sample;
    const end = json_value_end(text, start);
    if (end < 0) return sample;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(start, end));
    } catch {
      return sample;
    }
    position = end;
    const record = value as Record<string, unknown>;
    if (typeof record === "object" && record !== null && !Array.isArray(record) && typeof record.engines === "object" && record.engines !== null && !Array.isArray(record.engines)) sample = record;
  }
}

const is_number = (value: unknown): value is number => typeof value === "number";

// Utilization as the busiest engine, plus GPU power and the actual clock when sysfs had none.
function apply_intel_gpu_top(metrics: CardMetrics, sample: Record<string, unknown>): void {
  const busy = Object.values(sample.engines as Record<string, unknown>)
    .filter((engine): engine is Record<string, unknown> => typeof engine === "object" && engine !== null && !Array.isArray(engine))
    .map((engine) => engine.busy)
    .filter(is_number);
  if (busy.length > 0) metrics.util = Math.max(...busy);
  const power = ((sample.power as Record<string, unknown> | null | undefined) || {}).GPU;
  if (is_number(power)) metrics.power_w = power;
  const actual = ((sample.frequency as Record<string, unknown> | null | undefined) || {}).actual;
  if (is_number(actual) && !("clock_mhz" in metrics)) metrics.clock_mhz = actual;
}

// The digits in a sensor path as numbers, so hwmon10 sorts after hwmon9.
function numeric_key(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map(Number);
}

function compare_numeric_keys(first: number[], second: number[]): number {
  for (let index = 0; index < Math.min(first.length, second.length); index++) if (first[index] !== second[index]) return first[index] - second[index];
  return first.length - second.length;
}

// One card's sysfs readings under the shared metric names.
function sysfs_metrics(files: Map<string, string[]>): CardMetrics {
  const first = (key: string): number | null => (files.has(key) ? to_float(files.get(key)![0]) : null);

  const metrics: CardMetrics = {};
  for (const [key, name] of [["device/gpu_busy_percent", "util"], ["device/mem_busy_percent", "mem_busy_pct"]]) {
    const value = first(key);
    if (value !== null) metrics[name] = value;
  }

  const used = first("device/mem_info_vram_used");
  const total = first("device/mem_info_vram_total");
  if (used !== null && total) metrics.mem_pct = (100 * used) / total;

  for (const line of files.get("device/pp_dpm_sclk") ?? []) {
    const match = /(\d+)\s*mhz\s*\*/i.exec(line);
    if (match) metrics.clock_mhz = parse_float(match[1]);
  }
  let clock = first("gt_act_freq_mhz");
  if (clock === null) clock = first("device/tile0/gt0/freqs/act_freq");
  if (clock !== null && !("clock_mhz" in metrics)) metrics.clock_mhz = clock;

  const temps = new Map<string, Record<string, string>>();
  for (const [key, values] of files) {
    const match = /^device\/hwmon\/(hwmon\d+)\/(temp\d+)_(input|label)$/.exec(key);
    if (!match) continue;
    const sensor = `${match[1]}/${match[2]}`;
    if (!temps.has(sensor)) temps.set(sensor, {});
    temps.get(sensor)![match[3]] = values[0];
  }
  const unlabelled: number[] = [];
  for (const sensor of [...temps.keys()].sort((a, b) => compare_numeric_keys(numeric_key(a), numeric_key(b)))) {
    const value = to_float(temps.get(sensor)!.input);
    if (value === null) continue;
    const name = temp_labels[(temps.get(sensor)!.label ?? "").trim().toLowerCase()];
    if (name && !(name in metrics)) metrics[name] = value / 1000;
    else if (!name) unlabelled.push(value / 1000);
  }
  if (!("temp" in metrics) && unlabelled.length > 0) metrics.temp = unlabelled[0];

  for (const key of [...files.keys()].sort()) {
    if (/^device\/hwmon\/hwmon\d+\/power1_(average|input)$/.test(key) && !("power_w" in metrics)) {
      const value = to_float(files.get(key)![0]);
      if (value !== null) metrics.power_w = value / 1_000_000;
    }
  }
  return metrics;
}

// The probe's output split into its PCI inventory, sysfs cards and nvidia-smi section.
function parse_output(stdout: string): ParsedOutput {
  const parsed: ParsedOutput = { pci: [], cards: [], nvidia: null, nvidia_exit: null, nvidia_missing: false };
  let card: RawCard | null = null;
  let block: string[] | null = null;
  for (const line of split_lines(stdout)) {
    if (line.startsWith("@@IGT_END")) {
      if (card !== null && block !== null) card.igt = block.join("\n");
      block = null;
    } else if (line.startsWith("@@NVIDIA_EXIT")) {
      parsed.nvidia = block ?? [];
      parsed.nvidia_exit = Math.trunc(to_float(split_words(line).at(-1)) || 0);
      block = null;
    } else if (block !== null) {
      block.push(line);
    } else if (line.startsWith("@@PCI ")) {
      parsed.pci.push(split_words(line).at(-1)!);
    } else if (line.startsWith("@@CARD ")) {
      const parts = split_words(line);
      card = { name: parts[1], vendor: vendor_by_id[parts[2]] ?? parts[2], files: new Map(), asleep: false };
      parsed.cards.push(card);
    } else if (line === "@@ASLEEP" && card !== null) {
      card.asleep = true;
    } else if (line === "@@IGT" || line === "@@NVIDIA") {
      block = [];
      if (line === "@@NVIDIA") card = null;
    } else if (line === "@@NVIDIA_MISSING") {
      parsed.nvidia_missing = true;
      card = null;
    } else if (card !== null && line.includes(":")) {
      const [path, , value] = partition(line, ":");
      const prefix = `/sys/class/drm/${card.name}/`;
      if (path.startsWith(prefix)) {
        const key = path.slice(prefix.length);
        if (!card.files.has(key)) card.files.set(key, []);
        card.files.get(key)!.push(value.trim());
      }
    }
  }
  return parsed;
}

function card_number(name: string): number {
  const digits = name.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

// ── Page text ────────────────────────────────────────────────────────────────

// One card's readings in a line: utilization, VRAM, temperature, power and clock where known.
export function gpu_item_text(item: Record<string, unknown>): string {
  if (item.asleep) return "asleep";
  const known = (key: string): boolean => item[key] !== null && item[key] !== undefined;
  const parts = [known("util") ? `${format_fixed(Number(item.util), 0)}%` : "util ?"];
  if (known("mem_pct")) parts.push(`VRAM ${format_fixed(Number(item.mem_pct), 0)}%`);
  if (known("temp")) parts.push(`${format_fixed(Number(item.temp), 0)}°C`);
  if (known("power_w")) parts.push(`${format_fixed(Number(item.power_w), 0)} W`);
  if (known("clock_mhz")) parts.push(`${format_fixed(Number(item.clock_mhz), 0)} MHz`);
  return parts.join("  ·  ");
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Every NVIDIA, AMD and Intel card on the host in one command per cycle; the worst card sets the status and each card
// keeps its own metric family. NVIDIA cards come from nvidia-smi and keep its indices; AMD and Intel cards come from
// /sys/class/drm, numbered after the NVIDIA ones; Intel utilization needs intel_gpu_top with perf access and is left
// out rather than guessed. A wedged NVIDIA driver leaves nvidia-smi in uninterruptible sleep that no kill clears, so
// repeated timeouts suspend nvidia-smi instead of stranding one process per interval, while other cards keep reporting.
export class Gpu extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly COMMAND_TIMEOUT = 15.0;
  readonly util_warning: number | null;
  readonly util_threshold: number | null;
  readonly mem_warning: number | null;
  readonly mem_threshold: number | null;
  readonly temp_warning: number | null;
  readonly temp_threshold: number | null;
  readonly timeout_trip: number;
  readonly suspend_seconds: number;
  readonly intel_gpu_top: boolean;
  readonly vendors: string[];
  private readonly unknown_vendors: string[];
  private consecutive_timeouts = 0;
  private suspended_until = 0;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.util_warning = limit_from(config, "util_warning", 85);
    this.util_threshold = limit_from(config, "util_threshold", 95);
    this.mem_warning = limit_from(config, "mem_warning", 85);
    this.mem_threshold = limit_from(config, "mem_threshold", 95);
    this.temp_warning = limit_from(config, "temp_warning", 80);
    this.temp_threshold = limit_from(config, "temp_threshold", 90);
    this.timeout_trip = parse_int(config.timeout_trip ?? 2);
    this.suspend_seconds = parse_float(config.suspend_seconds ?? 1800.0);
    this.intel_gpu_top = Boolean(config.intel_gpu_top ?? true);
    [this.vendors, this.unknown_vendors] = Gpu.parse_vendors("vendor" in config ? config.vendor : "auto");
  }

  // The vendors to probe from `vendor:` (auto, one name, or a list), plus any names it did not recognise.
  static parse_vendors(value: unknown): [vendors: string[], unknown: string[]] {
    const raw = Array.isArray(value) ? value : split_words((value === null || value === undefined ? "None" : String(value)).replaceAll(",", " "));
    const names = raw.map((name) => String(name).trim().toLowerCase());
    const unknown = names.filter((name) => !(name in pci_vendors) && name !== "auto");
    const known = Object.keys(pci_vendors).filter((vendor) => names.includes(vendor));
    if (names.includes("auto") || known.length === 0) return [Object.keys(pci_vendors), unknown];
    return [known, unknown];
  }

  // Whether the nvidia-smi breaker is open.
  suspended(): boolean {
    return performance.now() / 1000 < this.suspended_until;
  }

  private card_level(metrics: CardMetrics): Status {
    const levels: Status[] = [];
    if ("util" in metrics) levels.push(level_for(metrics.util, this.util_warning, this.util_threshold));
    if ("mem_pct" in metrics) levels.push(level_for(metrics.mem_pct, this.mem_warning, this.mem_threshold));
    if ("temp" in metrics) levels.push(level_for(metrics.temp, this.temp_warning, this.temp_threshold));
    return worst_status(levels);
  }

  // One card's chip, by its own worst reading against this monitor's thresholds.
  readonly item_level = (item: Record<string, unknown>): Status => (item.level as Status | undefined) || "online";

  readonly item_text = gpu_item_text;

  override commands(): Command[] {
    const parts = [pci_script()];
    const sysfs_ids = this.vendors.filter((vendor) => vendor !== "nvidia").map((vendor) => pci_vendors[vendor]);
    if (sysfs_ids.length > 0) parts.push(sysfs_script(sysfs_ids, this.intel_gpu_top && this.vendors.includes("intel")));
    if (this.vendors.includes("nvidia") && !this.suspended()) parts.push(nvidia_script());
    parts.push("exit 0");
    return [command(parts.join("; "), { timeout: this.COMMAND_TIMEOUT })];
  }

  private suspended_message(): string {
    const minutes = this.suspend_seconds / 60;
    return `nvidia-smi timed out ${this.consecutive_timeouts}x and could not be killed — the driver is wedged and only a reboot clears it; probe suspended for ${format_fixed(minutes, 0)}m`;
  }

  // NVIDIA cards from the nvidia-smi section, and whether nvidia-smi reported an error of its own.
  private nvidia_cards(parsed: ParsedOutput, notes: string[]): [cards: GpuCard[], error: boolean] {
    if (!this.vendors.includes("nvidia")) return [[], false];
    const has_nvidia = parsed.pci.includes(pci_vendors.nvidia);
    if (this.suspended()) {
      if (has_nvidia) notes.push(this.suspended_message());
      return [[], false];
    }
    if (parsed.nvidia_missing || parsed.nvidia === null) {
      if (has_nvidia) notes.push("an NVIDIA GPU is present but nvidia-smi is not installed");
      return [[], false];
    }
    const lines = parsed.nvidia;
    const text = lines.join("\n").trim();
    if (parsed.nvidia_exit) {
      if (looks_absent(text)) {
        if (has_nvidia) notes.push(`nvidia-smi found no usable GPU: ${text}`);
        return [[], false];
      }
      notes.push(`nvidia-smi failed: ${text}`);
      return [[], true];
    }
    const cards = parse_nvidia_rows(lines);
    if (cards.length === 0 && text) notes.push(`no GPUs parsed from nvidia-smi output: ${JSON.stringify(text)}`);
    return [cards, false];
  }

  // AMD and Intel cards from sysfs, numbered from first_index in DRM card order.
  private sysfs_cards(parsed: ParsedOutput, first_index: number, notes: string[]): GpuCard[] {
    const cards: GpuCard[] = [];
    const no_intel_util: string[] = [];
    const ordered = [...parsed.cards].sort((a, b) => card_number(a.name) - card_number(b.name));
    ordered.forEach((raw, offset) => {
      const index = first_index + offset;
      if (raw.asleep) {
        cards.push({ index, vendor: raw.vendor, asleep: true, metrics: { util: 0 } });
        return;
      }
      const metrics = sysfs_metrics(raw.files);
      const sample = intel_gpu_top_sample(raw.igt ?? "");
      if (sample !== null) apply_intel_gpu_top(metrics, sample);
      if (raw.vendor === "intel" && !("util" in metrics)) no_intel_util.push(`GPU ${index}`);
      cards.push({ index, vendor: raw.vendor, asleep: false, metrics });
    });
    if (no_intel_util.length > 0) {
      const reason = this.intel_gpu_top ? "intel_gpu_top gave no sample (it needs CAP_PERFMON or kernel.perf_event_paranoid <= 0)" : "intel_gpu_top is turned off";
      notes.push(`utilization unknown for Intel ${no_intel_util.join(", ")}: ${reason}`);
    }
    return cards;
  }

  // The combined probe output as per-card and peak metrics, a per-card snapshot, one summary log line and the worst
  // card's status; a wedged driver trips the suspend breaker and no GPU at all reports unavailable.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];

    if (exit_code !== 0 && stderr.toLowerCase().includes("timed out after")) {
      this.consecutive_timeouts += 1;
      if (this.consecutive_timeouts >= this.timeout_trip && this.vendors.includes("nvidia")) {
        this.suspended_until = performance.now() / 1000 + this.suspend_seconds;
        return CollectResult.unavailable(this.suspended_message());
      }
      return CollectResult.unavailable(`GPU collection failed: ${stderr}`);
    }
    if (exit_code !== 0) return CollectResult.unavailable(`GPU collection failed: ${stderr}`);
    if (!this.suspended()) this.consecutive_timeouts = 0;

    const parsed = parse_output(stdout);
    const notes: string[] = [];
    if (this.unknown_vendors.length > 0) notes.push(`ignored unknown vendor ${this.unknown_vendors.join(", ")} (expected auto, nvidia, amd or intel)`);
    const [nvidia_cards, nvidia_error] = this.nvidia_cards(parsed, notes);
    const nvidia_count = Math.max(parsed.pci.filter((vendor) => vendor === pci_vendors.nvidia).length, ...nvidia_cards.map((card) => card.index + 1));
    const cards = [...nvidia_cards, ...this.sysfs_cards(parsed, nvidia_count, notes)];

    if (cards.length === 0) {
      if (nvidia_error) return CollectResult.failed(`GPU collection failed: ${notes.join("; ")}`);
      const wanted = this.vendors.map((vendor) => vendor_names[vendor]).join(", ");
      const reason = notes.length > 0 ? notes.join("; ") : `no ${wanted} GPU found`;
      return CollectResult.unavailable(`No GPU to report: ${reason}`);
    }

    const metrics: Record<string, number> = {};
    const snapshot: Record<string, unknown>[] = [];
    const levels: Status[] = nvidia_error ? ["failed"] : [];
    for (const card of cards) {
      for (const [key, value] of Object.entries(card.metrics)) metrics[`gpu${card.index}_${key}`] = value;
      const level = this.card_level(card.metrics);
      levels.push(level);
      snapshot.push({ label: `GPU ${card.index} ${vendor_names[card.vendor] ?? card.vendor}`, asleep: card.asleep ?? false, level, ...card.metrics });
    }

    const summary: string[] = [];
    for (const [key, name, unit] of [["util", "gpu_util", "% util"], ["mem_pct", "gpu_mem_pct", "% VRAM"], ["temp", "gpu_temp", "°C"]] as const) {
      const values = cards.filter((card) => key in card.metrics).map((card) => card.metrics[key]);
      if (values.length > 0) {
        metrics[name] = Math.max(...values);
        summary.push(`${format_fixed(metrics[name], 0)}${unit}`);
      }
    }

    const status = worst_status(levels);
    let message = summary.length > 0 ? `${cards.length} GPU(s): peak ${summary.join(", ")}` : `${cards.length} GPU(s)`;
    if (notes.length > 0) message += ` (${notes.join("; ")})`;
    return new CollectResult({ metrics, logs: [[message, log_level_of(status)]], status, snapshot });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      gpu_util_card: { kind: "gauge", metric: "gpu_util", title: "GPU", format: "percent0", color: { warning: this.util_warning, threshold: this.util_threshold } },
      gpu_mem_card: { kind: "gauge", metric: "gpu_mem_pct", title: "VRAM", format: "percent0", color: { warning: this.mem_warning, threshold: this.mem_threshold } },
      gpu_temp_card: { metric: "gpu_temp", title: "GPU TEMP", format: "temp_c0", color: { warning: this.temp_warning, threshold: this.temp_threshold } },
      gpus: {
        title: "GPUS",
        repeat: {
          source: "snapshot",
          item_format_fn: this.item_text,
          item_color_by: this.item_level,
          container: "bars",
          bar_value: "util",
          bar_marker: this.util_warning ?? undefined,
          empty_text: "No GPUs found",
        },
      },
    };
  }

  override card_row(): string[] {
    return ["gpu_util_card", "gpu_mem_card", "gpu_temp_card"];
  }

  override rows(): LayoutRow[] {
    return [["gpus"]];
  }

  override charts(): Record<string, ChartSpec> {
    return { gpu_chart: { metric: "gpu_util", title: "GPU UTILIZATION (%)" } };
  }
}
