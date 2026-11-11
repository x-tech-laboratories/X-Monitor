import { describe, expect, it } from "vitest";

import { cmd_result, type CmdResult, type CollectResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { NixGc } from "../../src/monitors/nix_gc.ts";
import { make_plugin, store_of } from "../harness.ts";

const base_config: PluginConfig = { name: "test-nix-gc", id: "test-nix-gc", interval: 3600, ssh_config: { host: "test.host" } };

const GB = 1024 ** 3;

const latest_status = (plugin: NixGc) => store_of(plugin).store.statuses.get("test-nix-gc")?.state ?? null;
const latest_metric = (plugin: NixGc, name: string) => store_of(plugin).latest_metric("test-nix-gc", name)?.value ?? null;

const now_epoch = () => Math.trunc(Date.now() / 1000);

// The two lines systemd logs when a run ends, as journalctl -o short-unix renders them.
const outcomes: Record<string, string> = {
  finished: "systemd[1]: Finished Nix Garbage Collector.",
  failed: "systemd[1]: nix-gc.service: Failed with result 'exit-code'.",
};

type Profile = [path: string, generation: number, count: number, oldest: number | null];

interface ProbeOptions {
  size?: number;
  used?: number;
  paths?: number;
  roots?: number;
  svc_state?: string;
  svc_result?: string;
  svc_exit?: string;
  timer_load?: string;
  timer_state?: string;
  timer_next?: number | null;
  last_gc?: number | null;
  freed?: string | null;
  deleted?: number;
  outcome?: string | null;
  summary_at?: number | null;
  error?: string | null;
  error_at?: number | null;
  profiles?: Profile[];
}

// The stdout the probe script produces on a NixOS target.
function probe(options: ProbeOptions = {}): CmdResult {
  const now = now_epoch();
  const size = options.size ?? 200 * GB;
  const used = options.used ?? 80 * GB;
  const last_gc = options.last_gc ?? now - 86400;
  const timer_next = options.timer_next ?? now + 3 * 86400;
  const summary_at = options.summary_at ?? last_gc;
  const error_at = options.error_at ?? last_gc;
  const freed = options.freed === undefined ? "44.4 GiB" : options.freed;
  const outcome = options.outcome === undefined ? "finished" : options.outcome;
  const deleted = options.deleted ?? 21482;
  const summary = freed ? `${summary_at}.204758 host nix-gc-start[2166397]: ${deleted} store paths deleted, ${freed} freed` : "";
  const lines = [
    "hostname=host",
    `df=${size} ${used} ${size - used} /nix/store`,
    `paths=${options.paths ?? 111121}`,
    `roots=${options.roots ?? 118}`,
    `svc_state=${options.svc_state ?? "inactive"}`,
    `svc_result=${options.svc_result ?? "success"}`,
    `svc_exit=${options.svc_exit ?? ""}`,
    `timer_load=${options.timer_load ?? "loaded"}`,
    `timer_state=${options.timer_state ?? "active"}`,
    timer_next ? `timer_next=@${timer_next}` : "timer_next=",
    `summary=${summary}`,
    outcome ? `outcome=${last_gc}.225681 host ${outcomes[outcome]}` : "outcome=",
    options.error ? `error=${error_at}.100000 host nix-gc-start[2166397]: ${options.error}` : "error=",
  ];
  for (const [path, generation, count, oldest] of options.profiles ?? [["/nix/var/nix/profiles/system", 236, 59, null]]) {
    lines.push(`profile=${path}|${generation}|${count}|${oldest ?? now - 30 * 86400}`);
  }
  return cmd_result(0, lines.join("\n") + "\n", "");
}

function plugin_of(extra: PluginConfig = {}): NixGc {
  return make_plugin(NixGc, { ...base_config, ...extra });
}

// Drives one cycle over a probe result and persists what it produced.
function collect(plugin: NixGc, result: CmdResult = probe()): CollectResult {
  plugin.commands();
  const outcome = plugin.parse([result]);
  store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, outcome);
  return outcome;
}

function state(plugin: NixGc): Record<string, unknown> {
  return JSON.parse(plugin.data.latest_metric("last_gc_epoch")!.metadata!) as Record<string, unknown>;
}

describe("freshness", () => {
  it("calls a recent collection online", () => {
    const plugin = plugin_of();
    collect(plugin);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "last_gc_success")).toBe(1.0);
  });

  it("fails a collection older than max_age", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ last_gc: now_epoch() - 21 * 86400 }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("takes the stale status from config", () => {
    const plugin = plugin_of({ stale_status: "warning" });
    collect(plugin, probe({ last_gc: now_epoch() - 21 * 86400 }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("falls back to failed for an unrecognised stale status", () => {
    expect(plugin_of({ stale_status: "catastrophe" }).stale_status).toBe("failed");
  });

  it("takes max_age from config", () => {
    const plugin = plugin_of({ max_age: "1d" });
    collect(plugin, probe({ last_gc: now_epoch() - 2 * 86400 }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("never calls a running collection stale", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ last_gc: now_epoch() - 21 * 86400, svc_state: "active" }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a failed last run", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ outcome: "failed" }));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "last_gc_success")).toBe(0.0);
  });

  it("lets a journal failure beat a reset unit result", () => {
    const plugin = plugin_of();
    const result = collect(plugin, probe({ outcome: "failed", svc_result: "success" }));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs.some(([message]) => message.includes("result success"))).toBe(false);
  });

  it("does not fail a finished run on a stale unit result", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ outcome: "finished", svc_result: "exit-code" }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("reports a failure with the journal's reason", () => {
    const result = collect(plugin_of(), probe({ outcome: "failed", error: "error: interrupted by the user" }));
    expect(result.logs.find(([, level]) => level === "ERROR")![0]).toBe("The last collection failed: error: interrupted by the user");
  });

  it("does not take an earlier run's error as this run's reason", () => {
    const result = collect(plugin_of(), probe({ outcome: "failed", error: "error: out of disk", error_at: now_epoch() - 30 * 86400 }));
    expect(result.logs.find(([, level]) => level === "ERROR")![0]).toBe("The last collection failed");
  });

  it("reports no reason for a succeeded run", () => {
    const plugin = plugin_of();
    const result = collect(plugin, probe({ error: "error: interrupted by the user" }));
    expect(latest_status(plugin)).toBe("online");
    expect(result.logs.some(([, level]) => level === "ERROR")).toBe(false);
  });

  it("lets the unit result decide when the journal has no outcome", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ outcome: null, svc_result: "exit-code" }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls no record of any run unavailable", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ freed: null, outcome: null }));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "last_gc_epoch")).toBe(0.0);
  });
});

describe("yield", () => {
  it("records what the summary line says was freed", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ freed: "44.4 GiB", deleted: 21482 }));
    expect(latest_metric(plugin, "last_gc_freed_gb")).toBeCloseTo(44.4);
    expect(latest_metric(plugin, "last_gc_deleted")).toBe(21482.0);
  });

  it.each([
    ["512.0 MiB", 0.5],
    ["2.0 TiB", 2048.0],
    ["100 bytes", 100 / GB],
  ])("understands %s", (rendered, gb) => {
    const plugin = plugin_of();
    collect(plugin, probe({ freed: rendered }));
    expect(latest_metric(plugin, "last_gc_freed_gb")).toBeCloseTo(gb, 9);
  });

  it("records no yield for an unparseable unit", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ freed: "44.4 parsecs" }));
    expect(latest_metric(plugin, "last_gc_freed_gb")).toBeNull();
    expect(latest_status(plugin)).toBe("online");
  });

  it("keeps the last known run when the journal rotates", () => {
    const plugin = plugin_of();
    const stamp = now_epoch() - 86400;
    collect(plugin, probe({ last_gc: stamp }));
    collect(plugin, probe({ freed: null, outcome: null }));
    expect(latest_metric(plugin, "last_gc_epoch")).toBe(stamp);
    expect(latest_metric(plugin, "last_gc_freed_gb")).toBeCloseTo(44.4);
    expect(latest_status(plugin)).toBe("online");
  });

  it("keeps the yield a failed run managed", () => {
    const plugin = plugin_of();
    const stamp = now_epoch() - 3600;
    collect(plugin, probe({ outcome: "failed", last_gc: stamp, summary_at: stamp - 1, freed: "2.8 GiB", deleted: 2048 }));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "last_gc_freed_gb")).toBeCloseTo(2.8);
    expect(latest_metric(plugin, "last_gc_deleted")).toBe(2048.0);
  });

  it("does not take an older run's summary as this run's yield", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ summary_at: now_epoch() - 30 * 86400 }));
    expect(latest_metric(plugin, "last_gc_freed_gb")).toBeNull();
  });

  it("clears the old yield on a newer run without a summary", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ last_gc: now_epoch() - 86400 }));
    collect(plugin, probe({ last_gc: now_epoch() - 60, freed: null }));
    expect(state(plugin).freed_bytes).toBeNull();
  });
});

describe("schedule", () => {
  it("warns on an inactive timer", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ timer_state: "inactive" }));
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "timer_active")).toBe(0.0);
  });

  it("says so when the timer is missing", () => {
    const result = collect(plugin_of(), probe({ timer_load: "not-found", timer_state: "inactive" }));
    expect(result.logs.some(([message]) => message.includes("not installed"))).toBe(true);
  });

  it("takes the timer status from config", () => {
    const plugin = plugin_of({ timer_status: "failed" });
    collect(plugin, probe({ timer_state: "inactive" }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("records the next elapse", () => {
    const plugin = plugin_of();
    const due = now_epoch() + 3 * 86400;
    collect(plugin, probe({ timer_next: due }));
    expect(latest_metric(plugin, "next_gc_epoch")).toBe(due);
  });
});

describe("store", () => {
  it("measures usage from df", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ size: 200 * GB, used: 100 * GB }));
    expect(latest_metric(plugin, "store_used_pct")).toBeCloseTo(50.0);
    expect(latest_metric(plugin, "store_size_gb")).toBeCloseTo(200.0);
    expect(latest_metric(plugin, "store_avail_gb")).toBeCloseTo(100.0);
    expect(latest_metric(plugin, "store_paths")).toBe(111121.0);
    expect(latest_metric(plugin, "gc_roots")).toBe(118.0);
  });

  it("warns past the warning", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ size: 100 * GB, used: 85 * GB }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails past the threshold", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ size: 100 * GB, used: 95 * GB }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls an unreadable store unavailable", () => {
    const plugin = plugin_of();
    collect(plugin, cmd_result(0, "hostname=host\ndf=\n", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable target unavailable", () => {
    const plugin = plugin_of();
    collect(plugin, cmd_result(255, "", "ssh: connect failed"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls no probe result unavailable", () => {
    const plugin = plugin_of();
    plugin.commands();
    store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, plugin.parse([]));
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("profiles", () => {
  const profiles: Profile[] = [
    ["/nix/var/nix/profiles/system", 236, 59, null],
    ["/nix/var/nix/profiles/per-user/root/profile", 29, 11, null],
  ];

  it("counts generations across profiles", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ profiles }));
    expect(latest_metric(plugin, "profiles")).toBe(2.0);
    expect(latest_metric(plugin, "generations")).toBe(70.0);
  });

  it("takes the oldest generation of any profile", () => {
    const plugin = plugin_of();
    const old = now_epoch() - 90 * 86400;
    collect(plugin, probe({ profiles: [["/nix/var/nix/profiles/system", 236, 59, old], ["/nix/var/nix/profiles/per-user/root/profile", 29, 11, old + 86400]] }));
    expect(latest_metric(plugin, "oldest_generation_epoch")).toBe(old);
  });

  it("warns on a generation older than the limit", () => {
    const plugin = plugin_of({ max_generation_age: "7d" });
    collect(plugin, probe({ profiles: [["/nix/var/nix/profiles/system", 236, 59, now_epoch() - 30 * 86400]] }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("warns on too many generations", () => {
    const plugin = plugin_of({ max_generations: 20 });
    const result = collect(plugin, probe({ profiles }));
    expect(latest_status(plugin)).toBe("warning");
    expect(result.logs.some(([message]) => message.includes("59"))).toBe(true);
  });

  it("renders profile rows", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ profiles }));
    const rows = plugin.profile_rows;
    expect(rows.map((row) => row.path)).toEqual(profiles.map(([path]) => path));
    expect(rows[0].generation).toBe("236");
    expect(rows[0].count).toBe("59");
  });
});

describe("read only", () => {
  it("offers no actions", () => {
    const plugin = plugin_of();
    expect(plugin.get_actions()).toEqual([]);
    expect(plugin.plan_action("collect")).toBeNull();
  });

  it("ignores the removed collection keys", () => {
    const commands = plugin_of({ gc_bin: "nix-collect-garbage", gc_args: ["-d"], require_sudo: false }).commands();
    expect(commands).toHaveLength(1);
    expect(commands[0].text).not.toContain("nix-collect-garbage");
  });
});

describe("page", () => {
  it("titles the profiles table", () => {
    expect((plugin_of().UI_SPEC.tables!.profiles as { title?: string }).title).toBe("Profiles");
  });

  it("shows no job panel", () => {
    expect(plugin_of().UI_SPEC.job_panel).toBeUndefined();
  });

  it("defines every laid-out widget", () => {
    const spec = plugin_of().UI_SPEC;
    const defined = new Set([...Object.keys(spec.cards!), ...Object.keys(spec.tables!), "host_card", "chart", "events"]);
    const laid_out = spec.layout!.flat() as string[];
    expect(laid_out.filter((cell) => !defined.has(cell))).toEqual([]);
  });

  it("lays out every defined widget", () => {
    const spec = plugin_of().UI_SPEC;
    const laid_out = new Set(spec.layout!.flat() as string[]);
    expect([...Object.keys(spec.cards!), ...Object.keys(spec.tables!)].filter((name) => !laid_out.has(name))).toEqual([]);
  });

  it("binds only metrics the plugin records", () => {
    const plugin = plugin_of();
    collect(plugin);
    const recorded = new Set(Object.keys(collect(plugin).metrics));
    const bound = Object.values(plugin.UI_SPEC.cards!).filter((card) => card.metric).map((card) => card.metric!);
    bound.push(plugin.UI_SPEC.chart!.metric!);
    expect(bound.filter((metric) => !recorded.has(metric))).toEqual([]);
  });

  it("draws store use as a gauge colored by the thresholds", () => {
    const plugin = plugin_of();
    const store = plugin.UI_SPEC.cards!.store_card;
    expect(store.kind).toBe("gauge");
    expect(store.metric).toBe("store_used_pct");
    expect(store.color).toEqual({ warning: plugin.warning, threshold: plugin.threshold });
  });

  it("reads the last yield card from the stored record", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ freed: "512.0 MiB", deleted: 99 }));
    expect(plugin.freed_text).toBe("512 MB · 99 paths");
  });

  it("shows an unscheduled timer on the next collection card", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ timer_state: "inactive" }));
    expect(plugin.next_gc_text).toBe("NOT SCHEDULED");
    expect(plugin.next_gc_color).toBe("warning");
  });

  it("colors a stale collection's card", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ last_gc: now_epoch() - 21 * 86400 }));
    expect(plugin.last_gc_color).toBe("failed");
  });
});

describe("newer record wins", () => {
  it("does not roll the journal back to an older run", () => {
    const plugin = plugin_of();
    collect(plugin, probe({ last_gc: now_epoch() - 3600, freed: "3.3 GiB", deleted: 7529 }));
    collect(plugin, probe({ last_gc: now_epoch() - 16 * 86400, freed: "359.3 MiB", deleted: 101 }));
    expect(state(plugin).deleted).toBe(7529);
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("optional store limits", () => {
  it("never fails with a warning only", () => {
    const plugin = plugin_of({ threshold: null });
    collect(plugin, probe({ size: 100 * GB, used: 100 * GB }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = plugin_of({ warning: null });
    collect(plugin, probe({ size: 100 * GB, used: 89 * GB }));
    expect(latest_status(plugin)).toBe("online");
    collect(plugin, probe({ size: 100 * GB, used: 95 * GB }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("colors the gauge by the limits that are on", () => {
    expect(plugin_of({ warning: null }).UI_SPEC.cards!.store_card.color).toEqual({ warning: null, threshold: 90 });
  });
});
