// Container states from `<runtime> ps`, sampled on the host by the agent where there is one, with a restart action for
// each expected container, a Prune action, and image update detection. Config: runtime (docker by default),
// expect_running, stopped_warning, update_check_interval, update_warning, registries, prune_volumes, prune_all_images.
// Any container named in expect_running that is not running makes the status failed; other stopped containers are
// warning when stopped_warning is on, while created/paused ones count as benign. A missing runtime binary or an
// unreachable host reports unavailable rather than failed.
//
// Update detection: the target reports each container's image reference and its image's RepoDigests, and X-Monitor
// itself asks the image's registry for the tag's current digest on the slower update_check_interval, through an async
// io_call that awaits the engine's HTTP connector. A container whose image's RepoDigests lack that digest has an update
// available; one pinned by digest or running a locally built image is unknown. A registry failure is only logged.

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command, type LogEntry, type Result } from "../../core/connectors/types.ts";
import type { StreamSpec } from "../../shared/agent_protocol.ts";
import type { Status } from "../../shared/status.ts";
import type { ActionButtonSpec, CardSpec, ColumnSpec, LayoutRow, UISpec } from "../../shared/ui_spec.ts";
import { Plugin } from "../base/plugin_base.ts";
import { parse_duration, resolve_secret, type PluginConfig } from "../base/plugin_helpers.ts";
import { partition, split_lines, split_words } from "../base/text_parsing.ts";
import { check_images, local_digests, normalise_registry, parse_reference, RegistryAuth, type ImageRef, type RemoteDigest } from "./registry.ts";

const ps_format = "ps -a --format '{{.Names}}\t{{.State}}'";

const images_mark = "@@x-monitor-images";
const digests_mark = "@@x-monitor-digests";

const running_states = new Set(["running", "up"]);
const benign_states = new Set(["created", "paused"]);

const default_update_check_interval = 6 * 3600;
const registry_timeout = 10.0;
const prune_timeout = 600.0;

const update_text: Record<string, string> = {
  available: "Update available",
  current: "Up to date",
  pinned: "Pinned by digest",
  local: "Local image",
  pending: "Not checked yet",
  error: "Check failed",
  unknown: "Unknown",
};

interface ContainerEntry {
  name: string;
  state: string;
  image: string;
  repo_digests: readonly string[];
}

// One container table row, as the snapshot keeps it.
export interface ContainerRow {
  name: string;
  state: string;
  image: string;
  update_state?: string;
  update?: string;
  image_key?: string;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// The [name, lower-cased state] pairs in the ps section's tab-separated lines.
function ps_rows(stdout: string): [name: string, state: string][] {
  const rows: [string, string][] = [];
  for (const line of split_lines(stdout)) {
    if (!line.includes("\t")) continue;
    const [raw_name, , raw_state] = partition(line, "\t");
    const name = raw_name.trim();
    if (name) rows.push([name, raw_state.trim().toLowerCase()]);
  }
  return rows;
}

// The ps lines split into running, stopped, and benign (created or paused) names.
function classify_containers(stdout: string): [running: string[], stopped: string[], benign: string[]] {
  const running: string[] = [];
  const stopped: string[] = [];
  const benign: string[] = [];
  for (const [name, state] of ps_rows(stdout)) {
    const state_word = state ? (split_words(state)[0] ?? "") : "";
    if (running_states.has(state_word)) running.push(name);
    else if (benign_states.has(state_word)) benign.push(name);
    else stopped.push(name);
  }
  return [running, stopped, benign];
}

// The collection output's ps, container-image and image-digest sections.
function split_sections(stdout: string): [ps: string, images: string, digests: string] {
  const sections: Record<string, string[]> = { ps: [], [images_mark]: [], [digests_mark]: [] };
  let current = sections.ps;
  for (const line of split_lines(stdout)) {
    if (line.trim() === images_mark || line.trim() === digests_mark) {
      current = sections[line.trim()];
      continue;
    }
    current.push(line);
  }
  return [sections.ps.join("\n"), sections[images_mark].join("\n"), sections[digests_mark].join("\n")];
}

function strip_id(image_id: string): string {
  const trimmed = image_id.trim();
  return trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
}

// Each container name's image reference and that image's RepoDigests.
function container_images(images: string, digests: string): Map<string, [image: string, repo_digests: string[]]> {
  const repo_digests = new Map<string, string[]>();
  for (const line of split_lines(digests)) {
    const [image_id, , entries] = partition(line, "\t");
    if (image_id.trim()) repo_digests.set(strip_id(image_id), split_words(entries));
  }
  const found = new Map<string, [string, string[]]>();
  for (const line of split_lines(images)) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [name, image, image_id] = parts;
    found.set(name.trim().replace(/^\/+/, ""), [image.trim(), repo_digests.get(strip_id(image_id)) ?? []]);
  }
  return found;
}

// The space a prune reclaimed and how many objects of each kind it deleted, from docker's or podman's report.
export function prune_summary(output: string): string {
  const counts = new Map<string, number>();
  let section: string | null = null;
  let reclaimed: string | null = null;
  for (const raw of split_lines(output)) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (!line) continue;
    if (lower.startsWith("total reclaimed space")) {
      reclaimed = line.includes(":") ? partition(line, ":")[2].trim() : null;
      section = null;
    } else if (lower.startsWith("deleted ") && !lower.startsWith("deleted: ")) {
      section = lower.slice("deleted ".length).replace(/:+$/, "").trim();
      if (!counts.has(section)) counts.set(section, 0);
    } else if (section && !lower.startsWith("untagged:")) {
      counts.set(section, counts.get(section)! + 1);
    }
  }
  const text = `Reclaimed ${reclaimed || "0B"}`;
  const deleted = [...counts].filter(([, count]) => count).map(([kind, count]) => `${kind}: ${count}`);
  return deleted.length > 0 ? `${text} (${deleted.join(", ")})` : text;
}

export function update_color(row: Record<string, unknown>): Status | null {
  return row.update_state === "available" ? "warning" : null;
}

// Per-registry credentials from config, keyed by the registry host references name.
function registry_auths(registries: unknown): Record<string, RegistryAuth> {
  const auths: Record<string, RegistryAuth> = {};
  for (const [host, raw] of Object.entries((registries as Record<string, unknown> | null | undefined) || {})) {
    const entry = (raw || {}) as Record<string, unknown>;
    auths[normalise_registry(String(host))] = new RegistryAuth(
      (entry.username as string | undefined) ?? null,
      resolve_secret(entry.password as string | null | undefined, entry.password_command as string | null | undefined),
      Boolean(entry.insecure ?? false),
    );
  }
  return auths;
}

function shell_single_quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Containers extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  override readonly SAMPLED = true;
  readonly runtime: string;
  readonly expect_running: Set<string>;
  readonly stopped_warning: boolean;
  readonly update_check_interval: number;
  readonly update_warning: boolean;
  readonly registries: Record<string, RegistryAuth>;
  readonly prune_volumes: boolean;
  readonly prune_all_images: boolean;
  // The latest parsed ps rows plus each container's image, kept so a registry check can re-judge them.
  private containers: ContainerEntry[] | null = null;
  // Each checked reference's remote digest, kept between checks.
  private readonly remote = new Map<string, string>();
  private readonly remote_errors = new Map<string, string>();
  private checked = false;
  // When, in monotonic seconds, the next registry check is due.
  next_check = 0;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.runtime = String(config.runtime ?? "docker");
    this.expect_running = new Set(((config.expect_running as string[] | null | undefined) || []).map(String));
    this.stopped_warning = Boolean(config.stopped_warning ?? true);
    this.update_check_interval = parse_duration(config.update_check_interval ?? default_update_check_interval, "update_check_interval");
    this.update_warning = Boolean(config.update_warning ?? false);
    this.registries = registry_auths(config.registries);
    this.prune_volumes = Boolean(config.prune_volumes ?? false);
    this.prune_all_images = Boolean(config.prune_all_images ?? false);
  }

  get checks_updates(): boolean {
    return this.update_check_interval > 0;
  }

  override commands(): Command[] {
    if (!this.checks_updates) return [command(`${this.runtime} ${ps_format} 2>&1`)];
    return [command(this.inventory_script())];
  }

  // The ps listing followed by each container's image reference and image id, then each image's RepoDigests.
  private inventory_script(): string {
    const runtime = this.runtime;
    const image_field = runtime === "podman" ? "{{.ImageName}}" : "{{.Config.Image}}";
    return (
      `${runtime} ${ps_format} 2>&1 || exit; ` +
      `echo ${images_mark}; ` +
      `ids=$(${runtime} ps -aq 2>/dev/null); ` +
      `[ -z "$ids" ] || ${runtime} container inspect --format '{{.Name}}\t${image_field}\t{{.Image}}' $ids 2>/dev/null; ` +
      `echo ${digests_mark}; ` +
      `imgs=$([ -z "$ids" ] || ${runtime} container inspect --format '{{.Image}}' $ids 2>/dev/null | sort -u); ` +
      `[ -z "$imgs" ] || ${runtime} image inspect --format '{{.Id}}\t{{join .RepoDigests " "}}' $imgs 2>/dev/null; ` +
      "true"
    );
  }

  // Registry checks ride the poll, so a monitor that checks updates is polled rather than sampled.
  override subscriptions(): StreamSpec[] {
    if (this.checks_updates) return [];
    return super.subscriptions();
  }

  // Total, running and stopped counts, where a missing expected container is failed, other stopped containers are
  // warning (when stopped_warning), and a missing runtime binary or an unreachable host is unavailable.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    const combined = `${stdout}\n${stderr}`.toLowerCase();
    if (exit_code !== 0 && (combined.includes("command not found") || combined.includes("not found"))) return CollectResult.unavailable(`${this.runtime} not installed on target`);
    if (exit_code === -1) return CollectResult.unavailable(`'${this.runtime} ps' did not run: ${stderr}`);
    if (exit_code !== 0) return CollectResult.failed(`'${this.runtime} ps' failed: ${stderr}`);

    const [ps, images, digests] = split_sections(stdout);
    const by_name = container_images(images, digests);
    this.containers = ps_rows(ps).map(([name, state]) => {
      const [image, repo_digests] = by_name.get(name) ?? ["", []];
      return { name, state, image, repo_digests };
    });
    return this.verdict(ps);
  }

  // The counts, table rows and status for the latest ps listing, judged with the latest registry check.
  private verdict(ps: string): CollectResult {
    const [running, stopped, benign] = classify_containers(ps);
    const total = running.length + stopped.length + benign.length;
    const metrics: Record<string, number> = { containers_total: total, containers_running: running.length, containers_stopped: stopped.length };
    const rows = this.rows();
    const outdated = [...new Set(rows.filter((row) => row.update_state === "available").map((row) => row.image_key!))].sort();
    if (this.checks_updates && this.checked) metrics.images_update_available = outdated.length;
    const snapshot = rows.map(({ image_key: _image_key, ...rest }) => rest);

    if (total === 0) return new CollectResult({ metrics, snapshot, logs: [["No containers found", "INFO"]], status: "online" });

    const update_note = outdated.length > 0 ? `; image updates available: ${outdated.join(", ")}` : "";
    const running_set = new Set(running);
    const missing = [...this.expect_running].filter((name) => !running_set.has(name)).sort();
    if (missing.length > 0) {
      const logs: LogEntry[] = [[`Expected containers not running: ${missing.join(", ")}`, "ERROR"]];
      if (stopped.length > 0) logs.push([`Stopped: ${stopped.join(", ")}`, "WARNING"]);
      return new CollectResult({ metrics, snapshot, logs, status: "failed" });
    }
    if (this.stopped_warning && stopped.length > 0) {
      return new CollectResult({ metrics, snapshot, logs: [[`${running.length} running, ${stopped.length} stopped: ${stopped.join(", ")}${update_note}`, "WARNING"]], status: "warning" });
    }
    if (this.update_warning && outdated.length > 0) return new CollectResult({ metrics, snapshot, logs: [[`${running.length} running${update_note}`, "WARNING"]], status: "warning" });
    return new CollectResult({ metrics, snapshot, logs: [[`${running.length} running, ${stopped.length} stopped, ${benign.length} paused/created${update_note}`, "INFO"]], status: "online" });
  }

  // One table row per container, with its update verdict when update checks are on.
  private rows(): ContainerRow[] {
    return (this.containers ?? []).map((entry) => {
      const row: ContainerRow = { name: entry.name, state: entry.state, image: entry.image || "--" };
      if (this.checks_updates) {
        const ref = parse_reference(entry.image);
        const state = this.update_state(ref, entry.repo_digests);
        row.update_state = state;
        row.update = update_text[state];
        row.image_key = ref ? ref.key : "";
      }
      return row;
    });
  }

  // Whether the container's image matches the digest its registry now serves for the tag.
  private update_state(ref: ImageRef | null, repo_digests: readonly string[]): string {
    if (ref === null) return "unknown";
    if (ref.digest) return "pinned";
    const local = local_digests(repo_digests, ref);
    if (local.size === 0) return "local";
    const remote = this.remote.get(ref.key);
    if (remote === undefined) return this.remote_errors.has(ref.key) ? "error" : "pending";
    return local.has(remote) ? "current" : "available";
  }

  // The distinct tagged references a registry can be asked about, in first-seen order.
  private checkable_refs(): ImageRef[] {
    const refs = new Map<string, ImageRef>();
    for (const entry of this.containers ?? []) {
      const ref = parse_reference(entry.image);
      if (ref === null || ref.digest || refs.has(ref.key)) continue;
      if (local_digests(entry.repo_digests, ref).size > 0) refs.set(ref.key, ref);
    }
    return [...refs.values()];
  }

  // A registry check replaces one poll when due; every other cycle runs the ps command above.
  override io_call(): (() => Promise<{ registry_check: Record<string, RemoteDigest> }>) | null {
    if (!this.checks_updates || this.containers === null || performance.now() / 1000 < this.next_check) return null;
    const refs = this.checkable_refs();
    if (refs.length === 0) return null;
    return async () => {
      this.next_check = performance.now() / 1000 + this.update_check_interval;
      const found = await check_images((request) => this.engine!.http_fetch(request), refs, this.registries, registry_timeout);
      return { registry_check: found };
    };
  }

  override parse_results(results: Result[]): CollectResult {
    const first = results[0] as unknown;
    if (typeof first === "object" && first !== null && "registry_check" in first) return this.parse_registry_check((first as { registry_check: Record<string, RemoteDigest> }).registry_check);
    return this.parse(results as CmdResult[]);
  }

  // Records each looked-up digest and re-judges the last ps listing with them; a failed lookup is logged only.
  private parse_registry_check(found: Record<string, RemoteDigest>): CollectResult {
    const errors: string[] = [];
    for (const [key, answer] of Object.entries(found)) {
      if (answer.digest) {
        this.remote.set(key, answer.digest);
        this.remote_errors.delete(key);
      } else {
        this.remote_errors.set(key, answer.error || "no digest");
        errors.push(answer.error || `${key}: no digest`);
      }
    }
    this.checked = true;

    const ps = (this.containers ?? []).map((entry) => `${entry.name}\t${entry.state}\n`).join("");
    const result = this.verdict(ps);
    const outdated = Math.trunc(result.metrics.images_update_available ?? 0);
    const total = Object.keys(found).length;
    const logs: LogEntry[] = [[`Registry check: ${total - errors.length} of ${total} image(s) checked, ${outdated} with an update`, "INFO"]];
    if (errors.length > 0) logs.push([`Registry check failed for ${errors.length} image(s): ${errors.join("; ").slice(0, 500)}`, "WARNING"]);
    result.logs = [...logs, ...result.logs];
    return result;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    return [...this.expect_running].sort().map((name) => ({ name: `Restart ${name}`, action_id: `restart:${name}`, variant: "primary", icon: "restart_alt" }));
  }

  override plan_action(action_id: string, _args: Record<string, unknown> = {}): ActionPlanResult {
    if (action_id.startsWith("restart:")) {
      const name = partition(action_id, ":")[2];
      if (!this.expect_running.has(name)) return CollectResult.failed(`Refusing to restart unlisted container ${JSON.stringify(name)}`);
      return action_plan(`${this.runtime} restart ${shell_single_quote(name)}`);
    }
    if (action_id === "prune") return action_plan(`${this.prune_command} 2>&1`, { timeout: prune_timeout, detached: true });
    return null;
  }

  get prune_command(): string {
    const flags = ["-f"];
    if (this.prune_all_images) flags.push("-a");
    if (this.prune_volumes) flags.push("--volumes");
    return `${this.runtime} system prune ${flags.join(" ")}`;
  }

  // The prune button's confirm text, a format template, so literal braces are doubled.
  get prune_confirm(): string {
    const images = this.prune_all_images ? "every image no container uses" : "dangling images";
    const volumes = this.prune_volumes ? ", every volume no container uses (with its data)" : "";
    const text = `Run \`${this.prune_command}\` on ${this.target}? It deletes every stopped container, unused networks, ${images}${volumes} and the build cache. This cannot be undone.`;
    return text.replaceAll("{", "{{").replaceAll("}", "}}");
  }

  override interpret_action(action_id: string, result: unknown, _args: Record<string, unknown> = {}): ActionOutcome {
    const outcome = result as CmdResult;
    if (action_id === "prune") return this.interpret_prune(outcome);
    if (action_id.startsWith("restart:") && outcome.exit_code !== 0) return CollectResult.failed(`Restart of ${partition(action_id, ":")[2]} failed: ${outcome.stderr}`);
    return outcome.exit_code === 0;
  }

  // Logs the prune's outcome as an event and hands its summary back to show the user; the status is left alone.
  private interpret_prune(result: CmdResult): CollectResult {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exit_code !== 0) {
      const message = `Prune failed (exit ${result.exit_code}): ${output.slice(-300) || "no output"}`;
      return new CollectResult({ logs: [[message, "ERROR"]], metadata: { content: message }, success: false });
    }
    const summary = prune_summary(output);
    return new CollectResult({ logs: [[`Ran \`${this.prune_command}\`: ${summary}`, "INFO"]], metadata: { content: summary }, success: true });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    const top = ["host_card", "total_card", "running_card"];
    const cards: Record<string, CardSpec> = {
      total_card: { metric: "containers_total", title: "CONTAINERS", format: "int" },
      running_card: {
        kind: "share", title: "STATE", format: "int",
        parts: [
          { metric: "containers_running", label: "Running", color: "online" },
          { metric: "containers_stopped", label: "Stopped", color: "warning" },
        ],
      },
    };
    const columns: ColumnSpec[] = [
      { name: "name", label: "Container", field: "name", sortable: true, align: "left" },
      { name: "state", label: "State", field: "state", sortable: true, align: "left" },
      { name: "image", label: "Image", field: "image", sortable: true, align: "left" },
    ];
    if (this.checks_updates) {
      top.push("updates_card");
      cards.updates_card = { metric: "images_update_available", title: "IMAGE UPDATES", format: "int", color: "nonzero_warning" };
      columns.push({ name: "update", label: "Update", field: "update", sortable: true, align: "left", cell_color_by: update_color });
    }
    const layout: LayoutRow[] = [top, ["tools"], ["containers"], ["events"]];
    return {
      layout,
      cards,
      buttons: { tools: [{ id: "prune", label: "Prune", icon: "delete_sweep", color: "negative", confirm: this.prune_confirm }] },
      tables: { containers: { row_key: "name", columns } },
      events: true,
    };
  }
}
