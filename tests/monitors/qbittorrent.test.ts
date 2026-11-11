import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { cmd_result, type ActionPlan, type CollectResult } from "../../src/core/connectors/types.ts";
import { shell_quote } from "../../src/core/shell.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { AUTH_FAILED, build_action_script, build_fetch_script, format_rate, parse_response, Qbittorrent, SCRIPT_SEP } from "../../src/monitors/qbittorrent.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-qbittorrent",
  id: "test-qbittorrent",
  api_url: "http://127.0.0.1:9050",
  stalled_warning: 3,
  stalled_threshold: 10,
  error_threshold: 1,
  min_downloading: 1,
  ssh_config: { host: "test.host" },
};

function transfer({ connection = "connected", dl_speed = 1_500_000, up_speed = 250_000 } = {}) {
  return { connection_status: connection, dl_info_speed: dl_speed, dl_info_data: 91_000_000_000, up_info_speed: up_speed, up_info_data: 44_000_000_000, dht_nodes: 342 };
}

function torrents({ downloading = 2, stalled = 0, errored = 0, seeding = 5 } = {}): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < downloading; index++) out.push({ name: `dl-${index}`, state: "downloading", progress: 0.4 });
  for (let index = 0; index < stalled; index++) out.push({ name: `stalled-${index}`, state: "stalledDL", progress: 0.1 });
  for (let index = 0; index < errored; index++) out.push({ name: `err-${index}`, state: "error", progress: 0.9 });
  for (let index = 0; index < seeding; index++) out.push({ name: `seed-${index}`, state: "uploading", progress: 1.0 });
  return out;
}

function response(transfer_info: unknown = transfer(), torrent_list: unknown = torrents()): string {
  return `${JSON.stringify(transfer_info)}\n${SCRIPT_SEP}\n${JSON.stringify(torrent_list)}`;
}

function qbittorrent(extra: PluginConfig = {}): Qbittorrent {
  return make_plugin(Qbittorrent, { ...base_config, ...extra });
}

function respond(plugin: Qbittorrent, transfer_info?: unknown, torrent_list?: unknown): CollectResult {
  return run_cycle(plugin, () => cmd_result(0, response(transfer_info, torrent_list), ""));
}

const latest_status = (plugin: Qbittorrent) => store_of(plugin).store.statuses.get("test-qbittorrent")?.state ?? null;
const latest_metric = (plugin: Qbittorrent, name: string) => store_of(plugin).latest_metric("test-qbittorrent", name)?.value ?? null;

describe("format rate", () => {
  it("writes bytes", () => expect(format_rate(512)).toBe("512 B/s"));
  it("writes KiB", () => expect(format_rate(2048)).toBe("2.0 KiB/s"));
  it("writes MiB", () => expect(format_rate(1_500_000)).toBe("1.4 MiB/s"));
  it("writes zero", () => expect(format_rate(0)).toBe("0 B/s"));
});

describe("fetch script", () => {
  it("leaves out the login without auth", () => {
    const script = build_fetch_script("http://127.0.0.1:9050", 10, null, null, null);
    expect(script).not.toContain("auth/login");
    expect(script).toContain("/api/v2/transfer/info");
    expect(script).toContain("/api/v2/torrents/info");
    expect(script).toContain(SCRIPT_SEP);
  });

  it("runs the password command on the remote host", () => {
    const script = build_fetch_script("http://127.0.0.1:9050", 10, "cat /run/secrets/qbittorrent_api", "admin", null);
    expect(script).toContain("cat /run/secrets/qbittorrent_api");
    expect(script).toContain("auth/login");
  });

  it("quotes an inline password", () => {
    const script = build_fetch_script("http://127.0.0.1:9050", 10, null, "admin", "p'wd$(x)");
    const assign = script.split("\n")[1];
    expect(assign.startsWith("__pw=")).toBe(true);
    const out = spawnSync("bash", ["-c", `${assign}\nprintf "%s" "$__pw"`], { encoding: "utf8" });
    expect(out.stdout).toBe("p'wd$(x)");
    expect(script).toContain("auth/login");
  });

  it("skips auth for a username without a password", () => {
    expect(build_fetch_script("http://127.0.0.1:9050", 10, null, "admin", null)).not.toContain("auth/login");
  });

  it("skips auth for a password without a username", () => {
    expect(build_fetch_script("http://127.0.0.1:9050", 10, null, null, "pw")).not.toContain("auth/login");
  });

  it("does not double a trailing slash", () => {
    expect(build_fetch_script("http://127.0.0.1:9050/", 10, null, null, null)).not.toContain("//api/v2");
  });

  it("detects a login failure", () => {
    const script = build_fetch_script("http://127.0.0.1:9050", 10, null, "admin", "pw");
    expect(script).toContain(AUTH_FAILED);
    expect(script).toContain("Ok.");
  });

  it("cleans up the cookie jar", () => {
    const script = build_fetch_script("http://127.0.0.1:9050", 10, null, "admin", "pw");
    expect(script).toContain("mktemp");
    expect(script).toContain('rm -f "$__jar"');
  });

  it("prefers the password command over an inline password", () => {
    const script = build_fetch_script("http://127.0.0.1:9050", 10, "cat /run/secrets/qb", "admin", "inline-pw");
    expect(script).toContain("cat /run/secrets/qb");
    expect(script).not.toContain("inline-pw");
  });

  it("writes the logout trap as the Python app did", () => {
    const script = build_fetch_script("http://127.0.0.1:9050", 10, null, "admin", "pw");
    expect(script.split("\n")[3]).toBe(`trap 'curl -s -m 10 -b "$__jar" -H "Referer: http://127.0.0.1:9050" --data "" "http://127.0.0.1:9050/api/v2/auth/logout" >/dev/null 2>&1; rm -f "$__jar"' EXIT INT TERM`);
  });
});

describe("auth script behaviour", () => {
  function run(script: string, curl_body: string) {
    const stub = `curl() { printf '%s' ${shell_quote(curl_body)}; }\n${script}`;
    return spawnSync("bash", ["-c", stub], { encoding: "utf8" });
  }

  it("exits non-zero on a rejected login", () => {
    const out = run(build_fetch_script("http://127.0.0.1:9050", 10, null, "admin", "wrong"), "Fails.");
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(AUTH_FAILED);
  });

  it("proceeds on an accepted login", () => {
    const out = run(build_fetch_script("http://127.0.0.1:9050", 10, null, "admin", "right"), "Ok.");
    expect(out.status).toBe(0);
    expect(out.stderr).not.toContain(AUTH_FAILED);
  });

  it("runs clean without auth", () => {
    expect(run(build_fetch_script("http://127.0.0.1:9050", 10, null, null, null), "{}").status).toBe(0);
  });
});

describe("action script", () => {
  it("sends a Referer header", () => {
    expect(build_action_script("http://127.0.0.1:9050", 10, null, null, null, "/api/v2/torrents/start", { hashes: "all" })).toContain("Referer: http://127.0.0.1:9050");
  });

  it("uses curl's fail flag", () => {
    const script = build_action_script("http://127.0.0.1:9050", 10, null, null, null, "/api/v2/torrents/start", { hashes: "all" });
    const action_line = script.split("\n").at(-1)!;
    expect(action_line).toContain("/api/v2/torrents/start");
    expect(action_line).toContain(" -f ");
  });

  it("encodes params", () => {
    expect(build_action_script("http://127.0.0.1:9050", 10, null, null, null, "/api/v2/torrents/recheck", { hashes: "abc|def" })).toContain("hashes=abc|def");
  });

  it("authenticates when configured", () => {
    const script = build_action_script("http://127.0.0.1:9050", 10, "cat /run/secrets/qb", "admin", null, "/api/v2/torrents/start", { hashes: "all" });
    expect(script).toContain("auth/login");
    expect(script).toContain("cat /run/secrets/qb");
  });
});

describe("parse response", () => {
  it("parses both payloads", () => {
    const [transfer_info, torrent_list] = parse_response(response());
    expect(transfer_info.connection_status).toBe("connected");
    expect(torrent_list).toHaveLength(7);
  });

  it("throws without the separator", () => {
    expect(() => parse_response('{"connection_status": "connected"}')).toThrow("unexpected API response");
  });

  it("gives an actionable message for Forbidden", () => {
    expect(() => parse_response(`Forbidden\n${SCRIPT_SEP}\nForbidden`)).toThrow("Forbidden");
  });

  it("throws on malformed transfer JSON", () => {
    expect(() => parse_response(`not json\n${SCRIPT_SEP}\n[]`)).toThrow("transfer info was not JSON");
  });

  it("throws on malformed torrents JSON", () => {
    expect(() => parse_response(`{"connection_status": "connected"}\n${SCRIPT_SEP}\nnot json`)).toThrow("torrent list was not JSON");
  });

  it("throws when the transfer info lacks connection_status", () => {
    expect(() => parse_response(`{"dl_info_speed": 0}\n${SCRIPT_SEP}\n[]`)).toThrow("missing 'connection_status'");
  });

  it("throws when the torrents are not a list", () => {
    expect(() => parse_response(`{"connection_status": "connected"}\n${SCRIPT_SEP}\n{}`)).toThrow("was not a list");
  });
});

describe("collect", () => {
  it("calls a healthy client online", () => {
    const plugin = qbittorrent();
    respond(plugin);
    expect(latest_status(plugin)).toBe("online");
  });

  it("records metrics", () => {
    const plugin = qbittorrent();
    respond(plugin);
    expect(latest_metric(plugin, "dl_speed_bytes")).toBe(1_500_000);
    expect(latest_metric(plugin, "up_speed_bytes")).toBe(250_000);
    expect(latest_metric(plugin, "torrents_total")).toBe(7);
    expect(latest_metric(plugin, "torrents_downloading")).toBe(2);
    expect(latest_metric(plugin, "torrents_stalled")).toBe(0);
    expect(latest_metric(plugin, "torrents_errored")).toBe(0);
    expect(latest_metric(plugin, "connected")).toBe(1.0);
  });

  it("calls an API failure unavailable", () => {
    const plugin = qbittorrent();
    run_cycle(plugin, () => cmd_result(1, "", "connection refused"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = qbittorrent();
    run_cycle(plugin, () => cmd_result(-1, "", "not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unparseable response unavailable", () => {
    const plugin = qbittorrent();
    run_cycle(plugin, () => cmd_result(0, "garbage", ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("fails a disconnected client", () => {
    const plugin = qbittorrent();
    respond(plugin, transfer({ connection: "disconnected", dl_speed: 0, up_speed: 0 }));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "connected")).toBe(0.0);
  });

  it("warns on a firewalled client", () => {
    const plugin = qbittorrent();
    respond(plugin, transfer({ connection: "firewalled" }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("ignores a firewalled client when that warning is off", () => {
    const plugin = qbittorrent({ firewalled_warning: false });
    respond(plugin, transfer({ connection: "firewalled" }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("warns on stalls at the warning", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, torrents({ downloading: 1, stalled: 3 }));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails on stalls at the threshold", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, torrents({ downloading: 1, stalled: 10 }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("stays online with few stalls", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, torrents({ downloading: 4, stalled: 2 }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails an errored torrent", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, torrents({ downloading: 1, errored: 1 }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls an idle client with no downloads online", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, torrents({ downloading: 0, stalled: 0, seeding: 8 }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls an empty torrent list online", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, []);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "torrents_total")).toBe(0);
  });

  it("does not crash on a torrent without a state", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, [{ name: "partial" }]);
    expect(latest_status(plugin)).toBe("online");
  });

  it("lets the worst condition win", () => {
    const plugin = qbittorrent();
    respond(plugin, transfer({ connection: "firewalled" }), torrents({ downloading: 1, errored: 1 }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("counts a metadata stall as stalled", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, Array.from({ length: 10 }, (_, index) => ({ name: `meta-${index}`, state: "metaDL" })));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("counts each torrent in exactly one state bucket", () => {
    const plugin = qbittorrent();
    const states = ["downloading", "forcedDL", "queuedDL", "uploading", "stalledUP", "queuedUP", "pausedDL", "stoppedUP", "stalledDL", "metaDL", "error", "missingFiles"];
    respond(plugin, undefined, states.map((state) => ({ name: state, state })));
    const counts = Object.fromEntries(["downloading", "seeding", "paused", "stalled", "errored"].map((bucket) => [bucket, latest_metric(plugin, `torrents_state_${bucket}`)]));
    expect(counts).toEqual({ downloading: 3, seeding: 2, paused: 2, stalled: 3, errored: 2 });
    expect(Object.values(counts).reduce((sum, value) => sum! + value!, 0)).toBe(latest_metric(plugin, "torrents_total"));
  });

  it("counts an unlisted state as stalled", () => {
    const plugin = qbittorrent();
    respond(plugin, undefined, [{ name: "partial" }, { name: "m", state: "moving" }]);
    expect(latest_metric(plugin, "torrents_state_stalled")).toBe(2);
  });

  it("reports an auth failure distinctly", () => {
    const plugin = qbittorrent();
    const result = run_cycle(plugin, () => cmd_result(1, "", `${AUTH_FAILED}: Fails.`));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(result.logs[0][0]).toContain("rejected the configured credentials");
    expect(result.logs[0][1]).toBe("ERROR");
  });
});

describe("actions", () => {
  it("offers the expected actions", () => {
    expect(new Set(qbittorrent().get_actions().map((action) => action.action_id))).toEqual(new Set(["resume_all", "recheck_errored", "pause_all"]));
  });

  it("offers no destructive action", () => {
    const blob = JSON.stringify(qbittorrent().get_actions()).toLowerCase();
    expect(blob).not.toContain("delete");
    expect(blob).not.toContain("remove");
  });

  it("marks pause as danger", () => {
    expect(qbittorrent().get_actions().find((action) => action.action_id === "pause_all")!.variant).toBe("danger");
  });

  it("handles no unknown action", () => {
    expect(qbittorrent().plan_action("nope")).toBeNull();
  });

  it("resumes through the modern endpoint with a legacy fallback", () => {
    const plugin = qbittorrent();
    const plan = plugin.plan_action("resume_all") as ActionPlan;
    expect(plan.command).toContain("/api/v2/torrents/start");
    expect(plan.command).toContain("/api/v2/torrents/resume");
    expect(plan.command).toContain("hashes=all");
    expect((plugin.interpret_action("resume_all", cmd_result(0, "", "")) as CollectResult).success).toBe(true);
  });

  it("fails resume when both endpoints fail", () => {
    expect((qbittorrent().interpret_action("resume_all", cmd_result(22, "", "403")) as CollectResult).success).toBe(false);
  });

  it("pauses through the modern endpoint", () => {
    const plugin = qbittorrent();
    expect((plugin.plan_action("pause_all") as ActionPlan).command).toContain("/api/v2/torrents/stop");
    expect((plugin.interpret_action("pause_all", cmd_result(0, "", "")) as CollectResult).success).toBe(true);
  });

  it("rechecks only errored torrents", () => {
    const plan = qbittorrent().plan_action("recheck_errored") as ActionPlan;
    expect(plan.command).toContain("torrents/info");
    expect(plan.command).toContain("torrents/recheck");
    expect(plan.command).toContain("print('|'.join(t['hash'] for t in data if t.get('state') in states and t.get('hash')))\" error missingFiles)");
  });

  it("succeeds with no errored torrents to recheck", () => {
    expect((qbittorrent().interpret_action("recheck_errored", cmd_result(0, "HASHES:", "")) as CollectResult).success).toBe(true);
  });

  it("fails a recheck when the queue is unreadable", () => {
    expect((qbittorrent().interpret_action("recheck_errored", cmd_result(1, "", "boom")) as CollectResult).success).toBe(false);
  });

  it("reports the recheck count from the hashes line", () => {
    const outcome = qbittorrent().interpret_action("recheck_errored", cmd_result(0, "HASHES:bbb|ccc", "")) as CollectResult;
    expect(outcome.success).toBe(true);
    expect(outcome.logs.some(([message]) => message.includes("2"))).toBe(true);
  });
});

describe("page", () => {
  it("shares one mirror chart for download and upload", () => {
    const chart = qbittorrent().UI_SPEC.chart!;
    expect(chart.style).toBe("mirror");
    expect(chart.series!.map((series) => series.metric)).toEqual(["dl_speed_bytes", "up_speed_bytes"]);
  });

  it("shows torrent states as one share", () => {
    const spec = qbittorrent().UI_SPEC;
    const card = spec.cards!.share_card;
    expect(card.kind).toBe("share");
    expect(card.parts!.map((part) => part.metric)).toEqual(["torrents_state_downloading", "torrents_state_seeding", "torrents_state_paused", "torrents_state_stalled", "torrents_state_errored"]);
    expect(spec.layout!.flat()).toContain("share_card");
  });

  it("keeps the existing cards", () => {
    const cards = Object.keys(qbittorrent().UI_SPEC.cards!);
    for (const name of ["connection_card", "speed_card", "torrents_card", "stalled_card", "errored_card"]) expect(cards).toContain(name);
  });
});

describe("optional limits", () => {
  it("never fails with a stall warning only", () => {
    const plugin = qbittorrent({ stalled_threshold: null });
    respond(plugin, undefined, torrents({ downloading: 1, stalled: 50 }));
    expect(latest_status(plugin)).toBe("warning");
    expect((plugin.UI_SPEC.cards!.stalled_card.color as (value: number) => unknown)(50)).toBe("warning");
  });

  it("never warns with a stall failure only", () => {
    const plugin = qbittorrent({ stalled_warning: null });
    respond(plugin, undefined, torrents({ downloading: 1, stalled: 5 }));
    expect(latest_status(plugin)).toBe("online");
    respond(plugin, undefined, torrents({ downloading: 1, stalled: 10 }));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("never fails on errored torrents with a null error threshold", () => {
    const plugin = qbittorrent({ error_threshold: null });
    respond(plugin, undefined, torrents({ downloading: 1, errored: 3 }));
    expect(latest_status(plugin)).toBe("online");
  });

  it("keeps count limits whole numbers", () => {
    expect(qbittorrent({ stalled_warning: 4.7 }).stalled_warning).toBe(4);
  });
});
