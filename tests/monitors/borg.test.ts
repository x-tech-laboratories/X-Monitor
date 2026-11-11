import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cmd_result, COLLECT_TIMEOUT, CollectResult, type ActionPlan, type CmdResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Borg } from "../../src/monitors/borg/plugin.ts";
import { children_filter, parse_listing } from "../../src/monitors/borg/parsing.ts";
import { frame_line, preflight_script, skip_reason, split_poll, ssh_endpoint, then_steps, with_preflight, wrap_job } from "../../src/monitors/borg/shell.ts";
import { make_test_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-borg",
  id: "test-borg",
  interval: 3600,
  max_age: "1d",
  repo: "ssh://borg@host/srv/repo",
  ssh_config: { host: "test.host" },
};

// A literal passphrase the tests check is redacted.
const phrase = "plain-words";

const latest_status = (plugin: Borg) => store_of(plugin).store.statuses.get("test-borg")?.state ?? null;
const latest_metric = (plugin: Borg, name: string) => store_of(plugin).latest_metric("test-borg", name)?.value ?? null;

function make(config: PluginConfig = base_config): Borg {
  return make_test_plugin(Borg, config).plugin;
}

function apply(plugin: Borg, result: unknown): void {
  plugin.engine!.apply(plugin, result as CollectResult);
}

function now(): number {
  return Math.trunc(Date.now() / 1000);
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

// An epoch as borg's local ISO time with microseconds.
function iso(epoch: number): string {
  const moment = new Date(epoch * 1000);
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())}T${two(moment.getHours())}:${two(moment.getMinutes())}:${two(moment.getSeconds())}.000000`;
}

function list_json(epoch: number | null = null): string {
  const archives = epoch === null ? [] : [{ name: "host-2024", start: iso(epoch) }];
  return JSON.stringify({ repository: { location: "/srv/repo" }, archives });
}

function multi_json(...epochs: number[]): string {
  return JSON.stringify({
    repository: { location: "/srv/repo", last_modified: epochs.length > 0 ? iso(epochs[0]) : "" },
    encryption: { mode: "repokey-blake2" },
    archives: epochs.map((epoch, index) => ({ name: `archive-${index}`, start: iso(epoch) })),
  });
}

// The transcript the poll command's shell emits, so parse() is driven through its real input.
function framed(...results: CmdResult[]): CmdResult {
  const lines: string[] = [];
  results.forEach((result, index) => {
    lines.push(frame_line(index, "out", result.exit_code), result.stdout, frame_line(index, "err", result.exit_code), result.stderr);
  });
  // The shell's own exit code is the last printf's, so a borg failure is only visible inside the frames.
  return cmd_result(0, lines.join("\n") + "\n", "");
}

function collect(plugin: Borg, list_result: CmdResult, info_result: CmdResult | null = null): CollectResult {
  const outputs = [list_result];
  if (plugin.collect_stats) outputs.push(info_result ?? cmd_result(0, "{}", ""));
  return run_cycle(plugin, () => framed(...outputs));
}

function messages(result: CollectResult): string {
  return result.logs.map(([message]) => message).join(" | ");
}

function plan_of(plugin: Borg, action_id: string, args: Record<string, unknown> = {}): ActionPlan {
  return plugin.plan_action(action_id, args) as ActionPlan;
}

function refused_of(plugin: Borg, action_id: string, args: Record<string, unknown> = {}): CollectResult {
  return plugin.plan_action(action_id, args) as CollectResult;
}

function outcome_of(plugin: Borg, action_id: string, result: CmdResult, args: Record<string, unknown> = {}): CollectResult {
  return plugin.interpret_action(action_id, result, args) as CollectResult;
}

function sh(script: string, env: NodeJS.ProcessEnv | undefined = undefined) {
  return spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 30_000, env });
}

function temp_dir(): string {
  return mkdtempSync(join(tmpdir(), "borg-"));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("freshness", () => {
  it("calls a recent archive online", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 3600), ""));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a stale archive", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 3 * 24 * 3600), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails an empty repo", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(null), ""));
    expect(latest_status(plugin)).toBe("failed");
  });
});

describe("logging", () => {
  it("logs each archive", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 3600, now() - 90000, now() - 180000), ""));
    for (const name of ["archive-0", "archive-1", "archive-2"]) expect(messages(result)).toContain(name);
  });

  it("logs the repository's details", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 3600), ""));
    expect(messages(result)).toContain("/srv/repo");
    expect(messages(result)).toContain("repokey-blake2");
  });

  it("logs archives newest first", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 180000, now() - 3600, now() - 90000), ""));
    const names = result.logs.filter(([message]) => message.startsWith("  archive-")).map(([message]) => message.trim().split(" ")[0]);
    expect(names).toEqual(["archive-1", "archive-2", "archive-0"]);
  });

  it("logs the command with the passphrase redacted", () => {
    const result = collect(make({ ...base_config, passphrase: phrase }), cmd_result(0, multi_json(now() - 3600), ""));
    expect(messages(result)).toContain("borg list");
    expect(messages(result)).toContain("BORG_PASSPHRASE=*****");
    expect(messages(result)).not.toContain(phrase);
  });

  it("logs a failure's exit code and hint", () => {
    const result = collect(make(), cmd_result(1, "", "sudo: borg: command not found"));
    expect(messages(result)).toContain("exit 1");
    expect(messages(result)).toContain("not on PATH");
  });

  it("hints at ssh_key on a publickey failure", () => {
    const result = collect(make(), cmd_result(2, "", "Remote: borg@heimdall.technet: Permission denied (publickey)."));
    expect(messages(result)).toContain("ssh_key");
    expect(messages(result)).not.toContain("require_sudo");
  });

  it("hints at require_sudo on a permission failure", () => {
    const result = collect(make(), cmd_result(2, "", "Permission denied: '/srv/repo/config'"));
    expect(result.logs.some(([message]) => message.includes("require_sudo"))).toBe(true);
  });

  it("logs a snippet of unparseable output", () => {
    const result = collect(make(), cmd_result(0, "Warning: something odd", ""));
    expect(result.logs.some(([message]) => message.includes("Warning: something odd"))).toBe(true);
  });
});

describe("failures", () => {
  it("fails a borg error", () => {
    const plugin = make();
    collect(plugin, cmd_result(2, "", "Repository is locked"));
    expect(latest_status(plugin)).toBe("failed");
  });

  it.each([
    ["unparseable output", cmd_result(0, "not json", "")],
    ["an unreachable host", cmd_result(-1, "", "Agent 'h' is not connected")],
    ["a missing borg binary", cmd_result(1, "", "sudo: borg: command not found")],
    ["an unreadable repo", cmd_result(2, "", "Permission denied: '/srv/repo/config'")],
    ["a lock timeout", cmd_result(2, "", "Failed to create/acquire the lock /srv/repo/lock.exclusive (timeout).")],
    ["a cache lock timeout", cmd_result(2, "", "Failed to create/acquire the lock /var/cache/x-monitor-borg/.cache/borg/abc/lock.exclusive (timeout).")],
  ])("calls %s unavailable", (_label, result) => {
    const plugin = make();
    collect(plugin, result);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("fails without a repo", () => {
    const { repo: _repo, ...config } = base_config;
    const plugin = make(config);
    expect(plugin.commands()).toEqual([]);
    run_cycle(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });
});

describe("metrics", () => {
  it("records the last backup epoch", () => {
    const plugin = make();
    const epoch = now() - 500;
    collect(plugin, cmd_result(0, list_json(epoch), ""));
    expect(Math.abs(latest_metric(plugin, "last_backup_epoch")! - epoch)).toBeLessThanOrEqual(1);
  });

  it("records the archive count", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now()), ""));
    expect(latest_metric(plugin, "archive_count")).toBeCloseTo(1.0);
  });
});

describe("command", () => {
  it("defaults max_age to one day", () => {
    const { max_age: _max_age, ...config } = base_config;
    expect(make(config).max_age).toBe(86400);
  });

  it("asks for the newest archives as json", () => {
    const command_text = make().list_command();
    for (const part of ["borg list", "--last 10", "--json", "ssh://borg@host/srv/repo"]) expect(command_text).toContain(part);
  });

  it("honours the repo lock on reads", () => {
    const plugin = make();
    const reads = [plugin.list_command(), plugin.info_command(), ...plugin.canary_calls("a1").map(([, call]) => call)];
    expect(reads.some((call) => call.includes("--bypass-lock"))).toBe(false);
    expect(plugin.list_command()).toContain("--lock-wait 30");
  });

  it("sets a writable borg base dir", () => {
    const plugin = make();
    expect(plugin.list_command()).toContain('BORG_BASE_DIR="$__x_monitor_poll_base"');
    expect(plugin.poll_command_text()).toContain("__x_monitor_poll_base=$(mktemp -d)");
  });

  it("passes the passphrase as env, not argv", () => {
    const command_text = make({ ...base_config, passphrase: phrase }).list_command();
    expect(command_text).toContain("BORG_PASSPHRASE=");
    expect(command_text.indexOf("BORG_PASSPHRASE=")).toBeLessThan(command_text.indexOf("borg list"));
  });

  it("passes a passphrase command as BORG_PASSCOMMAND", () => {
    const command_text = make({ ...base_config, passphrase_command: "cat /run/phrase" }).list_command();
    expect(command_text).toContain("BORG_PASSCOMMAND=");
    expect(command_text).not.toContain("BORG_PASSPHRASE=");
  });

  it("inlines a passphrase file", () => {
    const file = join(temp_dir(), "borg.pass");
    writeFileSync(file, "words-from-file\n");
    const command_text = make({ ...base_config, passphrase_file: file }).list_command();
    expect(command_text).toContain("BORG_PASSPHRASE=words-from-file");
    expect(command_text).not.toContain("BORG_PASSCOMMAND=");
    expect(command_text).not.toContain(file);
  });

  it("prefers a passphrase over a passphrase file", () => {
    const file = join(temp_dir(), "borg.pass");
    writeFileSync(file, "from-file");
    const command_text = make({ ...base_config, passphrase: "inline-wins", passphrase_file: file }).list_command();
    expect(command_text).toContain("BORG_PASSPHRASE=inline-wins");
    expect(command_text).not.toContain("from-file");
  });

  it("omits the env for a missing passphrase file", () => {
    const command_text = make({ ...base_config, passphrase_file: join(temp_dir(), "nope") }).list_command();
    expect(command_text).not.toContain("BORG_PASSPHRASE=");
    expect(command_text).not.toContain("BORG_PASSCOMMAND=");
  });

  it("omits the env without a passphrase", () => {
    const command_text = make().list_command();
    expect(command_text).not.toContain("BORG_PASSPHRASE=");
    expect(command_text).not.toContain("BORG_PASSCOMMAND=");
  });

  it("takes list_archives from config", () => {
    expect(make({ ...base_config, list_archives: 3 }).list_command()).toContain("--last 3");
  });

  it("clamps list_archives to at least one", () => {
    expect(make({ ...base_config, list_archives: 0 }).list_command()).toContain("--last 1");
  });

  it("sets BORG_RSH from ssh_key", () => {
    const command_text = make({ ...base_config, ssh_key: "/run/secrets/x_monitor_ssh_key" }).list_command();
    for (const part of ["BORG_RSH=", "/run/secrets/x_monitor_ssh_key", "IdentitiesOnly=yes", "BatchMode=yes"]) expect(command_text).toContain(part);
  });

  it("applies ssh_key to a backup too", () => {
    expect(make({ ...base_config, source_paths: ["/home"], ssh_key: "/run/secrets/k" }).backup_command()).toContain("BORG_RSH=");
  });

  it("lets rsh override ssh_key", () => {
    const command_text = make({ ...base_config, ssh_key: "/run/secrets/k", rsh: "ssh -J jump.host" }).list_command();
    expect(command_text).toContain("ssh -J jump.host");
    expect(command_text).not.toContain("/run/secrets/k");
  });

  it("sets no BORG_RSH without a key", () => {
    expect(make().list_command()).not.toContain("BORG_RSH=");
  });

  it("defaults to a longer timeout", () => {
    const plugin = make();
    expect(plugin.timeout).toBe(Borg.DEFAULT_TIMEOUT);
    expect(plugin.timeout).toBeGreaterThan(COLLECT_TIMEOUT);
  });

  it("takes a timeout from config", () => {
    expect(make({ ...base_config, timeout: "10m" }).timeout).toBe(600);
  });

  it("uses no sudo by default", () => {
    expect(make().list_command()).not.toContain("sudo");
  });

  it("prefixes sudo when required", () => {
    const command_text = make({ ...base_config, require_sudo: true }).list_command();
    expect(command_text.indexOf("sudo -n ")).toBeLessThan(command_text.indexOf("borg list"));
  });

  it("keeps the env after sudo", () => {
    const command_text = make({ ...base_config, require_sudo: true, passphrase: phrase }).list_command();
    expect(command_text.indexOf("sudo")).toBeLessThan(command_text.indexOf("BORG_PASSPHRASE="));
    expect(command_text.indexOf("BORG_PASSPHRASE=")).toBeLessThan(command_text.indexOf("borg list"));
  });

  it("supports a local path repo", () => {
    expect(make({ ...base_config, repo: "/mnt/backups/repo" }).list_command()).toContain("/mnt/backups/repo");
  });

  it("takes borg_bin and lock_wait from config", () => {
    const command_text = make({ ...base_config, borg_bin: "/opt/borg", lock_wait: 30 }).list_command();
    expect(command_text).toContain("/opt/borg list");
    expect(command_text).toContain("--lock-wait 30");
  });
});

describe("sequential poll", () => {
  it("is a single command", () => {
    expect(make().commands()).toHaveLength(1);
  });

  it("runs list before info", () => {
    const command_text = make().poll_command_text();
    expect(command_text.indexOf("borg list")).toBeLessThan(command_text.indexOf("borg info"));
  });

  it("sequences the calls rather than backgrounding them", () => {
    expect(make().poll_command_text()).not.toContain(" & ");
  });

  it("polls once with stats off", () => {
    expect(make({ ...base_config, collect_stats: false }).poll_command_text()).not.toContain("borg info");
  });

  it("keeps each call's exit code", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 60), ""), cmd_result(2, "", "borg info exploded"));
    expect(result.status).toBe("online");
    expect(result.logs.some(([message]) => message.includes("borg info failed (exit 2)"))).toBe(true);
  });

  it("keeps each call's streams apart", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 60), "Remote: Replaying segments..."));
    expect(result.status).toBe("online");
  });

  it("fails the listing when the shell failed before the first frame", () => {
    const result = run_cycle(make(), () => cmd_result(1, "", "sudo: a terminal is required"));
    expect(result.status).toBe("failed");
    expect(result.logs.some(([message]) => message.includes("NOPASSWD"))).toBe(true);
  });

  it("reports the call a cut-short poll never ran", () => {
    const transcript = framed(cmd_result(0, multi_json(now() - 60), ""));
    const result = run_cycle(make(), () => transcript);
    expect(result.status).toBe("online");
    expect(result.logs.some(([message]) => message.includes("borg info failed"))).toBe(true);
  });
});

describe("lock hints", () => {
  it("points a repo lock at a running backup", () => {
    const text = messages(collect(make(), cmd_result(2, "", "Failed to create/acquire the lock /srv/repo/lock.exclusive (timeout).")));
    expect(text).toContain("a backup may be running");
    expect(text).not.toContain("chunks cache");
  });

  it("points a cache lock at the shared cache dir", () => {
    const text = messages(collect(make(), cmd_result(2, "", "Failed to create/acquire the lock /var/cache/x-monitor-borg/.cache/borg/abc123/lock.exclusive (timeout).")));
    expect(text).toContain("chunks cache");
    expect(text).toContain("cache_dir");
    expect(text).not.toContain("a backup may be running");
  });
});

describe("poll deadline", () => {
  it("bounds a sudo poll by a root-side timeout", () => {
    const plugin = make({ ...base_config, require_sudo: true, timeout: "30m" });
    expect(plugin.list_command()).toContain('timeout -k 5 "$(__x_monitor_poll_left)"');
    expect(plugin.info_command()).toContain('timeout -k 5 "$(__x_monitor_poll_left)"');
  });

  it("covers the whole poll with one deadline", () => {
    const command_text = make({ ...base_config, timeout: "30m" }).poll_command_text();
    expect(command_text.split("+ 1800 ))").length - 1).toBe(1);
    expect(command_text.split('timeout -k 5 "$(__x_monitor_poll_left)"').length - 1).toBe(2);
  });

  it("puts the deadline after sudo so root owns it", () => {
    const command_text = make({ ...base_config, require_sudo: true, timeout: "30m" }).list_command();
    expect(command_text.indexOf("sudo -n")).toBeLessThan(command_text.indexOf("timeout -k"));
  });

  it("puts the deadline after the env assignments", () => {
    const command_text = make({ ...base_config, require_sudo: true, timeout: "30m", passphrase_command: "cat /k" }).list_command();
    expect(command_text.indexOf("BORG_PASSCOMMAND=")).toBeLessThan(command_text.indexOf("timeout -k"));
  });

  it("does not bound a backup by the poll deadline", () => {
    const head = make({ ...base_config, require_sudo: true, timeout: "30m" }).backup_command().split("borg")[0];
    expect(head).not.toContain("timeout");
  });
});

const backup_config: PluginConfig = { ...base_config, source_paths: ["/home", "/etc"] };
const full_config: PluginConfig = { ...base_config, source_paths: ["/home"], canary_path: "home/canary", keep_daily: 7, allow_delete: true, allow_purge: true, exclude: ["*.tmp"] };

const action_ids = (plugin: Borg) => plugin.get_actions().map((action) => action.action_id);
const action = (plugin: Borg, action_id: string) => plugin.get_actions().find((each) => each.action_id === action_id)!;

// Drives plan_action, a launch answering with the remote pid, then interpret_action, as the engine does for a detached job.
function launch(plugin: Borg, action_id = "run_backup", pid = 4242, args: Record<string, unknown> = {}): CollectResult | null {
  const plan = plugin.plan_action(action_id, args);
  if (plan === null) return null;
  if (plan instanceof CollectResult) {
    apply(plugin, plan);
    return plan;
  }
  const outcome = outcome_of(plugin, action_id, cmd_result(0, `${pid}\n`, ""), args);
  apply(plugin, outcome);
  return outcome;
}

// The raw stdout one poll_command produces on the target.
function poll(size: number, exit_code: number | null, alive: boolean, out: string): CmdResult {
  return cmd_result(0, `===XMONITOR_SIZE===\n${size}\n===XMONITOR_EXIT===\n${exit_code ?? ""}\n===XMONITOR_ALIVE===\n${alive ? 1 : 0}\n===XMONITOR_OUT===\n${out}`, "");
}

// Drives one cycle while a job runs: commands() emits the poll and parse() advances the job from its output.
function poll_once(plugin: Borg, poll_result: CmdResult): CollectResult {
  expect(plugin.commands()).toHaveLength(1);
  const result = plugin.parse([poll_result]);
  apply(plugin, result);
  return result;
}

describe("actions", () => {
  it("offers only repo actions without further config", () => {
    expect(action_ids(make())).toEqual(["check_repo", "compact_repo"]);
  });

  it("offers backups with source paths", () => {
    expect(action_ids(make({ ...base_config, source_paths: ["/home"] }))).toEqual(expect.arrayContaining(["run_backup", "dry_run_backup"]));
  });

  it("makes every tool a header action when configured", () => {
    expect(action_ids(make(full_config))).toEqual(["run_backup", "dry_run_backup", "verify_restore", "check_repo", "compact_repo", "prune_preview", "prune_repo", "purge_preview", "purge_excluded", "break_lock"]);
  });

  it("puts occasional tools in the more menu", () => {
    expect(make(full_config).get_actions().filter((each) => each.more).map((each) => each.action_id)).toEqual(["verify_restore", "prune_preview", "prune_repo", "purge_preview", "purge_excluded", "break_lock"]);
  });

  it("opens the prune preview dialog", () => {
    const plugin = make(full_config);
    const preview = action(plugin, "prune_preview");
    expect(preview.kind).toBe("dialog");
    expect(Object.keys(plugin.UI_SPEC.dialogs!)).toContain(preview.dialog);
  });

  it("asks first before a destructive tool and names the repo", () => {
    const plugin = make(full_config);
    for (const action_id of ["prune_repo", "purge_excluded", "break_lock"]) {
      expect(action(plugin, action_id).variant).toBe("danger");
      expect(action(plugin, action_id).confirm).toContain(base_config.repo);
    }
  });

  it("accents a running check and greys out other jobs", () => {
    const plugin = make(full_config);
    launch(plugin, "check_repo");
    expect(plugin.action_state(action(plugin, "check_repo"))).toBe("accent");
    expect(plugin.action_state(action(plugin, "run_backup"))).toBe("disabled");
    expect(plugin.action_state(action(plugin, "break_lock"))).toBe("disabled");
    expect(plugin.action_state(action(plugin, "verify_restore"))).toBe("normal");
  });

  it("leaves break lock normal while no job runs", () => {
    const plugin = make(full_config);
    expect(plugin.action_state(action(plugin, "break_lock"))).toBe("normal");
  });

  it("keeps job controls in the header only", () => {
    const spec = make().UI_SPEC;
    expect(spec.buttons).toBeUndefined();
    expect(spec.job_panel!.run_action_id).toBeUndefined();
  });

  it("titles the archives table", () => {
    expect((make().UI_SPEC.tables!.archives as { title?: string }).title).toBe("Archives");
  });

  it("handles no unknown action", () => {
    expect(make().plan_action("nonsense")).toBeNull();
  });

  it("fails a backup without source paths", () => {
    const plan = refused_of(make(), "run_backup");
    expect(plan.success).toBe(false);
    expect(plan.logs.some(([message]) => message.includes("source_paths"))).toBe(true);
  });
});

describe("backup command", () => {
  it("includes the sources and the repo archive", () => {
    const command_text = make(backup_config).backup_command();
    for (const part of ["borg create", "/home", "/etc", "ssh://borg@host/srv/repo::"]) expect(command_text).toContain(part);
  });

  it("names the archive by prefix and a sortable time", () => {
    expect(make({ ...backup_config, archive_prefix: "nightly" }).default_archive_name()).toMatch(/^nightly-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("names the archive in local time", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Jamaica";
    try {
      const stamp = make({ ...backup_config, archive_prefix: "nightly" }).default_archive_name().slice("nightly-".length);
      const [date, time] = stamp.split("T");
      const [year, month, day] = date.split("-").map(Number);
      const [hour, minute, second] = time.split(":").map(Number);
      expect(Math.abs(new Date(year, month - 1, day, hour, minute, second).getTime() - Date.now())).toBeLessThan(5000);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("defaults the archive prefix to the monitor's name", () => {
    expect(make(backup_config).default_archive_name().startsWith("test-borg-")).toBe(true);
  });

  it("passes excludes", () => {
    const command_text = make({ ...backup_config, exclude: ["/home/*/.cache", "*.tmp"] }).backup_command();
    expect(command_text.split("--exclude ").length - 1).toBeGreaterThanOrEqual(2);
    expect(command_text).toContain("/home/*/.cache");
    expect(command_text).toContain("*.tmp");
  });

  it("accepts a bare exclude string", () => {
    const plugin = make({ ...backup_config, exclude: "/tmp" });
    expect(plugin.exclude).toEqual(["/tmp"]);
    expect(plugin.backup_command()).toContain("/tmp");
  });

  it("accepts a bare source path string", () => {
    expect(make({ ...base_config, source_paths: "/home" }).source_paths).toEqual(["/home"]);
  });

  it("passes exclude_from", () => {
    expect(make({ ...backup_config, exclude_from: "/etc/borg.excludes" }).backup_command()).toContain("--exclude-from /etc/borg.excludes");
  });

  it("passes exclude_if_present markers", () => {
    expect(make({ ...backup_config, exclude_if_present: [".nobackup"] }).backup_command()).toContain("--exclude-if-present .nobackup");
  });

  it("stays on one file system by default", () => {
    expect(make(backup_config).backup_command()).toContain("--one-file-system");
  });

  it("can cross file systems", () => {
    expect(make({ ...backup_config, one_file_system: false }).backup_command()).not.toContain("--one-file-system");
  });

  it("excludes caches by default", () => {
    expect(make(backup_config).backup_command()).toContain("--exclude-caches");
  });

  it("takes the compression from config", () => {
    expect(make({ ...backup_config, compression: "zstd,10" }).backup_command()).toContain("--compression zstd,10");
  });

  it("compresses with zstd by default", () => {
    expect(make(backup_config).backup_command()).toContain("--compression zstd");
  });

  it("uses the persistent cache dir for a backup", () => {
    const command_text = make(backup_config).backup_command();
    expect(command_text).toContain("BORG_BASE_DIR=/var/cache/x-monitor-borg");
    expect(command_text).not.toContain("mktemp");
  });

  it("takes the cache dir from config", () => {
    expect(make({ ...backup_config, cache_dir: "/srv/borgcache" }).backup_command()).toContain("BORG_BASE_DIR=/srv/borgcache");
  });

  it("still uses a throwaway base dir for a poll", () => {
    expect(make(backup_config).poll_command_text()).toContain("$(mktemp -d)");
  });

  it("gives a configured cache dir a scratch dir too", () => {
    const command_text = make({ ...base_config, cache_dir: "/srv/borgcache" }).poll_command_text();
    expect(command_text).toContain("$(mktemp -d)");
    expect(command_text).toContain("BORG_BASE_DIR=/srv/borgcache");
    expect(command_text).not.toContain('BORG_BASE_DIR="$__x_monitor_poll_base"');
  });

  it("applies a configured cache dir to polls", () => {
    const plugin = make({ ...base_config, cache_dir: "/srv/borgcache" });
    for (const command_text of [plugin.list_command(), plugin.info_command()]) {
      expect(command_text).toContain("BORG_BASE_DIR=/srv/borgcache");
      expect(command_text).not.toContain("mktemp");
      expect(command_text).not.toContain("rm -rf");
    }
  });

  it("removes a poll's throwaway base dir", () => {
    const command_text = make(backup_config).poll_command_text();
    expect(command_text).toContain("trap 'rm -rf");
    expect(command_text.indexOf("mktemp -d")).toBeLessThan(command_text.indexOf("BORG_BASE_DIR="));
  });

  it("keeps the persistent cache dir after a backup", () => {
    expect(make(backup_config).backup_command()).not.toContain("rm -rf");
  });

  it("waits long for the lock on a backup", () => {
    expect(make(backup_config).backup_command()).toContain("--lock-wait 600");
  });

  it("takes backup_lock_wait from config", () => {
    expect(make({ ...backup_config, backup_lock_wait: 30 }).backup_command()).toContain("--lock-wait 30");
  });

  it("emits structured progress", () => {
    const command_text = make(backup_config).backup_command();
    expect(command_text).toContain("--log-json");
    expect(command_text).toContain("--progress");
  });

  it("adds --dry-run and drops --stats on a dry run", () => {
    const command_text = make(backup_config).backup_command(null, true);
    expect(command_text).toContain("--dry-run");
    expect(command_text).not.toContain("--stats");
  });

  it("includes --stats on a real backup", () => {
    const command_text = make(backup_config).backup_command(null, false);
    expect(command_text).toContain("--stats");
    expect(command_text).not.toContain("--dry-run");
  });

  it("inlines the passphrase for a backup", () => {
    expect(make({ ...backup_config, passphrase: phrase }).backup_command()).toContain(`BORG_PASSPHRASE=${phrase}`);
  });

  it("honours require_sudo for a backup", () => {
    expect(make({ ...backup_config, require_sudo: true }).backup_command().startsWith("sudo -n ")).toBe(true);
  });
});

describe("backup launch", () => {
  it("records a running job", () => {
    const plugin = make(backup_config);
    expect(launch(plugin, "run_backup", 1234)!.success).toBe(true);
    const job = plugin.jobs!.running()!;
    expect(job).toMatchObject({ kind: "backup", pid: 1234, state: "running" });
  });

  it("records a dry run's kind", () => {
    const plugin = make(backup_config);
    launch(plugin, "dry_run_backup");
    expect(plugin.jobs!.running()!.kind).toBe("dry-run");
  });

  it("records no job on a failed launch", () => {
    const plugin = make(backup_config);
    plugin.plan_action("run_backup");
    const outcome = outcome_of(plugin, "run_backup", cmd_result(1, "", "boom"));
    apply(plugin, outcome);
    expect(outcome.success).toBe(false);
    expect(plugin.jobs!.running()).toBeNull();
  });

  it("stores the launched command redacted", () => {
    const plugin = make(backup_config);
    plugin.passphrase = phrase;
    launch(plugin);
    const stored = plugin.jobs!.running()!.command;
    expect(stored).not.toContain(phrase);
    expect(stored).toContain("BORG_PASSPHRASE=*****");
  });

  it("refuses a second backup while one runs", () => {
    const plugin = make(backup_config);
    launch(plugin);
    const refused = refused_of(plugin, "run_backup");
    expect(refused).toBeInstanceOf(CollectResult);
    expect(refused.logs.some(([message]) => message.includes("already running"))).toBe(true);
  });
});

describe("backup polling", () => {
  it("keeps a running job running", () => {
    const plugin = make(backup_config);
    launch(plugin);
    poll_once(plugin, poll(10, null, true, "working\n"));
    expect(plugin.jobs!.running()).not.toBeNull();
  });

  it("leaves the job running on an unanswered poll", () => {
    const plugin = make(backup_config);
    launch(plugin);
    const result = poll_once(plugin, cmd_result(-1, "", "Agent 'x' is not connected"));
    expect(plugin.jobs!.running()).not.toBeNull();
    expect(result.logs.some(([message]) => message.includes("Could not poll"))).toBe(true);
  });

  it("does not let a job started mid-cycle swallow the listing", () => {
    const plugin = make(backup_config);
    const commands = plugin.commands();
    expect(commands.length).toBeGreaterThanOrEqual(1);
    launch(plugin);
    apply(plugin, plugin.parse(commands.map(() => cmd_result(1, "", "repo busy"))));
    expect(plugin.jobs!.running()).not.toBeNull();
  });

  it("marks a completed job succeeded", () => {
    const plugin = make(backup_config);
    launch(plugin);
    poll_once(plugin, poll(20, 0, false, "done\n"));
    expect(plugin.jobs!.running()).toBeNull();
    expect(plugin.jobs!.recent()[0].state).toBe("succeeded");
  });

  it("counts a borg warning exit as success", () => {
    const plugin = make(backup_config);
    launch(plugin);
    poll_once(plugin, poll(5, 1, false, ""));
    expect(plugin.jobs!.recent()[0].state).toBe("succeeded");
  });

  it("counts a borg error exit as failure", () => {
    const plugin = make(backup_config);
    launch(plugin);
    poll_once(plugin, poll(5, 2, false, ""));
    expect(plugin.jobs!.recent()[0]).toMatchObject({ state: "failed", exit_code: 2 });
  });

  it("fails a dead process without an exit file", () => {
    const plugin = make(backup_config);
    launch(plugin);
    poll_once(plugin, poll(5, null, false, "partial"));
    expect(plugin.jobs!.recent()[0].state).toBe("failed");
  });

  it("reads progress from log-json on a poll", () => {
    const plugin = make(backup_config);
    launch(plugin);
    const progress = JSON.stringify({ type: "archive_progress", path: "/home/user/file.txt", original_size: 1048576, deduplicated_size: 524288, nfiles: 42 });
    poll_once(plugin, poll(progress.length + 1, null, true, progress + "\n"));
    const job = plugin.jobs!.running()!;
    expect(job.progress).toContain("42 files");
    expect(job.progress).toContain("/home/user/file.txt");
  });

  it("ignores zero-counter progress", () => {
    const plugin = make(backup_config);
    launch(plugin);
    const real = JSON.stringify({ original_size: 1048576, deduplicated_size: 524288, nfiles: 42, path: "src/big.bin", type: "archive_progress", finished: false });
    const opening = JSON.stringify({ original_size: 0, deduplicated_size: 0, nfiles: 0, path: "src", type: "archive_progress", finished: false });
    poll_once(plugin, poll(real.length + 1, null, true, real + "\n"));
    expect(plugin.jobs!.running()!.progress).toContain("42 files");
    const offset = plugin.jobs!.running()!.output_seq;
    poll_once(plugin, poll(offset + opening.length + 1, null, true, opening + "\n"));
    expect(plugin.jobs!.running()!.progress).toContain("42 files");
  });

  it("stores the output lines", () => {
    const plugin = make(backup_config);
    launch(plugin);
    poll_once(plugin, poll(12, 0, false, "line1\nline2\n"));
    const job_id = plugin.jobs!.recent()[0].id;
    expect(store_of(plugin).job_output(job_id).map((output) => output.message)).toEqual(["line1", "line2"]);
  });

  it("completes a partial line across polls", () => {
    const plugin = make(backup_config);
    launch(plugin);
    poll_once(plugin, poll(4, null, true, "par"));
    const job_id = plugin.jobs!.running()!.id;
    expect(store_of(plugin).job_output(job_id)).toEqual([]);
    poll_once(plugin, poll(8, 0, false, "partial\n"));
    expect(store_of(plugin).job_output(job_id).map((output) => output.message)).toEqual(["partial"]);
  });
});

function info_json(total = 1000, csize = 500, unique = 250): string {
  return JSON.stringify({
    cache: { stats: { total_size: total, total_csize: csize, unique_csize: unique, total_chunks: 100, total_unique_chunks: 50 } },
    repository: { location: "/srv/repo" },
  });
}

describe("repo stats", () => {
  it("asks borg info for json", () => {
    const command_text = make().info_command();
    expect(command_text).toContain("borg info");
    expect(command_text).toContain("--json");
  });

  it("records the stats as metrics", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 60), ""), cmd_result(0, info_json(), ""));
    expect(latest_metric(plugin, "original_size")).toBeCloseTo(1000);
    expect(latest_metric(plugin, "deduplicated_size")).toBeCloseTo(250);
  });

  it("derives the dedup ratio", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 60), ""), cmd_result(0, info_json(1000, 500, 250), ""));
    expect(latest_metric(plugin, "dedup_ratio")).toBeCloseTo(4.0);
  });

  it("skips the info call with stats off", () => {
    expect(make({ ...base_config, collect_stats: false }).commands()).toHaveLength(1);
  });

  it("does not fail the monitor on an info failure", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 60), ""), cmd_result(2, "", "info exploded"));
    expect(latest_status(plugin)).toBe("online");
  });

  it("tolerates unparseable info", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 60), ""), cmd_result(0, "not json", ""));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails an empty repo without stats", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(null), ""));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("records no metrics without cache stats", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 60), ""), cmd_result(0, JSON.stringify({ repository: {} }), ""));
    expect(latest_metric(plugin, "original_size")).toBeNull();
  });
});

describe("event logging", () => {
  it("writes messages where the page reads them", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, list_json(now() - 60), ""));
    const db = store_of(plugin);
    expect(db.recent_events(200).filter((event) => event.message.startsWith("[test-borg] ")).length).toBeGreaterThan(0);
    expect(db.log_lines("test.host")).toHaveLength(0);
  });
});

describe("archive cache", () => {
  it("caches the archives for the page", () => {
    const plugin = make({ ...base_config, collect_stats: false });
    run_cycle(plugin, () => cmd_result(0, multi_json(now() - 3600, now() - 7200), ""));
    const [archives, info] = plugin.cached_archives();
    expect(archives.map((archive) => archive.name)).toEqual(["archive-0", "archive-1"]);
    expect(info.location).toBe("/srv/repo");
  });

  it("is empty before the first poll", () => {
    expect(make().cached_archives()).toEqual([[], {}]);
  });

  it("merges archive sizes from info", () => {
    const plugin = make();
    const info = JSON.stringify({
      cache: { stats: { total_size: 1000, total_csize: 500, unique_csize: 250 } },
      archives: [{ name: "archive-0", stats: { original_size: 400000, compressed_size: 300000, deduplicated_size: 1024, nfiles: 42 } }],
    });
    collect(plugin, cmd_result(0, multi_json(now() - 3600), ""), cmd_result(0, info, ""));
    const first = plugin.cached_archives()[0].find((archive) => archive.name === "archive-0")!;
    expect(first.original).toBeCloseTo(400000);
    expect(first.deduplicated).toBeCloseTo(1024);
    expect(first.nfiles).toBeCloseTo(42);
  });

  it("asks info for per-archive stats", () => {
    expect(make({ ...base_config, list_archives: 5 }).info_command()).toContain("--last 5");
  });

  it("keeps archive names without stats", () => {
    const plugin = make();
    collect(plugin, cmd_result(0, multi_json(now() - 3600), ""), cmd_result(0, JSON.stringify({ cache: { stats: { total_size: 10, unique_csize: 5 } } }), ""));
    const [archives] = plugin.cached_archives();
    expect(archives.map((archive) => archive.name)).toEqual(["archive-0"]);
    expect("original" in archives[0]).toBe(false);
  });
});

const canary_config: PluginConfig = { ...base_config, canary_path: "/Storage/System/.x-monitor-canary", collect_stats: false };

// Drives one poll, answering each planned call from `extra` by name and the listing with a fresh archive.
function cycle_with(plugin: Borg, extra: Record<string, CmdResult> = {}): CollectResult {
  const answers: Record<string, CmdResult> = { list: cmd_result(0, list_json(now() - 60), ""), info: cmd_result(0, "{}", ""), ...extra };
  return run_cycle(plugin, () => framed(...plugin.poll_calls.map((name) => answers[name])));
}

describe("restore canary", () => {
  it("does not run before an archive is known", () => {
    const plugin = make(canary_config);
    plugin.commands();
    expect(plugin.poll_calls).toEqual(["list"]);
  });

  it("runs once the newest archive is known", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    const command_text = plugin.commands()[0].text;
    expect(plugin.poll_calls).toEqual(["list", "canary", "canary_live"]);
    expect(command_text).toContain("extract --stdout");
    expect(command_text.replaceAll("'", "")).toContain("host-2024 Storage/System/.x-monitor-canary");
  });

  it("reads the live canary without sudo first", () => {
    const canary = join(temp_dir(), ".x-monitor-canary");
    writeFileSync(canary, "token");
    const plugin = make({ ...canary_config, canary_path: canary, require_sudo: true });
    cycle_with(plugin);
    const live = new Map(plugin.poll_plan()).get("canary_live")!;
    // Run inside the real framed sequence, whose output redirect must capture the plain read; no sudo is on PATH here.
    const out = sh(plugin.sequence_command([live]), { PATH: "/run/current-system/sw/bin:/usr/bin:/bin" });
    const result = split_poll(cmd_result(out.status ?? -1, out.stdout, out.stderr), 1)[0];
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("token");
    expect(live).toContain("|| sudo -n cat");
  });

  it("passes a matching canary", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    plugin.commands();
    cycle_with(plugin, { canary: cmd_result(0, "token", ""), canary_live: cmd_result(0, "token\n", "") });
    expect(latest_metric(plugin, "canary_ok")).toBe(1.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails the monitor on a differing canary", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    plugin.commands();
    cycle_with(plugin, { canary: cmd_result(0, "old", ""), canary_live: cmd_result(0, "new", "") });
    expect(latest_metric(plugin, "canary_ok")).toBe(0.0);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("keeps the monitor failed until a failed canary passes", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    plugin.commands();
    cycle_with(plugin, { canary: cmd_result(1, "", "Include pattern 'x' never matched."), canary_live: cmd_result(0, "t", "") });
    plugin.commands();
    expect(plugin.poll_calls).not.toContain("canary");
    cycle_with(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("reaches no verdict on a locked repo", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    plugin.commands();
    cycle_with(plugin, { canary: cmd_result(2, "", "Failed to create/acquire the lock /r/lock (timeout)."), canary_live: cmd_result(0, "t", "") });
    expect(latest_metric(plugin, "canary_ok")).toBeNull();
    expect(latest_status(plugin)).toBe("online");
  });

  it("records the verdict of the verify restore action", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    const plan = plan_of(plugin, "verify_restore");
    expect(plan.command).toContain("extract --stdout");
    expect(plan.detached).toBe(true);
    expect(plan.timeout).toBeNull();
    const outcome = outcome_of(plugin, "verify_restore", framed(cmd_result(0, "t", ""), cmd_result(0, "t", "")));
    apply(plugin, outcome);
    expect(outcome.success).toBe(true);
    expect(outcome.status).toBeNull();
    expect(latest_metric(plugin, "canary_ok")).toBe(1.0);
  });
});

const check_config: PluginConfig = { ...base_config, repo: "/srv/local", check_units: ["borgmatic-check.service"], collect_stats: false };

function checks_out(fields: { ok?: number; end?: number; start?: number; errs?: [number, string][] } = {}): CmdResult {
  const line = (epoch: number | undefined, text: string) => (epoch ? `${epoch}.000000 host systemd[1]: ${text}` : "");
  const lines = [
    "unit=borgmatic-check.service",
    "ok=" + line(fields.ok, "Finished Checks."),
    "end=" + (fields.end ? line(fields.end, "borgmatic-check.service: Failed with result 'exit-code'.") : line(fields.ok, "Finished Checks.")),
    "start=" + line(fields.start, "Starting Checks..."),
    ...(fields.errs ?? []).map(([epoch, repo]) => `err=${epoch}.0 host borgmatic[9]: Command 'borg check --info ${repo}' returned non-zero exit status 1.`),
  ];
  return cmd_result(0, lines.join("\n"), "");
}

describe("check freshness", () => {
  it("passes a recent success", () => {
    const plugin = make(check_config);
    plugin.commands();
    cycle_with(plugin, { checks: checks_out({ ok: now() - 3600 }) });
    expect(latest_metric(plugin, "checks_ok")).toBe(1.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a stale success", () => {
    const plugin = make(check_config);
    plugin.commands();
    cycle_with(plugin, { checks: checks_out({ ok: now() - 10 * 86400 }) });
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails with no record", () => {
    const plugin = make(check_config);
    plugin.commands();
    cycle_with(plugin, { checks: checks_out() });
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails a failure naming this repo", () => {
    const plugin = make(check_config);
    plugin.commands();
    const at = now();
    cycle_with(plugin, { checks: checks_out({ ok: at - 86400, end: at - 60, start: at - 600, errs: [[at - 70, "/srv/local"]] }) });
    expect(latest_status(plugin)).toBe("failed");
  });

  it("counts a failure naming only another repo as a pass", () => {
    const plugin = make(check_config);
    plugin.commands();
    const at = now();
    cycle_with(plugin, { checks: checks_out({ end: at - 60, start: at - 600, errs: [[at - 70, "ssh://borg@far/srv/local"]] }) });
    expect(latest_metric(plugin, "checks_ok")).toBe(1.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("keeps the last success through a rotated journal", () => {
    const plugin = make(check_config);
    plugin.commands();
    cycle_with(plugin, { checks: checks_out({ ok: now() - 3600 }) });
    plugin.commands();
    cycle_with(plugin, { checks: checks_out() });
    expect(latest_status(plugin)).toBe("online");
  });

  it("reads only systemd's own lines", () => {
    const plugin = make(check_config);
    plugin.commands();
    expect(plugin.poll_command_text()).toContain("_PID=1");
  });
});

const prune_output = `Keeping archive (rule: daily #1):            backup-2026-09-23T00:00:00           Tue, 2026-09-22 19:00:00 [d0e5]
Would prune:                                 backup-2026-09-22T00:00:00           Mon, 2026-09-21 19:00:00 [43a8]
Keeping archive (rule: weekly #1):           backup-2026-09-21T00:00:00           Sun, 2026-09-20 19:00:00 [c598]`;

describe("prune preview", () => {
  it("is refused without retention", () => {
    const outcome = refused_of(make(), "prune_preview");
    expect(outcome.success).toBe(false);
    expect(outcome.status).toBeNull();
  });

  it("dry-runs the configured policy", () => {
    const command_text = plan_of(make({ ...base_config, keep_daily: 7, keep_within: "6H", archive_prefix: "odin" }), "prune_preview").command;
    expect(command_text).toContain("prune --dry-run --list");
    expect(command_text).toContain("--keep-daily 7");
    expect(command_text).toContain("--keep-within 6H");
    expect(command_text).toContain("--glob-archives 'odin-*'");
  });

  it("lists what would go", () => {
    const plugin = make({ ...base_config, keep_daily: 1 });
    const content = outcome_of(plugin, "prune_preview", framed(cmd_result(0, "", prune_output))).metadata.content;
    expect(content).toContain("Would prune 1 of 3");
    expect(content.split("Keeping")[0]).toContain("backup-2026-09-22T00:00:00");
  });

  it("leaves the status alone on a failure", () => {
    const plugin = make({ ...base_config, keep_daily: 1 });
    const outcome = outcome_of(plugin, "prune_preview", framed(cmd_result(2, "", "Failed to create/acquire the lock")));
    expect(outcome.success).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.metadata.content).toContain("locked");
  });
});

const listing = ["d\t0\t2026-09-20T10:00:00.000000\tStorage/System/etc", "-\t2048\t2026-09-20T10:01:00.000000\tStorage/System/notes.txt", "d\t\t\tStorage/System/var"].join("\n");

// Runs the children filter the browse command uses over a borg listing, in a real shell.
function run_filter(member: string, lines: string): string {
  const file = join(temp_dir(), "listing");
  writeFileSync(file, lines + "\n");
  const out = sh(`${children_filter(member)} ${file}`);
  expect(out.status).toBe(0);
  return out.stdout;
}

const output_lines = (text: string) => text.split("\n").filter((line, index, all) => !(index === all.length - 1 && line === ""));

describe("browse", () => {
  it("lists the path through the children filter", () => {
    const command_text = plan_of(make(), "browse_archive", { archive: "a1", path: "/Storage/System/" }).command;
    expect(command_text.replaceAll("'", "")).toContain("::a1 Storage/System");
    expect(command_text).toContain("awk -v p=Storage/System/");
  });

  it("lists the whole archive at the top level", () => {
    const command_text = plan_of(make(), "browse_archive", { archive: "a1", path: "" }).command;
    expect(command_text).not.toContain("::a1 --format");
    expect(command_text).toContain("awk -v p=''");
  });

  it("keeps direct children only", () => {
    const out = run_filter("Storage", ["d\t0\t2026-09-20T10:00:00\tStorage", "-\t5\t2026-09-20T10:00:00\tStorage/a.txt", "-\t5\t2026-09-20T10:00:00\tStorage/deep/b.txt"].join("\n"));
    expect(output_lines(out)).toEqual(["-\t5\t2026-09-20T10:00:00\tStorage/a.txt", "d\t\t\tStorage/deep"]);
  });

  it("makes up parents borg never stored", () => {
    const out = run_filter("", ["-\t5\t2026-09-20T10:00:00\tStorage/System/a", "-\t5\t2026-09-20T10:00:00\tStorage/System/b", "-\t5\t2026-09-20T10:00:00\thome/x"].join("\n"));
    expect(output_lines(out)).toEqual(["d\t\t\tStorage", "d\t\t\thome"]);
  });

  it("keeps a path with a tab", () => {
    expect(output_lines(run_filter("", "-\t5\t2026-09-20T10:00:00\ta\tb"))).toEqual(["-\t5\t2026-09-20T10:00:00\ta\tb"]);
  });

  it("parses and caches a listing", () => {
    const plugin = make();
    const outcome = outcome_of(plugin, "browse_archive", framed(cmd_result(0, listing, "")), { archive: "a1", path: "Storage/System" });
    expect(outcome.success).toBe(true);
    const entries = plugin.listing("a1", "/Storage/System/")!;
    expect(entries.map((entry) => entry.name)).toEqual(["etc", "var", "notes.txt"]);
    expect(entries[2].size).toBe(2048);
    expect(entries[2].mtime).toBe("2026-09-20 10:01");
  });

  it("serves a cached folder without borg", () => {
    const plugin = make();
    outcome_of(plugin, "browse_archive", framed(cmd_result(0, listing, "")), { archive: "a1", path: "Storage/System" });
    const outcome = refused_of(plugin, "browse_archive", { archive: "a1", path: "Storage/System" });
    expect(outcome.success).toBe(true);
    expect(outcome.metadata.content).toContain("3 entries");
  });

  it("fills the server's browser from a listing made on the agent", () => {
    const agent_copy = make();
    const server_copy = make();
    const outcome = outcome_of(agent_copy, "browse_archive", framed(cmd_result(0, listing, "")), { archive: "a1", path: "Storage/System" });
    server_copy.absorb_remote_action("browse_archive", outcome.metadata, { archive: "a1", path: "Storage/System" });
    expect(server_copy.listing("a1", "Storage/System")!.map((entry) => entry.name)).toEqual(["etc", "var", "notes.txt"]);
  });

  it("carries the entries of a listing served from the cache", () => {
    const plugin = make();
    outcome_of(plugin, "browse_archive", framed(cmd_result(0, listing, "")), { archive: "a1", path: "Storage/System" });
    const outcome = refused_of(plugin, "browse_archive", { archive: "a1", path: "Storage/System" });
    expect(JSON.parse(outcome.metadata.listing).entries).toHaveLength(3);
  });

  it("leaves the browser alone for other actions", () => {
    const plugin = make();
    plugin.absorb_remote_action("diff_archive", { content: "x", listing: "{}" });
    expect(plugin.listings.size).toBe(0);
  });

  it("lets a real item beat a made-up folder", () => {
    const entries = parse_listing("d\t\t\tx/etc\nd\t0\t2026-09-20T10:00:00\tx/etc");
    expect(entries).toHaveLength(1);
    expect(entries[0].mtime).toBe("2026-09-20 10:00");
  });

  it("caps the output", () => {
    const plugin = make({ ...base_config, browse_limit: 2 });
    expect(plan_of(plugin, "browse_archive", { archive: "a1", path: "" }).command).toContain("head -n 3");
    const lines = ["a", "b", "c"].map((name) => `-\t1\t\t${name}`).join("\n");
    const content = outcome_of(plugin, "browse_archive", framed(cmd_result(0, lines, "")), { archive: "a1", path: "" }).metadata.content;
    expect(content).toContain("first 2 entries");
    expect(content).not.toContain("\nc ");
  });

  it("refuses climbing paths", () => {
    expect(refused_of(make(), "browse_archive", { archive: "a1", path: "x/../../etc" }).success).toBe(false);
  });

  it("does not cache a failed listing", () => {
    const plugin = make();
    outcome_of(plugin, "browse_archive", framed(cmd_result(2, "", "boom")), { archive: "a1", path: "" });
    expect(plugin.listing("a1", "")).toBeNull();
  });
});

const restore_config: PluginConfig = { ...base_config, restore_dir: "/var/tmp/r", require_sudo: true };

describe("restore", () => {
  it("extracts into a new folder under restore_dir", () => {
    const plan = plan_of(make(restore_config), "restore_archive", { archive: "a1", path: "/Storage/System/x" });
    expect(plan.command).toContain("sudo -n mkdir -p /var/tmp/r/a1-");
    expect(plan.command).toContain("extract");
    expect(plan.command.replaceAll("'", "")).toContain("::a1 Storage/System/x");
  });

  it("records a restore job on launch", () => {
    const plugin = make(restore_config);
    plugin.plan_action("restore_archive", { archive: "a1", path: "etc" });
    const outcome = outcome_of(plugin, "restore_archive", cmd_result(0, "77\n", ""));
    apply(plugin, outcome);
    expect(plugin.jobs!.running()!.kind).toBe("restore");
    expect(outcome.metadata.content).toContain("/var/tmp/r/a1-");
  });

  it("refuses a whole-archive restore", () => {
    expect(refused_of(make(), "restore_archive", { archive: "a1", path: "/" }).success).toBe(false);
  });

  it("is refused while a job runs", () => {
    const plugin = make(restore_config);
    plugin.plan_action("restore_archive", { archive: "a1", path: "etc" });
    apply(plugin, outcome_of(plugin, "restore_archive", cmd_result(0, "77\n", "")));
    expect(refused_of(plugin, "restore_archive", { archive: "a1", path: "etc" }).success).toBe(false);
  });

  it("restores several ticked paths at once", () => {
    const plan = plan_of(make(restore_config), "restore_archive", { archive: "a1", paths: ["/etc/x", "home/y"] });
    expect(plan.command.replaceAll("'", "")).toContain("::a1 etc/x home/y");
  });

  it("refuses the lot for one climbing path", () => {
    expect(refused_of(make(restore_config), "restore_archive", { archive: "a1", paths: ["etc", "../x"] }).success).toBe(false);
  });

  it("makes extract progress the summary", () => {
    const line = JSON.stringify({ type: "progress_percent", message: " 50.0% Extracting: etc/x", finished: false });
    expect(Borg.progress_from_lines([line])).toBe("50.0% Extracting: etc/x");
  });
});

describe("backup summary", () => {
  it("reports freshness and extras", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    const summary = plugin.backup_summary();
    expect(summary.fresh).toBe(true);
    expect(summary.restore_check).toBeNull();
    expect(summary.repo_checks).toBeNull();
  });
});

// Runs a poll that lists these archives, newest first.
function listed(plugin: Borg, ...names: string[]): void {
  const at = now();
  const archives = names.map((name, index) => ({ name, start: iso(at - 3600 * (index + 1)) }));
  collect(plugin, cmd_result(0, JSON.stringify({ archives }), ""));
}

const delete_config: PluginConfig = { ...base_config, allow_delete: true, keep_daily: 7 };

describe("maintenance", () => {
  it.each([
    ["check_repo", "check", "check --progress"],
    ["compact_repo", "compact", "compact --progress"],
    ["prune_repo", "prune", "prune --list --stats --glob-archives"],
  ])("runs %s as a detached job", (action_id, kind, args) => {
    const plugin = make(delete_config);
    const plan = plan_of(plugin, action_id);
    expect(plan.command).toContain(args);
    expect(plan.command).toContain("--log-json");
    apply(plugin, outcome_of(plugin, action_id, cmd_result(0, "91\n", "")));
    expect(plugin.jobs!.running()!.kind).toBe(kind);
  });

  it("applies the retention policy on a prune", () => {
    const command_text = plan_of(make(delete_config), "prune_repo").command;
    expect(command_text).toContain("--keep-daily 7");
    expect(command_text).not.toContain("--dry-run");
  });

  it("verifies data only when asked", () => {
    expect(plan_of(make(), "check_repo").command).not.toContain("--verify-data");
    expect(plan_of(make({ ...base_config, check_verify_data: true }), "check_repo").command).toContain("--verify-data");
  });

  it.each(["prune_repo", "delete_archive", "break_lock"])("keeps %s off by default", (action_id) => {
    const outcome = refused_of(make({ ...base_config, keep_daily: 7 }), action_id, { archive: "a1" });
    expect(outcome.success).toBe(false);
    expect(outcome.metadata.content).toContain("allow_delete");
  });

  it("runs one job at a time", () => {
    const plugin = make(delete_config);
    plugin.plan_action("check_repo");
    apply(plugin, outcome_of(plugin, "check_repo", cmd_result(0, "91\n", "")));
    expect(refused_of(plugin, "compact_repo").success).toBe(false);
    expect(refused_of(plugin, "break_lock").success).toBe(false);
  });

  it("breaks the lock directly", () => {
    const plugin = make(delete_config);
    expect(plan_of(plugin, "break_lock").command).toContain("break-lock");
    expect(outcome_of(plugin, "break_lock", framed(cmd_result(0, "", ""))).success).toBe(true);
  });

  it("makes check progress messages the summary", () => {
    const line = JSON.stringify({ type: "progress_message", message: "Checking segments 12.0%", finished: false });
    expect(Borg.progress_from_lines([line])).toBe("Checking segments 12.0%");
  });
});

const purge_config: PluginConfig = { ...base_config, allow_purge: true, exclude: ["fm:*/.cache"], exclude_if_present: [".nobackup"] };

// The launched command with the quoting of its nested sh -c removed, so arguments read as typed.
function unquoted(plan: ActionPlan): string {
  return plan.command.replace(/["'\\]/g, "");
}

describe("purge", () => {
  it.each([["purge_preview", "purge-preview"], ["purge_excluded", "purge"]])("runs %s as a detached job", (action_id, kind) => {
    const plugin = make(purge_config);
    plugin.plan_action(action_id);
    apply(plugin, outcome_of(plugin, action_id, cmd_result(0, "91\n", "")));
    expect(plugin.jobs!.running()!.kind).toBe(kind);
  });

  it("rewrites with the backup exclusions then compacts", () => {
    const command_text = unquoted(plan_of(make(purge_config), "purge_excluded"));
    expect(command_text).toContain("recreate --info --stats");
    expect(command_text).not.toContain("--dry-run");
    expect(command_text).toContain("--exclude fm:*/.cache");
    expect(command_text).toContain("--exclude-if-present .nobackup");
    expect(command_text.indexOf("delete --glob-archives *.recreate")).toBeLessThan(command_text.indexOf("recreate --info"));
    expect(command_text.indexOf("recreate --info")).toBeLessThan(command_text.indexOf("compact --progress"));
  });

  it("purges every archive unless purge_match is set", () => {
    const everything = unquoted(plan_of(make(purge_config), "purge_excluded"));
    expect(everything).toContain("--glob-archives *.recreate");
    expect(everything).not.toContain("--glob-archives Odin-*");
    const scoped = unquoted(plan_of(make({ ...purge_config, purge_match: "Odin-*" }), "purge_excluded"));
    expect(scoped).toContain("recreate --info --stats --progress --glob-archives Odin-*");
  });

  it("previews with a dry run listing only excluded items", () => {
    const command_text = plan_of(make(purge_config), "purge_preview").command;
    expect(command_text).toContain("recreate --dry-run --list --filter=x");
    expect(command_text).not.toContain("compact");
  });

  it.each(["purge_preview", "purge_excluded"])("keeps %s off by default", (action_id) => {
    const outcome = refused_of(make({ ...purge_config, allow_purge: false }), action_id);
    expect(outcome.success).toBe(false);
    expect(outcome.metadata.content).toContain("allow_purge");
  });

  it("needs something to exclude", () => {
    expect(refused_of(make({ ...base_config, allow_purge: true, exclude_caches: false }), "purge_excluded").success).toBe(false);
  });

  it("makes Processing lines the summary", () => {
    expect(Borg.progress_from_lines(["Processing Odin-2026-07-23", "0 B O 0 B C 0 B D 0 N src"])).toBe("Processing Odin-2026-07-23");
  });
});

describe("delete", () => {
  it("deletes a listed archive", () => {
    const plugin = make(delete_config);
    listed(plugin, "b2", "b1");
    const plan = plan_of(plugin, "delete_archive", { archive: "b1" });
    expect(plan.command).toContain("delete --stats");
    expect(plan.command).toContain("::b1");
    expect(outcome_of(plugin, "delete_archive", cmd_result(0, "5\n", "")).metadata.content).toContain("for b1");
  });

  it("refuses an unlisted archive", () => {
    const plugin = make(delete_config);
    listed(plugin, "b2");
    expect(refused_of(plugin, "delete_archive", { archive: "nope" }).success).toBe(false);
  });

  it("forgets the deleted archive's listings", () => {
    const plugin = make(delete_config);
    listed(plugin, "b2", "b1");
    outcome_of(plugin, "browse_archive", framed(cmd_result(0, listing, "")), { archive: "b1", path: "" });
    plugin.plan_action("delete_archive", { archive: "b1" });
    expect(plugin.listing("b1", "")).toBeNull();
  });
});

describe("live sequence", () => {
  function run(plugin: Borg, calls: string[], limit: number | null = null) {
    return sh(plugin.sequence_command(calls, { limits: limit ? { 0: limit } : null, live: true }));
  }

  it("splits each call back with its exit code", () => {
    const out = run(make(), ["sh -c 'echo first; echo oops >&2; exit 3'", "echo second"]);
    const [first, second] = split_poll(cmd_result(out.status ?? -1, out.stdout, out.stderr), 2);
    expect(first).toEqual(cmd_result(3, "first", "oops"));
    expect(second).toEqual(cmd_result(0, "second", ""));
  });

  it("prints stdout before the call ends", () => {
    const out = run(make(), ["sh -c 'echo first; echo oops >&2; exit 3'"]);
    expect(out.stdout.indexOf(frame_line(0, "out", "-"))).toBeLessThan(out.stdout.indexOf("first"));
    expect(out.stdout.indexOf("first")).toBeLessThan(out.stdout.indexOf(frame_line(0, "err", 3)));
  });

  it("cuts the lines at a limit without failing the call", () => {
    const out = run(make(), ["seq 1 5000"], 2);
    const [result] = split_poll(cmd_result(out.status ?? -1, out.stdout, out.stderr), 1);
    expect(result).toEqual(cmd_result(0, "1\n2", ""));
  });

  it("runs verify restore and diff live", () => {
    const plugin = make(canary_config);
    cycle_with(plugin);
    expect(plan_of(plugin, "verify_restore").command).toContain(frame_line(0, "out", "-"));
    listed(plugin, "b2", "b1");
    expect(plan_of(plugin, "diff_archive", { archive: "b2" }).command).toContain(frame_line(0, "out", "-"));
  });
});

describe("diff", () => {
  it("compares with the previous archive", () => {
    const plugin = make();
    listed(plugin, "b3", "b2", "b1");
    const command_text = plan_of(plugin, "diff_archive", { archive: "b2" }).command.replaceAll("'", "");
    expect(command_text).toContain("diff");
    expect(command_text).toContain("::b1 b2");
  });

  it("runs detached", () => {
    const plugin = make();
    listed(plugin, "b2", "b1");
    const plan = plan_of(plugin, "diff_archive", { archive: "b2" });
    expect(plan.detached).toBe(true);
    expect(plan.timeout).toBeNull();
  });

  it("has nothing to compare the oldest archive with", () => {
    const plugin = make();
    listed(plugin, "b2", "b1");
    expect(refused_of(plugin, "diff_archive", { archive: "b1" }).success).toBe(false);
  });

  it("shows the changes", () => {
    const plugin = make();
    listed(plugin, "b2", "b1");
    const outcome = outcome_of(plugin, "diff_archive", framed(cmd_result(0, "added       1.20 kB etc/new\nremoved     0 B etc/old", "")), { archive: "b2" });
    expect(outcome.metadata.content.startsWith("Changes from b1 to b2: 2")).toBe(true);
    expect(outcome.metadata.content).toContain("etc/new");
    expect(outcome.logs).toEqual([["Changes from b1 to b2: 2", "INFO"]]);
  });

  it("still counts the changes of a diff without its archive", () => {
    const plugin = make();
    listed(plugin, "b2", "b1");
    const outcome = outcome_of(plugin, "diff_archive", framed(cmd_result(0, "added       1.20 kB etc/new", "")));
    expect(outcome.logs).toEqual([["Changes in the archive: 1", "INFO"]]);
  });
});

describe("job preflight", () => {
  it("probes an ssh repo server's banner first", () => {
    const command_text = plan_of(make(backup_config), "run_backup").command;
    expect(command_text).toContain("/dev/tcp/host/22");
    expect(command_text.indexOf("/dev/tcp/host/22")).toBeLessThan(command_text.indexOf("setsid"));
  });

  it("probes the url's port", () => {
    expect(plan_of(make({ ...backup_config, repo: "ssh://borg@far.example:2222/srv/repo" }), "run_backup").command).toContain("/dev/tcp/far.example/2222");
  });

  it.each([[{ repo: "/srv/local" }], [{ skip_when_unreachable: false }]])("launches directly for %j", (config) => {
    expect(plan_of(make({ ...backup_config, ...config }), "run_backup").command).not.toContain("/dev/tcp");
  });

  it("tests for a running unit", () => {
    expect(plan_of(make({ ...backup_config, skip_while_active: ["borg-check.service"] }), "check_repo").command).toContain("systemctl is-active --quiet borg-check.service");
  });

  it("records no job for a skipped launch and does not fail", () => {
    const plugin = make(backup_config);
    plugin.plan_action("run_backup");
    const outcome = outcome_of(plugin, "run_backup", cmd_result(0, "__XMONITOR_SKIP__ host:22 is not answering SSH\n", ""));
    expect(outcome.success).toBe(true);
    expect(outcome.status).toBeNull();
    expect(plugin.jobs!.running()).toBeNull();
    expect(outcome.metadata.content).toBe("Backup skipped: host:22 is not answering SSH");
  });

  it("skips on a closed port and never launches", () => {
    const out = sh(with_preflight(preflight_script(["127.0.0.1", 1], []), "echo launched")).stdout;
    expect(out).not.toContain("launched");
    expect(skip_reason(out)).toBe("127.0.0.1:1 is not answering SSH");
  });

  it("launches when the unit is inactive", () => {
    expect(sh(with_preflight(preflight_script(null, ["x-monitor-no-such-unit.service"]), "echo launched")).stdout.trim()).toBe("launched");
  });

  it("does not probe a host the shell could misread", () => {
    expect(ssh_endpoint("ssh://borg@$(reboot)/srv")).toBeNull();
  });
});

const chain_config: PluginConfig = { ...backup_config, keep_daily: 7, prune_after_backup: true, compact_after_backup: true };

describe("backup chain", () => {
  it("backs up alone by default", () => {
    const command_text = plan_of(make({ ...backup_config, keep_daily: 7 }), "run_backup").command;
    expect(command_text).not.toContain(" prune ");
    expect(command_text).not.toContain(" compact ");
  });

  it("prunes then compacts after the create", () => {
    const command_text = unquoted(plan_of(make(chain_config), "run_backup"));
    expect(command_text.indexOf("create")).toBeLessThan(command_text.indexOf("prune --list --stats"));
    expect(command_text.indexOf("prune --list --stats")).toBeLessThan(command_text.indexOf("compact --progress"));
    expect(command_text).toContain("--keep-daily 7");
  });

  it("never prunes on a dry run", () => {
    const command_text = plan_of(make(chain_config), "dry_run_backup").command;
    expect(command_text).not.toContain(" prune ");
    expect(command_text).not.toContain(" compact ");
  });

  it("needs a retention policy to prune after a backup", () => {
    expect(() => make({ ...backup_config, prune_after_backup: true })).toThrow(/keep_/);
  });

  it.each([[0, true, 0], [1, true, 1], [2, false, 2]])("runs steps after exit %i only on success or a warning", (first, ran, status) => {
    const result = sh(then_steps(`(exit ${first})`, [["Pruning", "echo pruned"]]));
    expect(result.stdout.includes("pruned")).toBe(ran);
    expect(result.status).toBe(status);
  });

  it("fails the job and stops the rest on a failing step", () => {
    const result = sh(then_steps("true", [["Pruning", "(exit 2)"], ["Compacting", "echo compacted"]]));
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("compacted");
  });

  it("makes each step the progress", () => {
    expect(Borg.progress_from_lines(["==> Compacting"])).toBe("Compacting");
  });
});

describe("job wrappers", () => {
  it("wraps nothing by default", () => {
    const command_text = plan_of(make(backup_config), "run_backup").command;
    for (const part of ["nice", "flock", "systemd-inhibit"]) expect(command_text).not.toContain(part);
  });

  it("wraps the whole job in the lock, then the inhibitor, then the priority", () => {
    const command_text = unquoted(plan_of(make({ ...chain_config, job_lock: "/run/lock/x-monitor-borg", inhibit_sleep: true, job_nice: 19, job_io_idle: true }), "run_backup"));
    const order = ["flock /run/lock/x-monitor-borg systemd-inhibit", "--what=sleep:shutdown", "nice -n 19 ionice -c 3 sh -c", "create", "compact --progress"];
    const positions = order.map((part) => command_text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("never wraps a poll", () => {
    const plugin = make({ ...backup_config, job_nice: 19, job_lock: "/run/lock/x" });
    plugin.commands();
    expect(plugin.poll_command_text()).not.toContain("nice");
    expect(plugin.poll_command_text()).not.toContain("flock");
  });

  it("keeps the wrapped job's exit status", () => {
    if (sh("command -v flock").status !== 0) return;
    const lock = join(temp_dir(), "job.lock");
    const result = sh(wrap_job("echo ran; (exit 3)", ["flock", lock, "nice", "-n", "19"], lock));
    expect(result.stdout.trim()).toBe("ran");
    expect(result.status).toBe(3);
  });
});

const tracked_config: PluginConfig = { ...base_config, repo: "/srv/local", collect_stats: false, check_kinds: { repository: "8d", extract: "32d" } };

function finish_job(plugin: Borg, action_id: string, exit_code: number, args: Record<string, unknown> = {}): void {
  plugin.plan_action(action_id, args);
  apply(plugin, outcome_of(plugin, action_id, cmd_result(0, "91\n", ""), args));
  poll_once(plugin, poll(5, exit_code, false, ""));
}

describe("check kinds", () => {
  it.each([
    ["repository", "--repository-only", "check-repository"],
    ["archives", "--archives-only", "check-archives"],
    ["data", "--verify-data", "check-data"],
  ])("runs a %s check of its own", (kind, option, job) => {
    const plugin = make();
    expect(plan_of(plugin, "check_repo", { kind }).command).toContain(option);
    apply(plugin, outcome_of(plugin, "check_repo", cmd_result(0, "91\n", "")));
    expect(plugin.jobs!.running()!.kind).toBe(job);
  });

  it("dry-runs an extract of the newest archive", () => {
    const plugin = make();
    listed(plugin, "b2", "b1");
    const command_text = unquoted(plan_of(plugin, "check_repo", { kind: "extract" }));
    expect(command_text).toContain("extract --dry-run");
    expect(command_text).toContain("::b2");
  });

  it("needs a listed archive for an extract check", () => {
    expect(refused_of(make(), "check_repo", { kind: "extract" }).success).toBe(false);
  });

  it("refuses an unknown kind", () => {
    expect(refused_of(make(), "check_repo", { kind: "everything" }).success).toBe(false);
  });

  it("calls an unknown tracked kind a config error", () => {
    expect(() => make({ ...base_config, check_kinds: { weekly: "8d" } })).toThrow(/check_kinds/);
  });

  it("renews what a finished check covered", () => {
    const plugin = make({ ...tracked_config, check_kinds: { repository: "8d" } });
    finish_job(plugin, "check_repo", 0, { kind: "data" });
    expect(latest_metric(plugin, "checks_ok")).toBe(1.0);
    plugin.commands();
    cycle_with(plugin);
    expect(latest_status(plugin)).toBe("online");
  });

  it("waits one max age for a kind never run", () => {
    const plugin = make(tracked_config);
    finish_job(plugin, "check_repo", 0, { kind: "repository" });
    plugin.commands();
    cycle_with(plugin);
    expect(latest_metric(plugin, "checks_ok")).toBe(1.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a kind never run once its max age has passed", () => {
    const plugin = make(tracked_config);
    finish_job(plugin, "check_repo", 0, { kind: "repository" });
    plugin.commands();
    cycle_with(plugin);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 33 * 86400 * 1000);
    finish_job(plugin, "check_repo", 0, { kind: "repository" });
    plugin.commands();
    cycle_with(plugin);
    expect(latest_metric(plugin, "checks_ok")).toBe(0.0);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("reads a kind never run as pending", () => {
    const plugin = make({ ...tracked_config, check_kinds: { extract: "32d" } });
    plugin.commands();
    cycle_with(plugin);
    expect(plugin.checks_pair()).toEqual(["Pending", "unavailable"]);
  });

  it("fails a failed check until one succeeds", () => {
    const plugin = make({ ...tracked_config, check_kinds: { repository: "8d" } });
    finish_job(plugin, "check_repo", 2, { kind: "repository" });
    plugin.commands();
    cycle_with(plugin);
    expect(latest_status(plugin)).toBe("failed");
    finish_job(plugin, "check_repo", 0, { kind: "repository" });
    plugin.commands();
    cycle_with(plugin);
    expect(latest_status(plugin)).toBe("online");
  });

  it("judges units and kinds together", () => {
    const plugin = make({ ...check_config, check_kinds: { extract: "32d" } });
    plugin.commands();
    cycle_with(plugin, { checks: checks_out({ ok: now() - 3600 }) });
    finish_job(plugin, "check_repo", 2, { kind: "extract" });
    plugin.commands();
    cycle_with(plugin, { checks: checks_out({ ok: now() - 3600 }) });
    expect(latest_status(plugin)).toBe("failed");
    finish_job(plugin, "check_repo", 0, { kind: "extract" });
    plugin.commands();
    cycle_with(plugin, { checks: checks_out({ ok: now() - 3600 }) });
    expect(latest_status(plugin)).toBe("online");
  });
});
