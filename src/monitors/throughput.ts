// Network interface throughput, sampled from /proc/net/dev.

import { format_fixed, parse_int, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { CardSpec, ChartSpec } from "../shared/ui_spec.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

const virtual_prefixes = ["lo", "veth", "docker", "virbr", "br-", "tun", "tap"];

// ── Parsing ──────────────────────────────────────────────────────────────────

// Each interface's [rx bytes, tx bytes] from one /proc/net/dev block.
export function parse_net_dev(block: string): Map<string, [rx: number, tx: number]> {
  const result = new Map<string, [number, number]>();
  for (const raw of split_lines(block)) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const fields = split_words(line.slice(colon + 1));
    if (fields.length < 9) continue;
    try {
      result.set(line.slice(0, colon).trim(), [parse_int(fields[0]), parse_int(fields[8])]);
    } catch {
      continue;
    }
  }
  return result;
}

// The non-virtual interface with the most cumulative traffic, if any.
export function busiest_interface(stats: Map<string, [number, number]>): string | null {
  let best: string | null = null;
  let best_total = 0;
  for (const [name, [rx, tx]] of stats) {
    if (virtual_prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (best === null || rx + tx > best_total) [best, best_total] = [name, rx + tx];
  }
  return best;
}

export function format_rate(kbps: number): string {
  if (kbps >= 1024) return `${format_fixed((kbps / 1024), 1)} MB/s`;
  return `${format_fixed(kbps, 1)} KB/s`;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Interface throughput from two /proc/net/dev samples a second apart, taken on the target so the sleep costs one round
// trip rather than two.
export class Throughput extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly interface: string | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.interface = (config.interface as string | null | undefined) ?? null;
  }

  get setting_key(): string {
    return `network:${this.id}:throughput_interface`;
  }

  override commands(): Command[] {
    return [command("cat /proc/net/dev && sleep 1 && cat /proc/net/dev")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Failed to read /proc/net/dev: ${stderr}`);

    const halves = stdout.split("Inter-|");
    if (halves.length < 3) return CollectResult.unavailable("Unexpected /proc/net/dev output format");

    const sample1 = parse_net_dev(halves[1]);
    const sample2 = parse_net_dev(halves[2]);
    const interface_name = this.interface || busiest_interface(sample1);
    if (!interface_name) return CollectResult.unavailable("No usable network interface found");
    const first = sample1.get(interface_name);
    const second = sample2.get(interface_name);
    if (first === undefined || second === undefined) return CollectResult.unavailable(`Interface '${interface_name}' not found in /proc/net/dev`);

    const rx_kbps = Math.max(0, (second[0] - first[0]) / 1024);
    const tx_kbps = Math.max(0, (second[1] - first[1]) / 1024);
    return new CollectResult({
      metrics: { rx_kbps, tx_kbps },
      logs: [[`Interface ${interface_name}: RX ${format_rate(rx_kbps)}, TX ${format_rate(tx_kbps)}`, "INFO"]],
      status: "online",
      settings: { [this.setting_key]: interface_name },
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get active_interface_text(): string {
    return this.data.get_setting(this.setting_key) || this.interface || "Detecting...";
  }

  override cards(): Record<string, CardSpec> {
    return {
      iface_card: { title: "INTERFACE", value_attr: "active_interface_text", refresh: true },
      rx_card: { metric: "rx_kbps", title: "DOWNLOAD", format: "kbps_rate" },
      tx_card: { metric: "tx_kbps", title: "UPLOAD", format: "kbps_rate" },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return {
      rx_chart: {
        title: "THROUGHPUT (KB/s)", style: "mirror",
        series: [{ metric: "rx_kbps", label: "Download" }, { metric: "tx_kbps", label: "Upload" }],
      },
    };
  }
}
