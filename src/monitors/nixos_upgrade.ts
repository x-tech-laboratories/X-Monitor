// NixOS flake deployment drift: whether the running system is the one the configured flake currently evaluates to.
// Every cycle reads the target's /run/current-system, /run/booted-system, generation and version (one cheap script);
// every `eval_interval` it also evaluates `<flake>#nixosConfigurations.<host>.config.system.build.toplevel` and reads
// `nix flake metadata`, so drift is a comparison of two store paths rather than a guess from revisions, and the
// flake's own revision and input ages are tracked alongside it. The evaluation runs as one detached job, so an
// X-Monitor restart or redeploy never kills it: later cycles keep probing, poll the job every `job_poll` and judge
// drift against the stored evaluation until it finishes, and `eval_timeout` bounds the whole run. Each evaluation is
// kept with its output in the job history. A failed evaluation is retried after `retry_interval` rather than held for
// the full `eval_interval`, and a dashboard poll evaluates unless an evaluation is already running. An unreachable or
// non-NixOS target, unreadable flake metadata, or an evaluation that never reached its host is unavailable; an
// evaluation that ran and errored, or ended without reporting, is failed. `eval_agent` runs the evaluation on another
// agent's host, for a target too small to evaluate its own flake; the probe stays on the target, so drift is still
// read from the machine it describes. The monitor only reads: updating, building and switching the flake is X-Nix's
// job. Config: flake, configuration, eval_agent, eval_interval, retry_interval, eval_timeout, job_poll,
// max_input_age, drift_status, reboot_status, nix_bin, nix_args.

import { python_dumps } from "@x-tech-laboratories/x-libs/python_text";

import { launch_command, parse_launch, parse_poll, poll_command, stream_stderr, workdir_for } from "../core/connectors/job_commands.ts";
import { cmd_result, command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { JobDict } from "../core/state/records.ts";
import { shell_quote } from "../core/shell.ts";
import { is_status, log_level_of, type Status } from "../shared/status.ts";
import type { LayoutRow, TableSpec, UISpec } from "../shared/ui_spec.ts";
import { boot_parts_script, reboot_required as nixos_reboot_required } from "./base/nixos_boot.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_age, format_duration, parse_duration, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";

const default_layout: LayoutRow[] = [
  ["host_card", "drift_card", "reboot_card", "generation_card"],
  ["flake_card", "revision_card", "switched_card", "inputs_card"],
  ["details"],
  ["events"],
];

// Metric carrying the evaluation's epoch as its value and the whole evaluated state as JSON metadata, so a restart
// resumes the eval schedule.
const state_metric = "flake_eval_epoch";

const local_schemes = ["path:", "git+file://", "file://"];

// The kind the flake evaluation's detached job is recorded under.
const eval_job_kind = "eval";

// The two commands one evaluation runs, in the order the script runs them.
const eval_parts = ["eval", "metadata"] as const;

// Starts a line naming the command and stream the evaluation script prints next.
const eval_mark = "@@x-monitor-eval";

// The exit status `timeout` gives a run it killed.
const timed_out = 124;

// ── Parsing ──────────────────────────────────────────────────────────────────

// One script collecting every cheap fact about the deployed system.
export function probe_script(): string {
  return [
    'echo "hostname=$(uname -n)"',
    'echo "current=$(readlink -f /run/current-system 2>/dev/null)"',
    'echo "booted=$(readlink -f /run/booted-system 2>/dev/null)"',
    'echo "switched=$(stat -c %Y /run/current-system 2>/dev/null)"',
    'echo "profile=$(readlink /nix/var/nix/profiles/system 2>/dev/null)"',
    'echo "version=$(cat /run/current-system/nixos-version 2>/dev/null)"',
    "echo \"version_json=$(nixos-version --json 2>/dev/null | tr -d '\\n')\"",
    ...boot_parts_script(),
  ].join("\n");
}

export interface NixosProbe {
  booted_part: string[];
  current_part: string[];
  [key: string]: string | string[] | undefined;
}

// The probe script's key=value lines as a record, with the repeated booted_part and current_part lines as lists.
export function parse_probe(stdout: string): NixosProbe {
  const fields: NixosProbe = { booted_part: [], current_part: [] };
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "booted_part" || key === "current_part") fields[key].push(value);
    else fields[key] = value;
  }
  return fields;
}

function text_of(fields: NixosProbe, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : "";
}

// The generation number from a `system-210-link` profile symlink.
export function generation_of(profile_link: string): number | null {
  const name = profile_link.split("/").at(-1)!;
  if (!(name.startsWith("system-") && name.endsWith("-link"))) return null;
  const middle = name.slice("system-".length, name.length - "-link".length);
  return /^\s*[+-]?\d+\s*$/.test(middle) ? Number(middle) : null;
}

// Runs each command in turn, printing its stderr live after a marker line so the job's log shows nix's progress, then
// prints every command's stdout and exit status after marker lines, so the finished output splits back into one result
// per command.
export function eval_script(commands: Record<string, string>, workdir: string): string {
  // workdir_for() names only safe characters under $HOME, so double quotes suffice.
  const lines = [`w="${workdir}"`];
  for (const [name, text] of Object.entries(commands)) {
    lines.push(`echo "${eval_mark} ${name} stderr"`);
    lines.push(stream_stderr(text, `"$w/${name}.exit"`, { stdout_to: `"$w/${name}.stdout"` }));
  }
  for (const name of Object.keys(commands)) {
    for (const stream of ["stdout", "exit"]) lines.push(`echo "${eval_mark} ${name} ${stream}"; cat "$w/${name}.${stream}"; echo`);
  }
  // The run fails when either command did, so its job row shows it.
  lines.push(Object.keys(commands).map((name) => `[ "$(cat "$w/${name}.exit")" = 0 ]`).join(" && "));
  return lines.join("\n");
}

// A finished evaluation's output split back into one result per command; a command the run never reported on gets a
// failed result saying `missing`.
export function split_eval_output(output: string, missing: string): Record<(typeof eval_parts)[number], CmdResult> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    const mark = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? "" : line.slice(space + 1);
    if (mark === eval_mark) {
      const split = rest.indexOf(" ");
      current = JSON.stringify(split === -1 ? [rest] : [rest.slice(0, split), rest.slice(split + 1)]);
      sections.set(current, []);
    } else if (current !== null) sections.get(current)!.push(line);
  }

  const text = (name: string, stream: string): string => (sections.get(JSON.stringify([name, stream])) ?? []).join("\n").trim();

  const results = {} as Record<(typeof eval_parts)[number], CmdResult>;
  for (const name of eval_parts) {
    const code = text(name, "exit");
    if (!/^-*\d+$/.test(code)) {
      results[name] = cmd_result(1, "", missing);
      continue;
    }
    results[name] = cmd_result(Number(code), text(name, "stdout"), text(name, "stderr"));
  }
  return results;
}

function decode_json(raw: string | null | undefined): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(raw ?? "");
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// A flake revision abbreviated, keeping the -dirty marker a local checkout with uncommitted changes carries.
export function short_rev(revision: string | null | undefined): string {
  if (!revision) return "--";
  const dash = revision.indexOf("-");
  if (dash === -1) return revision.slice(0, 12);
  return revision.slice(0, dash).slice(0, 12) + "-" + revision.slice(dash + 1);
}

// A value escaped for embedding inside a double-quoted shell word.
function escape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$");
}

// A configured status name, falling back on anything unrecognised.
function severity_of(value: unknown, fallback: Status): Status {
  const text = String(value);
  return is_status(text) ? text : fallback;
}

// The name and lastModified of the least recently updated locked input, the one `nix flake update` would move furthest.
export function oldest_input(locks: Record<string, unknown>): [name: string | null, epoch: number | null] {
  const nodes = locks.nodes;
  if (typeof nodes !== "object" || nodes === null || Array.isArray(nodes)) return [null, null];
  const root = "root" in locks ? locks.root : "root";
  let oldest_name: string | null = null;
  let oldest_epoch: number | null = null;
  for (const [name, node] of Object.entries(nodes as Record<string, unknown>)) {
    if (name === root || typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const locked = (node as Record<string, unknown>).locked;
    const stamp = typeof locked === "object" && locked !== null && !Array.isArray(locked) ? (locked as Record<string, unknown>).lastModified : null;
    if (typeof stamp !== "number") continue;
    if (oldest_epoch === null || stamp < oldest_epoch) {
      oldest_name = name;
      oldest_epoch = Math.trunc(stamp);
    }
  }
  return [oldest_name, oldest_epoch];
}

// The last evaluation's result, carried between cycles.
export type EvalState = Record<string, unknown>;

// ── Monitor ──────────────────────────────────────────────────────────────────

export class NixosUpgrade extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  // The evaluation runs beside any job a custom action launches, and never blocks its button.
  override readonly SIDE_JOB_KINDS: readonly string[] = [eval_job_kind];
  readonly flake: string;
  readonly configuration: string | null;
  readonly eval_agent: string | null;
  readonly eval_interval: number;
  readonly retry_interval: number;
  readonly eval_timeout: number;
  // One fixed directory per monitor, so finished evaluations never pile up on the eval host.
  readonly eval_workdir: string;
  readonly max_input_age: number | null;
  readonly drift_status: Status;
  readonly reboot_status: Status;
  readonly nix_bin: string;
  readonly nix_args: string[];
  // Set when the running closure changed or a dashboard poll asked, so the next cycle re-evaluates.
  force_eval = false;
  // The evaluation the current cycle launched (its command) or polled (its job row).
  private eval_launch: string | null = null;
  private eval_polling: JobDict | null = null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.flake = String(config.flake ?? "/etc/nixos");
    this.configuration = (config.configuration as string | null | undefined) ?? null;
    this.eval_agent = (config.eval_agent as string | null | undefined) || null;
    this.eval_interval = parse_duration(config.eval_interval ?? "1h");
    this.retry_interval = Math.min(parse_duration(config.retry_interval ?? "15m"), this.eval_interval);
    this.eval_timeout = parse_duration(config.eval_timeout ?? "10m");
    this.job_poll_interval = parse_duration(config.job_poll ?? "30s");
    this.eval_workdir = workdir_for(`nixos_upgrade-${this.id}-eval`);
    this.max_input_age = config.max_input_age !== undefined && config.max_input_age !== null ? parse_duration(config.max_input_age) : null;
    this.drift_status = severity_of(config.drift_status, "warning");
    this.reboot_status = severity_of(config.reboot_status, "warning");
    this.nix_bin = String(config.nix_bin ?? "nix");
    this.nix_args = [...((config.nix_args as unknown[] | undefined) ?? ["--extra-experimental-features", "nix-command flakes"])].map(String);
  }

  // ── Flake reference ──────────────────────────────────────────────────────

  // The flake's filesystem path when it is a local checkout, else null.
  get local_path(): string | null {
    let ref = this.flake;
    const scheme = local_schemes.find((prefix) => ref.startsWith(prefix));
    if (scheme !== undefined) ref = ref.slice(scheme.length);
    else if (!(ref.startsWith("/") || ref.startsWith("."))) return null;
    const path = ref.split("?")[0].split("#")[0];
    return path || null;
  }

  // A mutable remote ref is only seen freshly with --refresh; a local path is read from disk every time.
  private refresh_args(): string[] {
    return this.local_path ? [] : ["--refresh"];
  }

  // The nixosConfigurations attribute to evaluate: the configured name, else the hostname the last probe reported.
  private attribute(): string | null {
    if (this.configuration) return String(this.configuration);
    const snapshot = this.data ? this.data.latest_snapshot<Record<string, unknown>>({}) : {};
    return ((snapshot ?? {}).hostname as string | undefined) || null;
  }

  // The flake installable for this host's system closure, double-quoted so an unknown attribute falls back to the
  // evaluating host's own hostname.
  private installable(): string {
    const attribute = this.attribute();
    const word = attribute ? escape(attribute) : "$(uname -n)";
    return `"${escape(this.flake)}#nixosConfigurations.\\"${word}\\".config.system.build.toplevel"`;
  }

  // ── Collection ───────────────────────────────────────────────────────────

  override commands(): Command[] {
    const commands = [command(probe_script())];
    this.eval_launch = null;
    this.eval_polling = null;
    const eval_job = this.running_eval();
    if (eval_job !== null) {
      this.eval_polling = eval_job;
      // Every poll reads the whole output, since the finished evaluation is parsed from all of it.
      commands.push(command(poll_command(eval_job.workdir!, eval_job.pid!, 0), { agent: this.job_agent(eval_job) }));
    } else if (this.due_for_eval() && !(this.eval_agent && this.attribute() === null)) {
      // An offloaded evaluation needs the target's attribute name, which the first probe supplies.
      this.eval_launch = this.eval_command();
      commands.push(command(launch_command(this.eval_launch, this.eval_workdir), { agent: this.eval_agent }));
    }
    return commands;
  }

  // The script one evaluation runs: `nix eval` of the toplevel, then `nix flake metadata`.
  eval_script(): string {
    const nix = [this.nix_bin, ...this.nix_args.map(shell_quote)].join(" ");
    const refresh = this.refresh_args().join(" ");
    return eval_script({
      eval: [nix, "eval --raw --no-write-lock-file", refresh, this.installable()].filter(Boolean).join(" "),
      metadata: [nix, "flake metadata --json --no-write-lock-file", refresh, shell_quote(this.flake)].filter(Boolean).join(" "),
    }, this.eval_workdir);
  }

  // The evaluation script under `timeout`, which kills it once it takes longer than eval_timeout.
  eval_command(): string {
    return `timeout ${Math.trunc(this.eval_timeout)} sh -c ${shell_quote(this.eval_script())}`;
  }

  // The running evaluation job, if one was launched and recorded with its pid.
  private running_eval(): JobDict | null {
    const job = this.jobs ? this.jobs.running_side(eval_job_kind) : null;
    if (job && job.pid && job.workdir) return job;
    return null;
  }

  override job_agent(job: JobDict): string | null {
    return job.kind === eval_job_kind ? this.eval_agent : super.job_agent(job);
  }

  // The last evaluation's stored result: target closure, flake revision and input ages, carried as metric metadata.
  state(): EvalState {
    const metric = this.data ? this.data.latest_metric(state_metric) : null;
    return metric !== null && metric.metadata ? decode_json(metric.metadata) : {};
  }

  private due_for_eval(): boolean {
    if (this.force_eval) return true;
    const state = this.state();
    const evaluated = state.evaluated_epoch;
    if (!evaluated) return true;
    // A failed evaluation waits only retry_interval; holding its error for a whole eval_interval hides a fix.
    const failed = Boolean(state.eval_error || state.metadata_error);
    const wait = failed ? this.retry_interval : this.eval_interval;
    return Date.now() / 1000 - Number(evaluated) >= wait;
  }

  // A dashboard poll is an explicit ask, so it evaluates unless an evaluation is already running.
  override async run_cycle(): Promise<boolean> {
    if (this.running_eval() === null) this.force_eval = true;
    return super.run_cycle();
  }

  override parse(results: CmdResult[]): CollectResult {
    const eval_launch = this.eval_launch;
    this.eval_launch = null;
    const eval_job = this.eval_polling;
    this.eval_polling = null;
    if (results.length === 0) return CollectResult.unavailable("No probe result for this cycle");

    // The evaluation is handled first, so a launched job is recorded even when the probe failed.
    let folded: EvalState | null = null;
    if (results.length > 1 && eval_launch !== null) folded = this.parse_eval_launch(eval_launch, results[1]);
    else if (results.length > 1 && eval_job !== null) folded = this.parse_eval_poll(eval_job, results[1]);

    const probe = results[0];
    if (probe.exit_code !== 0 && !probe.stdout.trim()) {
      return keep_state(CollectResult.unavailable(`Could not read the deployed system: ${(probe.stderr || probe.stdout).trim().slice(0, 200)}`), folded);
    }

    const fields = parse_probe(probe.stdout);
    const current = text_of(fields, "current");
    if (!current) return keep_state(CollectResult.unavailable("/run/current-system is unreadable — is this a NixOS host?"), folded);

    const evaluated = folded !== null;
    return this.assemble(fields, current, folded ?? this.state(), evaluated);
  }

  // Records the launched evaluation as a job, or folds a launch that failed as a failed evaluation.
  private parse_eval_launch(command_text: string, result: CmdResult): EvalState | null {
    this.force_eval = false;
    const pid = result.exit_code === 0 ? parse_launch(result.stdout) : null;
    if (pid === null) {
      // A launch whose host never answered (exit -1) is unreachable, like any other evaluation that never ran.
      const failure = cmd_result(result.exit_code || 1, "", `Could not start the evaluation: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
      return this.eval_state(failure, failure);
    }
    const job_id = this.jobs!.create(eval_job_kind, command_text, this.eval_workdir);
    this.jobs!.set_pid(job_id, pid);
    return null;
  }

  // Advances the running evaluation from one poll, returning the folded state once it finishes.
  private parse_eval_poll(job: JobDict, result: CmdResult): EvalState | null {
    const job_id = job.id;
    if (result.exit_code !== 0 && !result.stdout.trim()) {
      // The eval host never answered, so this cycle is unreachable, but the job stays running for a later poll.
      const unreachable = cmd_result(-1, "", `Could not poll the running evaluation: ${(result.stderr || "").trim().slice(0, 200) || `exit ${result.exit_code}`}`);
      return this.eval_state(unreachable, unreachable);
    }
    const poll = parse_poll(result.stdout);
    const finished = poll.exit_code !== null || !poll.alive;

    // output_seq counts the characters of the output already copied into the job's log.
    const fresh = poll.new_output.slice(job.output_seq);
    const cut = fresh.lastIndexOf("\n");
    const lines = cut === -1 ? [] : fresh.slice(0, cut).split("\n");
    let consumed = cut + 1;
    if (finished && fresh.slice(consumed)) {
      lines.push(fresh.slice(consumed));
      consumed = fresh.length;
    }
    if (lines.length > 0) {
      this.jobs!.append_output(job_id, lines);
      this.jobs!.bump_output_seq(job_id, job.output_seq + consumed);
    }
    if (!finished) return null;

    let error: string | null;
    if (poll.exit_code === null) {
      error = "Process ended without writing an exit code";
      this.jobs!.finish(job_id, "failed", -1, error);
    } else {
      error = poll.exit_code === 0 ? null : poll.exit_code === timed_out ? `Timed out after ${format_duration(this.eval_timeout)}` : `Exited with status ${poll.exit_code}`;
      this.jobs!.finish(job_id, error ? "failed" : "succeeded", poll.exit_code, error);
    }
    const parts = split_eval_output(poll.new_output, `The evaluation ended before reporting: ${error || "no output"}`);
    return this.eval_state(parts.eval, parts.metadata);
  }

  // Folds this cycle's evaluation and flake metadata into the stored state, keeping the last known good values for
  // whichever half failed.
  private eval_state(eval_result: CmdResult, metadata_result: CmdResult): EvalState {
    const state: EvalState = { ...this.state() };
    state.evaluated_epoch = Math.trunc(Date.now() / 1000);

    if (eval_result.exit_code === 0 && eval_result.stdout.trim()) {
      state.target = eval_result.stdout.trim().split(/\r\n|\r|\n/).at(-1)!.trim();
      state.eval_error = null;
    } else {
      state.eval_error = (eval_result.stderr || eval_result.stdout).trim().slice(0, 400) || `nix eval exited ${eval_result.exit_code}`;
      // An eval host that never answered measured nothing, unlike an evaluation that ran and errored.
      state.eval_unreachable = eval_result.exit_code === -1;
    }

    const data = metadata_result.exit_code === 0 ? decode_json(metadata_result.stdout) : {};
    if (Object.keys(data).length > 0) {
      const locked = (typeof data.locked === "object" && data.locked !== null && !Array.isArray(data.locked) ? data.locked : {}) as Record<string, unknown>;
      // An uncommitted local checkout has no `rev`, only a `dirtyRev`.
      state.flake_revision = data.revision || locked.rev || locked.dirtyRev || null;
      state.flake_last_modified = data.lastModified || locked.lastModified || null;
      const locks = (typeof data.locks === "object" && data.locks !== null && !Array.isArray(data.locks) ? data.locks : {}) as Record<string, unknown>;
      const [name, epoch] = oldest_input(locks);
      state.oldest_input = name;
      state.inputs_last_modified = epoch;
      state.metadata_error = null;
    } else {
      state.metadata_error = (metadata_result.stderr || metadata_result.stdout).trim().slice(0, 400) || `nix flake metadata exited ${metadata_result.exit_code}`;
    }
    return state;
  }

  // The probe's facts and the stored evaluation as this cycle's metrics, log lines and worst-of status.
  private assemble(fields: NixosProbe, current: string, state: EvalState, evaluated: boolean): CollectResult {
    const accumulator = new StatusAccumulator();
    const now = Math.trunc(Date.now() / 1000);
    const metrics: Record<string, number> = {};
    const metadata: Record<string, string> = {};
    const logs: [string, string][] = [];

    const version = text_of(fields, "version") || (decode_json(text_of(fields, "version_json")).nixosVersion as string | undefined) || "unknown";
    const generation = generation_of(text_of(fields, "profile"));
    if (generation !== null) metrics.generation = generation;

    const switched = text_of(fields, "switched");
    if (switched && /^\d+$/.test(switched)) {
      metrics.last_switch_epoch = Number(switched);
      logs.push([`Running NixOS ${version}, generation ${generation || "?"}, switched ${format_age(now - Number(switched))}`, "INFO"]);
    } else {
      logs.push([`Running NixOS ${version}, generation ${generation || "?"}`, "INFO"]);
    }

    const target = state.target as string | undefined;
    if (state.eval_error) {
      const unreachable = Boolean(state.eval_unreachable);
      accumulator.escalate(unreachable ? "unavailable" : "failed");
      logs.push([`Flake evaluation failed: ${state.eval_error}`, unreachable ? "WARNING" : "ERROR"]);
    }
    const previous = this.data ? ((this.data.latest_snapshot<Record<string, unknown>>({}) ?? {}).current as string | undefined) : undefined;
    if (target && !evaluated && previous && previous !== current && target !== current) {
      // A closure that changed since the last evaluation is judged against a fresh one, not a stale target.
      this.force_eval = true;
      logs.push([`Running closure changed to ${current}; re-evaluating the flake before judging drift`, "INFO"]);
    } else if (target) {
      const up_to_date = target === current;
      metrics.up_to_date = up_to_date ? 1.0 : 0.0;
      if (up_to_date) logs.push(["System matches the flake", "INFO"]);
      else {
        accumulator.escalate(this.drift_status);
        logs.push([`System is out of date: ${this.flake} evaluates to ${target}, running ${current}`, log_level_of(this.drift_status)]);
      }
    }

    if (state.metadata_error) {
      accumulator.escalate("unavailable");
      logs.push([`Could not read flake metadata: ${state.metadata_error}`, "WARNING"]);
    }
    metrics.flake_reachable = state.metadata_error ? 0.0 : 1.0;

    const flake_modified = state.flake_last_modified as number | null | undefined;
    if (flake_modified) {
      metrics.flake_last_modified_epoch = Number(flake_modified);
      const revision = state.flake_revision as string | null | undefined;
      logs.push([`Flake last changed ${format_age(now - Math.trunc(Number(flake_modified)))}` + (revision ? ` at ${short_rev(revision)}` : ""), "INFO"]);
    }

    const inputs_modified = state.inputs_last_modified as number | null | undefined;
    if (inputs_modified) {
      metrics.inputs_last_modified_epoch = Number(inputs_modified);
      const age = now - Math.trunc(Number(inputs_modified));
      const stale = this.max_input_age !== null && age > this.max_input_age;
      if (stale) accumulator.escalate("warning");
      logs.push([
        `Oldest locked input ${state.oldest_input || "?"} is ${format_age(age)}` + (stale ? `, over the ${format_duration(this.max_input_age!)} limit` : ""),
        stale ? "WARNING" : "INFO",
      ]);
    }

    const reboot = nixos_reboot_required(fields.booted_part, fields.current_part);
    if (reboot !== null) {
      metrics.reboot_required = reboot ? 1.0 : 0.0;
      if (reboot) {
        accumulator.escalate(this.reboot_status);
        logs.push(["Reboot required: the booted kernel/initrd is not the current one", log_level_of(this.reboot_status)]);
      }
    }

    metrics[state_metric] = Number(state.evaluated_epoch || 0);
    metadata[state_metric] = python_dumps(state);

    return new CollectResult({
      metrics,
      metadata,
      logs,
      status: accumulator.status,
      snapshot: { current, version, generation, booted: fields.booted ?? null, hostname: fields.hostname ?? null },
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private metric(name: string): number | null {
    return this.data.latest_metric(name)?.value ?? null;
  }

  private drift_pair(): [string, string | null] {
    if (this.state().eval_error) return ["EVAL FAILED", "failed"];
    const value = this.metric("up_to_date");
    if (value === null) return ["UNKNOWN", "unavailable"];
    if (value > 0.5) return ["UP TO DATE", "online"];
    return ["OUT OF DATE", this.drift_status];
  }

  private reboot_pair(): [string, string | null] {
    const value = this.metric("reboot_required");
    if (value === null) return ["--", "unavailable"];
    if (value > 0.5) return ["REQUIRED", this.reboot_status];
    return ["NOT NEEDED", "online"];
  }

  private inputs_pair(): [string, string | null] {
    const epoch = this.metric("inputs_last_modified_epoch");
    if (!epoch) return ["--", null];
    const age = Math.trunc(Date.now() / 1000) - Math.trunc(epoch);
    const stale = this.max_input_age !== null && age > this.max_input_age;
    return [format_age(age), stale ? "warning" : "online"];
  }

  get drift_text(): string {
    return this.drift_pair()[0];
  }

  get drift_color(): string | null {
    return this.drift_pair()[1];
  }

  get reboot_text(): string {
    return this.reboot_pair()[0];
  }

  get reboot_color(): string | null {
    return this.reboot_pair()[1];
  }

  get inputs_text(): string {
    return this.inputs_pair()[0];
  }

  get inputs_color(): string | null {
    return this.inputs_pair()[1];
  }

  get revision_text(): string {
    return short_rev(this.state().flake_revision as string | null | undefined);
  }

  get switched_text(): string {
    const epoch = this.metric("last_switch_epoch");
    return epoch ? format_age(Math.trunc(Date.now() / 1000) - Math.trunc(epoch)) : "--";
  }

  // The full deployment picture as label/value rows: what is running, what the flake says should be, and when each
  // was last established.
  get detail_rows(): { label: string; value: string }[] {
    const state = this.state();
    const snapshot = this.data.latest_snapshot<Record<string, unknown>>({}) ?? {};
    const now = Math.trunc(Date.now() / 1000);
    const stamp = (epoch: unknown): string => (epoch ? format_age(now - Math.trunc(Number(epoch))) : "--");
    const rows: [string, string][] = [
      ["Flake", this.flake],
      ["Configuration", this.configuration || (snapshot.hostname as string | undefined) || "the target's hostname"],
      ["NixOS version", "version" in snapshot ? String(snapshot.version) : "--"],
      ["Generation", String(snapshot.generation || "--")],
      ["Last switch", this.switched_text],
      ["Running closure", "current" in snapshot ? String(snapshot.current) : "--"],
      ["Flake closure", (state.target as string | undefined) || "--"],
      ["Flake revision", (state.flake_revision as string | undefined) || "--"],
      ["Flake last changed", stamp(state.flake_last_modified)],
      ["Oldest input", `${state.oldest_input || "--"} (${stamp(state.inputs_last_modified)})`],
      ["Last evaluated", stamp(state.evaluated_epoch)],
    ];
    for (const [label, error] of [["Evaluation error", state.eval_error], ["Metadata error", state.metadata_error]] as const) {
      if (error) rows.push([label, String(error)]);
    }
    return rows.map(([label, value]) => ({ label, value }));
  }

  override get UI_SPEC(): UISpec {
    const details: TableSpec & { title: string } = {
      title: "Deployment details",
      row_key: "label",
      rows_attr: "detail_rows",
      columns: [
        { name: "label", label: "Field", field: "label", align: "left" },
        { name: "value", label: "Value", field: "value", align: "left" },
      ],
    };
    return {
      layout: default_layout,
      cards: {
        drift_card: { title: "DEPLOYMENT", value_attr: "drift_text", color_attr: "drift_color" },
        reboot_card: { title: "REBOOT", value_attr: "reboot_text", color_attr: "reboot_color" },
        generation_card: { metric: "generation", title: "GENERATION", format: "int" },
        flake_card: { title: "FLAKE", value: this.flake },
        revision_card: { title: "REVISION", value_attr: "revision_text", refresh: true },
        switched_card: { title: "LAST SWITCH", value_attr: "switched_text", refresh: true },
        inputs_card: { title: "OLDEST INPUT", value_attr: "inputs_text", color_attr: "inputs_color" },
      },
      tables: { details },
      events: { title: "Events", limit: 100, full_height: true },
    };
  }
}

// Stores an evaluation that finished on a cycle whose probe failed, so it is not lost.
function keep_state(result: CollectResult, state: EvalState | null): CollectResult {
  if (state !== null) {
    result.metrics[state_metric] = Number(state.evaluated_epoch || 0);
    result.metadata[state_metric] = python_dumps(state);
  }
  return result;
}
