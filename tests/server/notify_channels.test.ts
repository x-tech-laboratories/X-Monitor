import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Message, digest } from "../../src/server/notifications/channels.ts";
import { HttpChannel, NtfyChannel, WebhookChannel, render } from "../../src/server/notifications/http.ts";
import { build_channels } from "../../src/server/notifications/index.ts";
import { AppriseChannel, SmtpChannel } from "../../src/server/notifications/mail.ts";
import { parse_windows, window } from "../../src/server/notifications/maintenance.ts";
import { OpsgenieChannel, PagerDutyChannel } from "../../src/server/notifications/oncall.ts";
import { set_log_sink } from "../../src/core/logging.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const FAILED = new Message({
  title: "Nas is failed", body: "Pool tank is DEGRADED\nHost: nas.lan", status: "failed", kind: "problem",
  monitor_id: "nas-zfs", url: "https://x-monitor.lan/#/monitor/nas-zfs", monitor_name: "Nas", host: "nas.lan", timestamp: 1790000000,
});
const RECOVERED = new Message({ title: "Nas recovered", body: "Was down for 5 Minutes", status: "online", kind: "recovered", monitor_id: "nas-zfs", monitor_name: "Nas", host: "nas.lan", timestamp: 1790000300 });

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function capture(channel: HttpChannel, status = 200): Captured[] {
  const requests: Captured[] = [];
  channel.fetch = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    requests.push({ method: String(init.method), url, headers, body: String(init.body) });
    return new Response(status >= 300 ? "nope" : "ok", { status });
  }) as unknown as typeof fetch;
  return requests;
}

function temp_file(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "notify-")), "file");
  writeFileSync(path, text);
  return path;
}

// ── Webhook and ntfy ─────────────────────────────────────────────────────────

describe("webhook channel", () => {
  it("sends the default payload as JSON", async () => {
    const channel = new WebhookChannel("hook", { url: "https://hooks.lan/x-monitor" });
    const requests = capture(channel);
    await channel.send(FAILED);
    expect([requests[0]!.method, requests[0]!.url]).toEqual(["POST", "https://hooks.lan/x-monitor"]);
    const body = JSON.parse(requests[0]!.body);
    expect(body).toMatchObject({ title: "Nas is failed", status: "failed", kind: "problem", monitor: { id: "nas-zfs", name: "Nas", host: "nas.lan" }, url: "https://x-monitor.lan/#/monitor/nas-zfs" });
    expect(body.timestamp).toMatch(/^2026-/);
  });

  it("fills a mapping payload and sends it as JSON", async () => {
    const channel = new WebhookChannel("hook", { url: "https://chat.lan/hook", payload: { text: "{title}: {body}", extra: ["{monitor_id}", 7], keep: "{nope}" } });
    const requests = capture(channel);
    await channel.send(FAILED);
    expect(JSON.parse(requests[0]!.body)).toEqual({ text: "Nas is failed: Pool tank is DEGRADED\nHost: nas.lan", extra: ["nas-zfs", 7], keep: "{nope}" });
  });

  it("sends a text payload as plain text", async () => {
    const channel = new WebhookChannel("hook", { url: "https://x.lan", method: "put", payload: "{monitor_name} is {status}" });
    const requests = capture(channel);
    await channel.send(FAILED);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.body).toBe("Nas is failed");
    expect(requests[0]!.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("reads headers, a bearer token file and a url file", async () => {
    const channel = new WebhookChannel("hook", { url_file: temp_file("https://ha.lan/api/webhook/abc123\n"), bearer_token_file: temp_file("s3cret\n"), headers: { "X-Source": "x-monitor" } });
    const requests = capture(channel);
    await channel.send(FAILED);
    expect(requests[0]!.url).toBe("https://ha.lan/api/webhook/abc123");
    expect(requests[0]!.headers.authorization).toBe("Bearer s3cret");
    expect(requests[0]!.headers["x-source"]).toBe("x-monitor");
  });

  it("throws on a rejected request and on bad settings", async () => {
    const channel = new WebhookChannel("hook", { url: "https://x.lan" });
    capture(channel, 500);
    await expect(channel.send(FAILED)).rejects.toThrow("HTTP 500");
    expect(() => new WebhookChannel("hook", {})).toThrow("needs `url`");
    expect(() => new WebhookChannel("hook", { url: "https://x", method: "GET" })).toThrow("POST, PUT or PATCH");
    expect(() => new WebhookChannel("hook", { url_file: "/no/such/file" })).toThrow("could not read url_file");
  });

  it("leaves non-strings alone when rendering", () => {
    expect(render({ n: 1, b: true, s: "{a}" }, { a: "x" })).toEqual({ n: 1, b: true, s: "x" });
  });
});

describe("ntfy channel", () => {
  it("publishes to the topic with a click link", async () => {
    const channel = new NtfyChannel("phone", { topic: "x-monitor-alerts" });
    const requests = capture(channel);
    await channel.send(FAILED);
    expect(requests[0]!.url).toBe("https://ntfy.sh");
    expect(JSON.parse(requests[0]!.body)).toEqual({
      topic: "x-monitor-alerts", title: "Nas is failed", message: "Pool tank is DEGRADED\nHost: nas.lan", priority: 4, tags: ["rotating_light"], click: "https://x-monitor.lan/#/monitor/nas-zfs",
    });
  });

  it("gives a recovery its own priority and tags", async () => {
    const channel = new NtfyChannel("phone", { topic: "t" });
    const requests = capture(channel);
    await channel.send(RECOVERED);
    const body = JSON.parse(requests[0]!.body);
    expect([body.priority, body.tags]).toEqual([2, ["white_check_mark"]]);
    expect(body).not.toHaveProperty("click");
  });

  it("takes priority and tags once or per status", async () => {
    const channel = new NtfyChannel("phone", { topic: "t", priority: { failed: "urgent" }, tags: "server, x-monitor" });
    const requests = capture(channel);
    await channel.send(FAILED);
    await channel.send(RECOVERED);
    expect(requests.map((request) => JSON.parse(request.body)).map((body) => [body.priority, body.tags])).toEqual([[5, ["server", "x-monitor"]], [2, ["server", "x-monitor"]]]);
  });

  it("reaches a self-hosted server with a token, or a name and password", async () => {
    const channel = new NtfyChannel("phone", { url: "https://ntfy.lan/", topic_file: temp_file("private-topic\n"), token: "tk_abc" });
    const requests = capture(channel);
    await channel.send(FAILED);
    expect(requests[0]!.url).toBe("https://ntfy.lan");
    expect(JSON.parse(requests[0]!.body).topic).toBe("private-topic");
    expect(requests[0]!.headers.authorization).toBe("Bearer tk_abc");
    const basic = new NtfyChannel("phone", { topic: "t", username: "me", password: "pw" });
    const basic_requests = capture(basic);
    await basic.send(FAILED);
    expect(basic_requests[0]!.headers.authorization).toMatch(/^Basic /);
  });

  it("refuses bad settings", () => {
    expect(() => new NtfyChannel("phone", {})).toThrow("needs `topic`");
    expect(() => new NtfyChannel("phone", { topic: "t", priority: 9 })).toThrow("`priority` must be");
    expect(() => new NtfyChannel("phone", { topic: "t", tags: { down: "x" } })).toThrow("keys must be");
  });
});

// ── Mail and Apprise ─────────────────────────────────────────────────────────

describe("smtp channel", () => {
  function recording(channel: SmtpChannel) {
    const sessions: { options: Record<string, unknown>; mail: unknown }[] = [];
    channel.create_transport = (options) => ({ sendMail: async (mail) => void sessions.push({ options, mail }) });
    return sessions;
  }

  it("uses STARTTLS, signs in and sends", async () => {
    const channel = new SmtpChannel("mail", { host: "mail.lan", username: "x-monitor@lan", password_file: temp_file("s3cret\n"), to: "me@lan, you@lan", subject_prefix: "[X-Monitor] " });
    const sessions = recording(channel);
    await channel.send(new Message({ ...FAILED, body: "Pool tank is DEGRADED" }));
    expect(sessions[0]!.options).toMatchObject({ host: "mail.lan", port: 587, requireTLS: true, auth: { user: "x-monitor@lan", pass: "s3cret" } });
    expect(sessions[0]!.mail).toEqual({
      from: "x-monitor@lan", to: "me@lan, you@lan", subject: "[X-Monitor] Nas is failed",
      text: "Pool tank is DEGRADED\n\nhttps://x-monitor.lan/#/monitor/nas-zfs",
    });
  });

  it("uses port 465 for TLS, and neither STARTTLS nor sign-in without security", async () => {
    const tls = new SmtpChannel("mail", { host: "mail.lan", security: "tls", from: "x-monitor@lan", to: ["me@lan"] });
    const tls_sessions = recording(tls);
    await tls.send(RECOVERED);
    expect(tls_sessions[0]!.options).toMatchObject({ port: 465, secure: true });
    const plain = new SmtpChannel("mail", { host: "relay.lan", security: "none", port: 2525, from: "x-monitor@lan", to: "me@lan" });
    const plain_sessions = recording(plain);
    await plain.send(FAILED);
    expect(plain_sessions[0]!.options).toMatchObject({ port: 2525, secure: false, requireTLS: false, ignoreTLS: true });
    expect(plain_sessions[0]!.options).not.toHaveProperty("auth");
  });

  it("refuses bad settings", () => {
    expect(() => new SmtpChannel("mail", { to: "a@b" })).toThrow("needs `host`");
    expect(() => new SmtpChannel("mail", { host: "h", to: "a@b" })).toThrow("needs `from`");
    expect(() => new SmtpChannel("mail", { host: "h", from: "a@b" })).toThrow("needs `to`");
    expect(() => new SmtpChannel("mail", { host: "h", from: "a@b", to: "c@d", security: "ssl" })).toThrow("starttls, tls or none");
  });
});

describe("apprise channel", () => {
  function recording(channel: AppriseChannel, exit_code = 0) {
    const calls: readonly string[][] = [];
    channel.run = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { exit_code, stdout: "", stderr: "" };
    };
    return calls;
  }

  it("sends the title, the body with its link, and the severity", async () => {
    const channel = new AppriseChannel("bridge", { urls: "json://hooks.lan/x-monitor" });
    const calls = recording(channel);
    await channel.send(new Message({ ...FAILED, body: "Pool tank is DEGRADED" }));
    await channel.send(RECOVERED);
    expect(calls[0]).toEqual(["apprise", "--title", "Nas is failed", "--body", "Pool tank is DEGRADED\n\nhttps://x-monitor.lan/#/monitor/nas-zfs", "--notification-type", "failure"]);
    expect(calls[1]!.at(-1)).toBe("success");
  });

  it("reads one URL per line of its file", () => {
    const channel = new AppriseChannel("bridge", { urls: ["json://c.lan/z"], urls_file: temp_file("# chat\njson://a.lan/x\n\njson://b.lan/y?a=1,2\n") });
    expect(channel.urls).toHaveLength(3);
  });

  it("throws on a failed delivery and on bad settings", async () => {
    const channel = new AppriseChannel("bridge", { urls: "json://hooks.lan/x-monitor" });
    recording(channel, 1);
    await expect(channel.send(FAILED)).rejects.toThrow("could not deliver");
    expect(() => new AppriseChannel("bridge", {})).toThrow("needs `urls`");
    expect(() => new AppriseChannel("bridge", { urls: "notaservice" })).toThrow("not recognised");
  });
});

// ── On-call ──────────────────────────────────────────────────────────────────

const PROBLEM_SLASH = new Message({ title: "Nas is failed", body: "Pool tank is DEGRADED", status: "failed", kind: "problem", monitor_id: "nas/zfs", url: "https://x-monitor.lan/#/monitor/nas%2Fzfs", monitor_name: "Nas", host: "nas.lan", timestamp: 1790000000 });
const RECOVERED_SLASH = new Message({ title: "Nas recovered", body: "Was down for 5 Minutes", status: "online", kind: "recovered", monitor_id: "nas/zfs" });
const FLAPPING = new Message({ title: "Nas is flapping", body: "b", status: "online", kind: "flapping", monitor_id: "nas/zfs" });
const TEST = new Message({ title: "X-Monitor test notification", body: "b", status: "online", kind: "test" });

const bodies = (requests: Captured[]) => requests.map((request) => JSON.parse(request.body));

describe("pagerduty channel", () => {
  it("triggers on a problem and resolves the same incident on recovery", async () => {
    const channel = new PagerDutyChannel("pd", { routing_key: "R0UT1NG" });
    const requests = capture(channel);
    await channel.send(PROBLEM_SLASH);
    await channel.send(RECOVERED_SLASH);
    expect(requests[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(bodies(requests)).toEqual([
      {
        routing_key: "R0UT1NG", event_action: "trigger", dedup_key: "nas/zfs",
        payload: { summary: "Nas is failed", source: "nas.lan", severity: "critical", component: "Nas", custom_details: { details: "Pool tank is DEGRADED", status: "failed" } },
        links: [{ href: "https://x-monitor.lan/#/monitor/nas%2Fzfs", text: "Open in X-Monitor" }],
      },
      { routing_key: "R0UT1NG", event_action: "resolve", dedup_key: "nas/zfs" },
    ]);
  });

  it("takes severity per status, opens and closes a test, and keeps one incident per monitor in a batch", async () => {
    const channel = new PagerDutyChannel("pd", { routing_key_file: temp_file("R0UT1NG\n"), severity: { failed: "error" } });
    const requests = capture(channel);
    await channel.send(PROBLEM_SLASH);
    await channel.send(FLAPPING);
    expect(bodies(requests).map((body) => body.payload.severity)).toEqual(["error", "warning"]);

    const test = new PagerDutyChannel("pd", { routing_key: "k" });
    const test_requests = capture(test);
    await test.send(TEST);
    expect(bodies(test_requests).map((body) => [body.event_action, body.dedup_key])).toEqual([["trigger", "x-monitor-test"], ["resolve", "x-monitor-test"]]);

    const batch = new PagerDutyChannel("pd", { routing_key: "k" });
    const batch_requests = capture(batch);
    const other = new Message({ title: "Web is failed", body: "b", status: "failed", kind: "problem", monitor_id: "web" });
    await batch.send_batch([PROBLEM_SLASH, other]);
    expect(bodies(batch_requests).map((body) => body.dedup_key)).toEqual(["nas/zfs", "web"]);
    expect(digest([PROBLEM_SLASH, other], null).title).toBe("X-Monitor: 2 failed");
  });

  it("refuses bad settings", () => {
    expect(() => new PagerDutyChannel("pd", {})).toThrow("routing_key");
    expect(() => new PagerDutyChannel("pd", { routing_key: "k", severity: "high" })).toThrow("critical, error, warning or info");
  });
});

describe("opsgenie channel", () => {
  it("creates an alert on a problem and closes it by alias on recovery", async () => {
    const channel = new OpsgenieChannel("og", { api_key: "G3N13" });
    const requests = capture(channel);
    await channel.send(PROBLEM_SLASH);
    await channel.send(RECOVERED_SLASH);
    expect(requests[0]!.url).toBe("https://api.opsgenie.com/v2/alerts");
    expect(requests[0]!.headers.authorization).toBe("GenieKey G3N13");
    expect(JSON.parse(requests[0]!.body)).toEqual({
      message: "Nas is failed", alias: "nas/zfs", description: "Pool tank is DEGRADED", priority: "P1", source: "X-Monitor", entity: "nas.lan",
      details: { status: "failed", url: "https://x-monitor.lan/#/monitor/nas%2Fzfs" },
    });
    expect(requests[1]!.url).toBe("https://api.opsgenie.com/v2/alerts/nas%2Fzfs/close?identifierType=alias");
    expect(JSON.parse(requests[1]!.body)).toEqual({ source: "X-Monitor", note: "Nas recovered" });
  });

  it("takes the EU region and priorities", async () => {
    const channel = new OpsgenieChannel("og", { api_key: "k", region: "EU", priority: { failed: "P2" } });
    const requests = capture(channel);
    await channel.send(PROBLEM_SLASH);
    expect(requests[0]!.url.startsWith("https://api.eu.opsgenie.com/")).toBe(true);
    expect(JSON.parse(requests[0]!.body).priority).toBe("P2");
  });

  it("refuses bad settings", () => {
    expect(() => new OpsgenieChannel("og", {})).toThrow("api_key");
    expect(() => new OpsgenieChannel("og", { api_key: "k", region: "mars" })).toThrow("us or eu");
    expect(() => new OpsgenieChannel("og", { api_key: "k", priority: "urgent" })).toThrow("P1 to P5");
  });
});

describe("build_channels", () => {
  it("knows every channel type", () => {
    const channels = build_channels([
      { id: "hook", type: "webhook", url: "https://x" },
      { id: "phone", type: "ntfy", topic: "t" },
      { id: "mail", type: "smtp", host: "h", from: "a@b", to: "c@d" },
      { id: "bridge", type: "apprise", urls: "json://hooks.lan/x-monitor" },
      { id: "pd", type: "pagerduty", routing_key: "k" },
      { id: "og", type: "opsgenie", api_key: "k" },
    ], null);
    expect(Object.fromEntries([...channels].map(([id, channel]) => [id, channel.constructor.name]))).toEqual({
      hook: "WebhookChannel", phone: "NtfyChannel", mail: "SmtpChannel", bridge: "AppriseChannel", pd: "PagerDutyChannel", og: "OpsgenieChannel",
    });
  });
});

// ── Maintenance windows ──────────────────────────────────────────────────────

// 2026-09-27 is a Sunday.
const at = (day_offset: number, hour: number, minute = 0) => new Date(2026, 8, 27 + day_offset, hour, minute);

describe("maintenance windows", () => {
  it("recur daily", () => {
    const daily = window({ name: "n", from: "03:00", to: "05:00" });
    expect(daily.active(at(0, 2, 59))).toBe(false);
    expect(daily.active(at(0, 3)) && daily.active(at(3, 4, 59))).toBe(true);
    expect(daily.active(at(0, 5))).toBe(false);
  });

  it("are limited by weekdays, and one past midnight belongs to the day it started", () => {
    const weekly = window({ name: "n", days: ["sun", "Wednesday"], from: "03:00", to: "05:00" });
    expect(weekly.active(at(0, 4)) && weekly.active(at(3, 4))).toBe(true);
    expect(weekly.active(at(1, 4))).toBe(false);
    const late = window({ name: "n", days: "sat", from: "23:00", to: "01:00" });
    expect(late.active(at(-1, 23, 30))).toBe(true);
    expect(late.active(at(0, 0, 30))).toBe(true);
    expect(late.active(at(0, 23, 30))).toBe(false);
  });

  it("run once between two dates", () => {
    const once = window({ name: "n", start: "2026-10-01T09:00", end: "2026-10-01T17:00" });
    expect(once.active(new Date(2026, 9, 1, 9))).toBe(true);
    expect(once.active(new Date(2026, 9, 1, 17))).toBe(false);
    expect(once.active(new Date(2026, 9, 2, 10))).toBe(false);
  });

  it("cover their monitors and their groups", () => {
    const covering = window({ name: "n", monitors: ["storage"], from: "03:00", to: "05:00" });
    expect(covering.covers(["nas", "storage"])).toBe(true);
    expect(covering.covers(["web", "services"])).toBe(false);
    expect(window({ name: "n", from: "03:00", to: "05:00" }).covers(["anything"])).toBe(true);
  });

  it("describe themselves", () => {
    expect(window({ name: "n", days: ["sun", "mon"], from: "03:00", to: "05:30" }).describe()).toBe("Mon, Sun 03:00-05:30");
    expect(window({ name: "n", from: "03:00", to: "05:00" }).describe()).toBe("Daily 03:00-05:00");
    expect(window({ name: "n", start: "2026-10-01T09:00", end: "2026-10-01T17:00" }).describe()).toBe("2026-10-01 09:00 to 2026-10-01 17:00");
  });

  it.each([
    [{ from: "03:00" }, "give `from` and `to`"],
    [{ from: "3am", to: "05:00" }, "time of day"],
    [{ from: "03:00", to: "03:00" }, "must differ"],
    [{ days: ["funday"], from: "03:00", to: "05:00" }, "weekday names"],
    [{ start: "2026-10-01T09:00", end: "2026-10-01T08:00" }, "after `start`"],
    [{ start: "soon", end: "2026-10-01T08:00" }, "date and time"],
  ])("refuses a malformed window %j", (entry, error) => {
    expect(() => window(entry)).toThrow(error);
  });

  it("skips bad windows when parsing", () => {
    const lines: string[] = [];
    set_log_sink((record) => lines.push(record.message));
    const windows = parse_windows([{ name: "good", from: "03:00", to: "05:00" }, { name: "bad", from: "03:00" }, "not a mapping"]);
    set_log_sink((record) => process.stderr.write(`${record.message}\n`));
    expect(windows.map((each) => each.name)).toEqual(["good"]);
    expect(lines.some((line) => line.includes("\"bad\" ignored"))).toBe(true);
  });
});
