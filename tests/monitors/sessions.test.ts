import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { SCRIPT_SEP, type PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { parse_last, parse_loginctl, parse_who, probe_script, Sessions, source_allowed, type RecentLogin, type Session } from "../../src/monitors/sessions.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-sessions", id: "test-sessions", ssh_config: { host: "test.host" } };

function block(id: string, user: string, { host = "", remote = null as string | null, tty = "pts/0", seat = "", class_name = "user", kind = "tty", service = "sshd", since = "Thu 2026-09-24 10:00:00 UTC", idle = "no", idle_since = "0" } = {}): string {
  const is_remote = remote ?? (host ? "yes" : "no");
  return `Id=${id}\nName=${user}\nTimestamp=${since}\nSeat=${seat}\nTTY=${tty}\nRemote=${is_remote}\nRemoteHost=${host}\nRemoteUser=\nService=${service}\nType=${kind}\nClass=${class_name}\nState=active\nIdleHint=${idle}\nIdleSinceHint=${idle_since}\n`;
}

const alice_ssh = block("4", "alice", { host: "192.0.2.5" });
const alice_desktop = block("2", "alice", { tty: "", seat: "seat0", kind: "wayland", service: "gdm-password" });
const manager = block("3", "alice", { tty: "", class_name: "manager", kind: "unspecified", service: "systemd-user" });
const greeter = block("c1", "gdm", { tty: "tty1", seat: "seat0", class_name: "greeter", kind: "wayland", service: "gdm-launch-environment" });
const mallory = block("7", "mallory", { host: "203.0.113.9" });

const who = `alice    pts/0        2026-09-24 10:00   .          1234 192.0.2.5
bob      tty1         2026-09-24 08:00 01:20        987
carol    pts/1        2026-09-23 22:00  old         4321 (host1.example.com)
dave     :0           2026-09-24 07:00   ?          555 (:0)
`;

const last = `alice    pts/0        192.0.2.5        2026-09-24T10:00:00+00:00   still logged in
reboot   system boot  0.0.0.0          2026-09-24T07:59:00+00:00   still running
bob      tty1         0.0.0.0          2026-09-23T08:00:00+00:00 - 2026-09-23T17:00:00+00:00  (09:00)
carol    pts/1        198.51.100.7     2026-09-22T22:00:00+00:00 - crash                     (1+02:00)

wtmp begins 2026-09-01T00:00:00+00:00
`;

const output = (sessions = "", source = "loginctl", recent = last): string => `source=${source}\n${SCRIPT_SEP}\n${sessions}${SCRIPT_SEP}\n${recent}`;

const sessions_monitor = (extra: PluginConfig = {}): Sessions => make_plugin(Sessions, { ...config, ...extra });
const guarded = (): Sessions => sessions_monitor({ allowed_users: ["alice", "svc-*"], allowed_sources: ["192.0.2.0/24", "*.example.com"] });
const run = (plugin: Sessions, stdout: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const snapshot_of = (result: { snapshot: unknown }) => result.snapshot as { source: string; sessions: Session[]; recent: RecentLogin[] };
const latest_status = (plugin: Sessions) => store_of(plugin).latest_status("test-sessions");
const latest_metric = (plugin: Sessions, name: string) => store_of(plugin).latest_metric("test-sessions", name)?.value ?? null;

describe("parsers", () => {
  it("reads loginctl without separators and leaves out ignored classes", () => {
    const parsed = parse_loginctl(alice_desktop + manager + greeter + alice_ssh);
    expect(parsed.map((session) => session.id)).toEqual(["2", "4"]);
    const [desktop, ssh] = parsed;
    expect(desktop.seat).toBe("seat0");
    expect(desktop.remote).toBe(false);
    expect(desktop.host).toBe("");
    expect(ssh.host).toBe("192.0.2.5");
    expect(ssh.remote).toBe(true);
    expect(ssh.since).toBe("2026-09-24 10:00:00 UTC");
    expect(ssh.class).toBe("user");
  });

  it("reads loginctl blocks separated by blank lines", () => expect(parse_loginctl(alice_ssh + "\n" + mallory)).toHaveLength(2));

  it("reads loginctl idle", () => {
    const stamp = Math.trunc(Date.now() / 1000 - 600) * 1_000_000;
    const session = parse_loginctl(block("5", "alice", { idle: "yes", idle_since: String(stamp) }))[0];
    expect(session.idle).toBe(true);
    expect(session.idle_since).toBe(Math.floor(stamp / 1_000_000));
  });

  it("reads who", () => {
    const parsed = Object.fromEntries(parse_who(who).map((session) => [session.user, session]));
    expect(parsed.alice.host).toBe("192.0.2.5");
    expect(parsed.alice.remote).toBe(true);
    expect(parsed.alice.idle_text).toBe("active");
    expect(parsed.bob.host).toBe("");
    expect(parsed.bob.idle_text).toBe("01:20");
    expect(parsed.carol.host).toBe("host1.example.com");
    expect(parsed.carol.idle_text).toBe("over 1 day");
    expect(parsed.dave.host).toBe("");
    expect(parsed.dave.remote).toBe(false);
  });

  it("reads last", () => {
    const logins = parse_last(last);
    expect(logins.map((entry) => entry.user)).toEqual(["alice", "bob", "carol"]);
    expect(logins[0].until).toBe("still logged in");
    expect(logins[0].host).toBe("192.0.2.5");
    expect(logins[1].host).toBe("");
    expect(logins[1].duration).toBe("09:00");
    expect(logins[1].until).toBe("2026-09-23T17:00:00+00:00");
    expect(logins[2].until).toBe("crash");
    expect(logins[2].duration).toBe("1+02:00");
  });

  it("matches sources by CIDR, hostname and glob", () => {
    expect(source_allowed("192.0.2.77", ["192.0.2.0/24"])).toBe(true);
    expect(source_allowed("2001:db8::5", ["2001:db8::/32"])).toBe(true);
    expect(source_allowed("203.0.113.9", ["192.0.2.0/24", "bad/cidr"])).toBe(false);
    expect(source_allowed("Host1.Example.com", ["*.example.com"])).toBe(true);
    expect(source_allowed("host1", ["host1"])).toBe(true);
    expect(source_allowed("host1", ["10.0.0.0/8"])).toBe(false);
  });
});

describe("script", () => {
  it("asks last for extra records for the recent logins", () => expect(sessions_monitor().commands()[0].text).toContain("last -i -w -n 20 --time-format iso"));
  it("leaves last out when turned off", () => expect(probe_script(0)).not.toContain("last "));

  it("is one sampled command", () => {
    const plugin = sessions_monitor();
    expect(plugin.SAMPLED).toBe(true);
    expect(plugin.commands()).toHaveLength(1);
  });
});

describe("collection", () => {
  it("counts sessions", () => {
    const plugin = sessions_monitor();
    const result = run(plugin, output(alice_desktop + manager + alice_ssh + mallory));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "sessions_total")).toBe(3.0);
    expect(latest_metric(plugin, "sessions_remote")).toBe(2.0);
    expect(latest_metric(plugin, "users_total")).toBe(2.0);
    expect(latest_metric(plugin, "sessions_unexpected")).toBe(0.0);
    expect(snapshot_of(result).recent).toHaveLength(3);
  });

  it("caps the recent logins", () => {
    const result = run(sessions_monitor({ recent_logins: 2 }), output(alice_ssh));
    expect(snapshot_of(result).recent.map((entry) => entry.user)).toEqual(["alice", "bob"]);
  });

  it("calls no sessions online", () => {
    const plugin = sessions_monitor();
    run(plugin, output(""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "sessions_total")).toBe(0.0);
  });

  it("falls back to who", () => {
    const plugin = sessions_monitor();
    const result = run(plugin, output(who, "who"));
    expect(snapshot_of(result).source).toBe("who");
    expect(latest_metric(plugin, "sessions_total")).toBe(4.0);
    expect(latest_metric(plugin, "sessions_remote")).toBe(2.0);
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = sessions_monitor();
    run(plugin, "", -1, "connection refused");
    expect(latest_status(plugin)).toBe("unavailable");
  });
});

describe("allowlists", () => {
  it("calls allowed sessions online", () => {
    const plugin = guarded();
    run(plugin, output(alice_desktop + alice_ssh));
    expect(latest_status(plugin)).toBe("online");
  });

  it("warns on an unknown user", () => {
    const plugin = guarded();
    const result = run(plugin, output(block("9", "bob")));
    expect(latest_status(plugin)).toBe("warning");
    expect(result.logs[1][0]).toContain("user bob is not in allowed_users");
  });

  it("warns on an unknown source", () => {
    const plugin = guarded();
    const result = run(plugin, output(block("9", "alice", { host: "203.0.113.9" })));
    expect(latest_status(plugin)).toBe("warning");
    expect(result.logs[1][0]).toContain("source 203.0.113.9");
    expect(latest_metric(plugin, "sessions_unexpected")).toBe(1.0);
  });

  it("matches a hostname source against a glob", () => {
    const plugin = guarded();
    run(plugin, output(block("9", "alice", { host: "host1.example.com" })));
    expect(latest_status(plugin)).toBe("online");
  });

  it("passes a local session through the source check", () => {
    const plugin = sessions_monitor({ allowed_sources: ["192.0.2.0/24"] });
    run(plugin, output(alice_desktop));
    expect(latest_status(plugin)).toBe("online");
  });

  it("takes a configurable violation status", () => {
    const plugin = sessions_monitor({ allowed_users: ["alice"], violation_status: "failed" });
    const result = run(plugin, output(mallory));
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[1][1]).toBe("ERROR");
  });

  it("logs a violation once while the status holds", () => {
    const plugin = guarded();
    const first = run(plugin, output(mallory));
    expect(first.logs.filter(([message]) => message.includes("Unexpected session"))).toHaveLength(1);
    const second = run(plugin, output(mallory));
    expect(second.logs.some(([message]) => message.includes("Unexpected session"))).toBe(false);
    expect(latest_status(plugin)).toBe("warning");
    run(plugin, output(alice_ssh));
    expect(latest_status(plugin)).toBe("online");
  });

  it("treats a session id that returns after ending as new again", () => {
    const plugin = guarded();
    run(plugin, output(mallory));
    run(plugin, output(""));
    const again = run(plugin, output(mallory));
    expect(again.logs.some(([message]) => message.includes("Unexpected session"))).toBe(true);
  });
});

describe("new session events", () => {
  it("keeps the first cycle a quiet baseline", () => expect(run(sessions_monitor(), output(alice_ssh)).logs).toHaveLength(1));

  it("logs later sessions once", () => {
    const plugin = sessions_monitor();
    run(plugin, output(alice_ssh));
    const result = run(plugin, output(alice_ssh + block("8", "bob", { host: "192.0.2.6" })));
    expect(result.logs.slice(1).map(([message]) => message)).toEqual(["New session: bob on pts/0 from 192.0.2.6"]);
    const again = run(plugin, output(alice_ssh + block("8", "bob", { host: "192.0.2.6" })));
    expect(again.logs).toHaveLength(1);
  });
});

describe("rows", () => {
  it("builds session and recent rows", () => {
    const plugin = guarded();
    const stamp = Math.trunc(Date.now() / 1000 - 3600) * 1_000_000;
    const idle = block("5", "alice", { idle: "yes", idle_since: String(stamp) });
    run(plugin, output(alice_desktop + idle + mallory));
    const rows = Object.fromEntries(plugin.session_rows.map((row) => [row.id, row]));
    expect(rows["2"].where).toBe("seat0");
    expect(rows["2"].host).toBe("local");
    expect(rows["2"].type).toBe("wayland (gdm-password)");
    expect(rows["2"].idle).toBe("active");
    const idle_text = String(rows["5"].idle);
    expect(idle_text.startsWith("1 Hour") || idle_text.startsWith("59 Minutes")).toBe(true);
    expect(plugin.allowed_color(rows["7"])).toBe("warning");
    expect(plugin.allowed_color(rows["2"])).toBeNull();
    const recent = plugin.recent_rows;
    expect(recent[1].host).toBe("local");
    expect(recent[0].duration).toBe("--");
    expect(plugin.unexpected_color(1)).toBe("warning");
    expect(plugin.unexpected_color(0)).toBe("online");
  });

  it("lets the recent table be turned off", () => expect("recent_logins" in sessions_monitor({ recent_logins: 0 }).UI_SPEC.tables!).toBe(false));
});
