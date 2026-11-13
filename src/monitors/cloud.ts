// Cloud-instance detection: whether the target runs on AWS, GCP, or Azure, established by curling the
// 169.254.169.254 metadata endpoint with commands on the target. Config: provider ("auto" tries all three, or name one
// to probe just it). A recognized provider is online, with its instance fields stored as a setting for the summary
// cards and as the snapshot behind the detail cards; no responding metadata endpoint is unavailable rather than
// failed, since not being a cloud host is a finding, not an error.

import { python_dumps } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";

// ── Commands ─────────────────────────────────────────────────────────────────

const metadata_host = "169.254.169.254";

const aws_command =
  `T=$(curl -s -m 3 -X PUT 'http://${metadata_host}/latest/api/token' ` +
  "-H 'X-aws-ec2-metadata-token-ttl-seconds: 60'); " +
  '[ -z "$T" ] && exit 7; ' +
  `h(){ curl -s -m 3 -H "X-aws-ec2-metadata-token: $T" "http://${metadata_host}/latest/meta-data/$1"; }; ` +
  'echo "provider=aws"; ' +
  'echo "instance_id=$(h instance-id)"; ' +
  'echo "instance_type=$(h instance-type)"; ' +
  'echo "region=$(h placement/region)"; ' +
  'echo "az=$(h placement/availability-zone)"';

const gcp_command =
  `h(){ curl -s -m 3 -H 'Metadata-Flavor: Google' "http://${metadata_host}/computeMetadata/v1/$1"; }; ` +
  'ID=$(h instance/id); [ -z "$ID" ] && exit 7; ' +
  'echo "provider=gcp"; ' +
  'echo "instance_id=$ID"; ' +
  "echo \"instance_type=$(h instance/machine-type | awk -F/ '{print $NF}')\"; " +
  "echo \"zone=$(h instance/zone | awk -F/ '{print $NF}')\"";

const azure_command =
  "J=$(curl -s -m 3 -H 'Metadata:true' " +
  `'http://${metadata_host}/metadata/instance?api-version=2021-02-01'); ` +
  '[ -z "$J" ] && exit 7; ' +
  'echo "provider=azure"; ' +
  'echo "raw=$J"';

const default_layout: LayoutRow[] = [
  ["host_card", "provider_card", "type_card"],
  ["detail"],
  ["events"],
];

// ── Parsing ──────────────────────────────────────────────────────────────────

// Each "key=value" line as a field, split at the first "=".
export function parse_kv(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r\n|\r|\n/)) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Cloud extends Plugin {
  readonly provider: string;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.provider = String(config.provider ?? "auto").toLowerCase();
  }

  private provider_commands(): [string, string][] {
    const table: Record<string, string> = { aws: aws_command, gcp: gcp_command, azure: azure_command };
    if (Object.hasOwn(table, this.provider)) return [[this.provider, table[this.provider]]];
    return Object.entries(table);
  }

  override commands(): Command[] {
    return this.provider_commands().map(([, text]) => command(text));
  }

  override parse(results: CmdResult[]): CollectResult {
    for (const result of results) {
      if (result.exit_code === 7 || (result.exit_code !== 0 && !result.stdout.trim())) continue;

      const fields = parse_kv(result.stdout);
      if (!fields.provider) continue;

      const logs: LogEntry[] = Object.entries(fields).filter(([, value]) => value).map(([key, value]) => [`${key}=${value}`, "INFO"]);
      logs.push([`Detected ${fields.provider} instance ${fields.instance_id ?? "?"} (${fields.instance_type ?? "?"})`, "INFO"]);
      const details = ["instance_id", "region", "az", "zone"]
        .filter((key) => fields[key])
        .map((key) => ({ label: key.replaceAll("_", " ").toUpperCase(), value: String(fields[key]) }));
      return new CollectResult({ metrics: { on_cloud: 1.0 }, logs, status: "online", snapshot: details, settings: { [`cloud:${this.id}`]: python_dumps(fields) } });
    }

    return new CollectResult({
      metrics: { on_cloud: 0.0 },
      logs: [["No cloud metadata endpoint responded — not a recognized cloud host", "INFO"]],
      status: "unavailable",
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private cloud_fields(): Record<string, unknown> {
    const raw = this.data.get_setting(`cloud:${this.id}`);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  get provider_text(): string {
    const fields = this.cloud_fields();
    if (Object.keys(fields).length === 0) return "NONE";
    return String(fields.provider ?? "--").toUpperCase();
  }

  get instance_type_text(): string {
    return String(this.cloud_fields().instance_type ?? "--");
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        provider_card: { title: "PROVIDER", value_attr: "provider_text" },
        type_card: { title: "INSTANCE TYPE", value_attr: "instance_type_text" },
        detail: { repeat: { container: "cards", empty_text: "No cloud metadata" } },
      },
      events: true,
    };
  }
}
