import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { DesktopChannel, Message, digest, type AgentDirectory, type DesktopAgent } from "../../src/server/notifications/channels.ts";
import { NotificationEngine, build_channels, monitor_url, type Sender } from "../../src/server/notifications/index.ts";
import { window } from "../../src/server/notifications/maintenance.ts";
import { FLAPPING, PROBLEM, RECOVERED, REMINDER, SETTLED, Tracker, make_rule, resolve_rules, type Alert } from "../../src/server/notifications/rules.ts";
import type { NotifyingMonitor as TreeMonitor } from "../../src/server/notifications/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FakeMonitor extends TreeMonitor {
  children: FakeMonitor[];
  links?: Record<string, string | null>;
}

function plugin(plugin_id: string, children: FakeMonitor[] = [], type = "cpu", config: Record<string, unknown> = {}): FakeMonitor {
  return {
    id: plugin_id, name: plugin_id.charAt(0).toUpperCase() + plugin_id.slice(1), target: "host.lan",
    config: { type, ...config }, children, restates_children: type === "group",
  };
}

function alert(kind: string, status: string, since: number, settled = false): Alert {
  return { kind, status, since, settled };
}

class RecordingChannel implements Sender {
  readonly id: string;
  readonly sent: Message[] = [];
  dismisses_on_recovery = false;
  private fail: number;

  constructor(channel_id = "desk", fail = 0) {
    this.id = channel_id;
    this.fail = fail;
  }

  async send(message: Message): Promise<void> {
    if (this.fail) {
      this.fail -= 1;
      throw new Error("agent is not connected");
    }
    this.sent.push(message);
  }
}

const drain = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
};

// ── Rules ────────────────────────────────────────────────────────────────────

describe("resolve_rules", () => {
  it("gives every monitor the defaults", () => {
    const rules = resolve_rules([plugin("a"), plugin("b")], {}, ["desk"]);
    expect(Object.fromEntries(rules)).toEqual({ a: make_rule({ channels: ["desk"] }), b: make_rule({ channels: ["desk"] }) });
  });

  it("passes group settings to children, but the group never notifies", () => {
    const group = plugin("g", [plugin("a"), plugin("b", [], "cpu", { notify: { after: 3 } })], "group", { notify: { on: ["failed", "warning"] } });
    const rules = resolve_rules([group], {}, ["desk"]);
    expect([...rules.keys()].sort()).toEqual(["a", "b"]);
    expect([...rules.get("a")!.on].sort()).toEqual(["failed", "warning"]);
    expect(rules.get("b")!.after).toBe(3);
  });

  it("lets a monitor with children of its own notify for itself", () => {
    const rules = resolve_rules([plugin("web", [plugin("cert")], "http", { notify: { after: 2 } })], {}, ["desk"]);
    expect([...rules.keys()].sort()).toEqual(["cert", "web"]);
    expect(rules.get("cert")!.after).toBe(2);
  });

  it("mutes a monitor and its children with notify false, and a child mapping switches it back on", () => {
    const group = plugin("g", [plugin("a"), plugin("b", [], "cpu", { notify: true })], "group", { notify: false });
    expect([...resolve_rules([group, plugin("c")], {}, ["desk"]).keys()]).toEqual(["c"]);
    const muted = plugin("g", [plugin("a", [], "cpu", { notify: { after: 2 } })], "group", { notify: false });
    expect(resolve_rules([muted], {}, ["desk"]).get("a")!.after).toBe(2);
  });

  it("drops unknown channels and statuses", () => {
    const rules = resolve_rules([plugin("a", [], "cpu", { notify: { channels: ["nope", "desk"], on: ["failed", "bogus"] } })], {}, ["desk"]);
    expect(rules.get("a")).toEqual(make_rule({ channels: ["desk"], on: new Set(["failed"]) }));
  });

  it("takes durations for for, repeat and flapping", () => {
    expect(resolve_rules([plugin("a")], { for: "1h" }, ["desk"]).get("a")!.hold).toBe(3600);
    expect(resolve_rules([plugin("a")], { repeat: "1h" }, ["desk"]).get("a")!.repeat).toBe(3600);
    const flapping = resolve_rules([plugin("a")], { flapping: { changes: 4, within: "30m" } }, ["d"]).get("a")!;
    expect([flapping.flap_changes, flapping.flap_window]).toEqual([4, 1800]);
  });

  it("makes no rules without channels, and never notifies on info", () => {
    expect(resolve_rules([plugin("a")], {}, []).size).toBe(0);
    expect([...resolve_rules([plugin("a", [], "cpu", { notify: { on: ["failed", "info"] } })], {}, ["desk"]).get("a")!.on]).toEqual(["failed"]);
  });

  it("passes a group's settings only to what it defines, not what it links", () => {
    const cpu = plugin("cpu");
    const host = plugin("host", [cpu], "group", { notify: { after: 2 } });
    const domain = plugin("compute", [cpu], "group", { notify: false });
    domain.links = { cpu: "Host" };
    expect(resolve_rules([host, domain], {}, ["desk"]).get("cpu")!.after).toBe(2);
  });
});

describe("Tracker", () => {
  const tracker = (rule: Partial<ReturnType<typeof make_rule>> = {}) => new Tracker({ m: make_rule({ channels: ["desk"], ...rule }) });

  it("announces a failure then its recovery", () => {
    const t = tracker();
    expect(t.observe("m", "online", 0)).toBeNull();
    expect(t.observe("m", "failed", 10)).toEqual(alert(PROBLEM, "failed", 10));
    expect(t.observe("m", "failed", 20)).toBeNull();
    expect(t.observe("m", "online", 30)).toEqual(alert(RECOVERED, "online", 10));
    expect(t.observe("m", "online", 40)).toBeNull();
  });

  it("lets unavailable neither recover nor interrupt a problem", () => {
    const t = tracker({ after: 2 });
    expect(t.observe("m", "failed", 0)).toBeNull();
    expect(t.observe("m", "unavailable", 1)).toBeNull();
    expect(t.observe("m", "failed", 2)).toEqual(alert(PROBLEM, "failed", 0));
    expect(t.observe("m", "unavailable", 3)).toBeNull();
    expect(t.observe("m", "online", 4)).toEqual(alert(RECOVERED, "online", 0));
  });

  it("counts unavailable when it is in on, and info ends a problem like online", () => {
    const t = tracker({ on: new Set(["failed", "unavailable"]) });
    expect(t.observe("m", "unavailable", 0)).toEqual(alert(PROBLEM, "unavailable", 0));
    expect(t.observe("m", "online", 1)).toEqual(alert(RECOVERED, "online", 0));
    const info = tracker();
    info.observe("m", "failed", 0);
    expect(info.observe("m", "info", 1)).toEqual(alert(RECOVERED, "info", 0));
  });

  it("ignores statuses outside on and monitors without a rule", () => {
    const t = tracker();
    expect(t.observe("m", "warning", 0)).toBeNull();
    expect(t.observe("m", "unavailable", 1)).toBeNull();
    expect(t.observe("other", "failed", 0)).toBeNull();
  });

  it("waits for after consecutive problem cycles", () => {
    const t = tracker({ after: 3 });
    expect(t.observe("m", "failed", 0)).toBeNull();
    expect(t.observe("m", "failed", 1)).toBeNull();
    expect(t.observe("m", "online", 2)).toBeNull();
    expect(t.observe("m", "failed", 3)).toBeNull();
    expect(t.observe("m", "failed", 4)).toBeNull();
    expect(t.observe("m", "failed", 5)).toEqual(alert(PROBLEM, "failed", 3));
  });

  it("waits until the problem has lasted for its hold, and needs both hold and after", () => {
    const t = tracker({ hold: 3600 });
    expect(t.observe("m", "failed", 0)).toBeNull();
    expect(t.observe("m", "failed", 1800)).toBeNull();
    expect(t.observe("m", "online", 1900)).toBeNull();
    expect(t.observe("m", "failed", 2000)).toBeNull();
    expect(t.observe("m", "failed", 5599)).toBeNull();
    expect(t.observe("m", "failed", 5600)).toEqual(alert(PROBLEM, "failed", 2000));
    const both = tracker({ hold: 60, after: 3 });
    expect(both.observe("m", "failed", 0)).toBeNull();
    expect(both.observe("m", "failed", 120)).toBeNull();
    expect(both.observe("m", "failed", 121)?.kind).toBe(PROBLEM);
  });

  it("reminds while the problem lasts, escalates, and can skip the recovery", () => {
    const t = tracker({ repeat: 60 });
    t.observe("m", "failed", 0);
    expect(t.observe("m", "failed", 59)).toBeNull();
    expect(t.observe("m", "failed", 60)).toEqual(alert(REMINDER, "failed", 0));
    expect(t.observe("m", "failed", 100)).toBeNull();
    const escalating = tracker({ on: new Set(["warning", "failed"]) });
    expect(escalating.observe("m", "warning", 0)?.kind).toBe(PROBLEM);
    expect(escalating.observe("m", "failed", 1)).toEqual(alert(PROBLEM, "failed", 0));
    expect(escalating.observe("m", "warning", 2)).toBeNull();
    const quiet = tracker({ recovery: false });
    quiet.observe("m", "failed", 0);
    expect(quiet.observe("m", "online", 1)).toBeNull();
  });

  it("does not announce a seeded problem again", () => {
    const t = tracker();
    t.seed("m", "failed", 5, 100);
    expect(t.observe("m", "failed", 110)).toBeNull();
    expect(t.observe("m", "online", 120)).toEqual(alert(RECOVERED, "online", 5));
  });

  it("announces flapping once, then holds until it settles", () => {
    const t = tracker({ flap_changes: 4, flap_window: 600 });
    expect(t.observe("m", "failed", 0)?.kind).toBe(PROBLEM);
    expect(t.observe("m", "online", 60)?.kind).toBe(RECOVERED);
    expect(t.observe("m", "failed", 120)?.kind).toBe(PROBLEM);
    expect(t.observe("m", "online", 180)).toEqual(alert(FLAPPING, "online", 120));
    expect(t.flapping("m")).toBe(true);
    expect(t.observe("m", "failed", 240)).toBeNull();
    expect(t.observe("m", "online", 300)).toBeNull();
    expect(t.observe("m", "failed", 360)).toBeNull();
    expect(t.observe("m", "failed", 959)).toBeNull();
    expect(t.observe("m", "failed", 961)).toEqual(alert(SETTLED, "failed", 360));
    expect(t.flapping("m")).toBe(false);
    expect(t.observe("m", "online", 1000)).toEqual(alert(RECOVERED, "online", 360));
  });

  it("says a flapping monitor that settles healthy recovered, and forgets changes outside the window", () => {
    const t = tracker({ flap_changes: 2, flap_window: 100 });
    t.observe("m", "failed", 0);
    expect(t.observe("m", "online", 10)?.kind).toBe(FLAPPING);
    expect(t.observe("m", "online", 50)).toBeNull();
    expect(t.observe("m", "online", 111)).toEqual(alert(RECOVERED, "online", 0, true));
    const outside = tracker({ flap_changes: 3, flap_window: 100 });
    outside.observe("m", "failed", 0);
    outside.observe("m", "online", 50);
    expect(outside.observe("m", "failed", 200)?.kind).toBe(PROBLEM);
  });
});

// ── Engine ───────────────────────────────────────────────────────────────────

describe("NotificationEngine", () => {
  let db: DatabaseManager;
  let engine: NotificationEngine;
  let desk: RecordingChannel;

  beforeEach(() => {
    db = new DatabaseManager();
    engine = new NotificationEngine(db, { base_url: "https://x-monitor.lan/" }, null);
    engine.retry_delays = [0, 0];
    desk = new RecordingChannel();
    engine.channels = new Map([["desk", desk]]);
  });

  afterEach(() => engine.stop());

  const titles = () => desk.sent.map((message) => message.title);
  const set = async (...statuses: string[]) => {
    for (const status of statuses) {
      db.insert_status("nas", status);
      await drain();
    }
  };
  const window_now = (extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    engine.windows = [window({ name: "Upgrades", start: new Date(now - 3600_000), end: new Date(now + 3600_000), ...extra })];
  };

  it("notifies on status writes through the change bus", async () => {
    engine.start([plugin("nas")]);
    db.write_event("host.lan", "nas", "Nas", "Pool tank is DEGRADED", "ERROR");
    db.insert_status("nas", "failed");
    await drain();
    expect(desk.sent).toHaveLength(1);
    const message = desk.sent[0]!;
    expect(message.title).toBe("Nas is failed");
    expect(message.body).toBe("Pool tank is DEGRADED\nHost: host.lan");
    expect(message.url).toBe("https://x-monitor.lan/monitor/nas");
    expect([message.monitor_name, message.host]).toEqual(["Nas", "host.lan"]);
    expect(message.timestamp).toBeGreaterThan(0);
    expect(message.key).toBe("failed");
    await set("online");
    expect(desk.sent.at(-1)!.title).toBe("Nas recovered");
    expect(desk.sent.at(-1)!.key).toBe("recovered");
  });

  it("reads a recovery into info as recovered", async () => {
    engine.start([plugin("nas")]);
    await set("failed", "info");
    expect(titles().at(-1)).toBe("Nas recovered");
  });

  it("does not announce a status held before a restart, but still announces its recovery", async () => {
    db.insert_status("nas", "failed");
    engine.start([plugin("nas")]);
    await set("failed");
    expect(titles()).toEqual([]);
    await set("online");
    expect(titles()).toEqual(["Nas recovered"]);
  });

  it("retries a failed delivery and reports one that keeps failing as an event", async () => {
    desk = new RecordingChannel("desk", 2);
    engine.channels = new Map([["desk", desk]]);
    engine.start([plugin("nas")]);
    await set("failed");
    expect(desk.sent).toHaveLength(1);

    const broken = new RecordingChannel("desk", 99);
    engine.channels = new Map([["desk", broken]]);
    await set("online", "failed");
    const messages = db.store.plugin_events("nas").map((event) => event.message);
    expect(messages.some((message) => message.includes("Could not notify \"desk\""))).toBe(true);
  });

  it("sends nothing for a muted monitor", async () => {
    engine.start([plugin("nas")]);
    engine.set_muted("nas", true);
    await set("failed", "online");
    expect(titles()).toEqual([]);
  });

  it("sends no recovery for a failure unmuted mid-problem that was never announced", async () => {
    engine.start([plugin("nas")]);
    engine.set_muted("nas", true);
    await set("failed");
    engine.set_muted("nas", false);
    await set("online", "failed");
    expect(titles()).toEqual(["Nas is failed"]);
  });

  it("silences the recovery after a mute, except on a channel that dismisses", async () => {
    const clearing = new RecordingChannel("clear");
    clearing.dismisses_on_recovery = true;
    engine.channels.set("clear", clearing);
    engine.start([plugin("nas")]);
    await set("failed");
    engine.set_muted("nas", true);
    await set("online");
    expect(titles()).toEqual(["Nas is failed"]);
    expect(clearing.sent.map((message) => message.kind)).toEqual(["problem", "recovered"]);
  });

  it("mutes everything in a muted group, and what it only links to", async () => {
    engine.start([plugin("storage", [plugin("nas")], "group")]);
    engine.set_muted("storage", true);
    expect(engine.muted_by("nas")).toBe("storage");
    await set("failed");
    expect(titles()).toEqual([]);
    expect(engine.muted_monitors().map((monitor) => monitor.id)).toEqual(["storage"]);

    const other = new NotificationEngine(new DatabaseManager(), {}, null);
    other.channels = new Map([["desk", new RecordingChannel()]]);
    const nas = plugin("nas");
    const storage = plugin("storage", [nas], "group");
    storage.links = { nas: "Host" };
    other.start([plugin("host", [nas], "group"), storage]);
    other.set_muted("storage", true);
    expect(other.muted_by("nas")).toBe("storage");
    other.stop();
  });

  it("announces a problem during maintenance once the window ends", async () => {
    engine.start([plugin("nas")]);
    window_now();
    expect(engine.maintenance_for("nas")).toBe("Upgrades");
    await set("failed", "failed");
    expect(titles()).toEqual([]);
    engine.windows = [];
    await set("failed");
    expect(titles()).toEqual(["Nas is failed"]);
    await set("online");
    expect(titles()).toEqual(["Nas is failed", "Nas recovered"]);
  });

  it("never sends a problem that ends inside the window", async () => {
    engine.start([plugin("nas")]);
    window_now();
    await set("failed", "online");
    engine.windows = [];
    await set("online");
    expect(titles()).toEqual([]);
  });

  it("covers only a group's monitors with a window on the group", async () => {
    engine.start([plugin("storage", [plugin("nas")], "group"), plugin("web")]);
    window_now({ monitors: ["storage"] });
    expect(engine.maintenance_for("nas")).toBe("Upgrades");
    expect(engine.maintenance_for("web")).toBeNull();
    db.insert_status("nas", "failed");
    db.insert_status("web", "failed");
    await drain();
    expect(titles()).toEqual(["Web is failed"]);
  });

  it("says when a monitor flaps", async () => {
    engine.start([plugin("nas")]);
    engine.tracker.rules.set("nas", make_rule({ channels: ["desk"], flap_changes: 2, flap_window: 3600 }));
    await set("failed", "online");
    expect(titles()).toEqual(["Nas is failed", "Nas is flapping"]);
    expect(desk.sent.at(-1)!.body).toContain("holds steady for 1 Hour");
  });

  it("sends notifications arriving together as one digest, and a lone one as itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const grouped = new NotificationEngine(db, { base_url: "https://v", group_window: 1 }, null);
      const batches: [Message[], Message][] = [];
      const channel: Sender = { id: "desk", send: async () => {}, send_batch: async (messages, summary) => void batches.push([messages, summary]) };
      grouped.channels = new Map([["desk", channel]]);
      grouped.start([plugin("nas"), plugin("web"), plugin("dns")]);
      db.insert_status("nas", "failed");
      db.insert_status("web", "failed");
      db.insert_status("dns", "warning");
      await drain();
      expect(batches).toEqual([]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(batches).toHaveLength(1);
      const [messages, summary] = batches[0]!;
      expect(messages.map((message) => message.monitor_id)).toEqual(["nas", "web"]);
      expect(summary.title).toBe("X-Monitor: 2 failed");
      expect(summary.body).toBe("• Nas is failed\n• Web is failed");
      expect(summary.url).toBe("https://v");
      grouped.stop();

      const lone = new NotificationEngine(new DatabaseManager(), { group_window: 1 }, null);
      const recorder = new RecordingChannel();
      lone.channels = new Map([["desk", recorder]]);
      lone.start([plugin("nas")]);
      (lone as unknown as { db: DatabaseManager }).db.insert_status("nas", "failed");
      await drain();
      await vi.advanceTimersByTimeAsync(1100);
      expect(recorder.sent.map((message) => message.title)).toEqual(["Nas is failed"]);
      lone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a summary once to each channel its monitors use, unless muted", async () => {
    const phone = new RecordingChannel("phone");
    const mail = new RecordingChannel("mail");
    engine.channels = new Map<string, Sender>([["desk", desk], ["phone", phone], ["mail", mail]]);
    engine.start([plugin("nas"), plugin("web"), plugin("dns")]);
    engine.tracker.rules.set("nas", make_rule({ channels: ["desk"] }));
    engine.tracker.rules.set("web", make_rule({ channels: ["desk", "phone"] }));
    engine.tracker.rules.set("dns", make_rule({ channels: ["mail"] }));
    engine.set_muted("dns", true);
    engine.send_summary("odin is back", "Nas: failed at 02:10", ["nas", "web", "dns"], "failed");
    await drain();
    expect(titles()).toEqual(["odin is back"]);
    expect(phone.sent.map((message) => message.kind)).toEqual(["summary"]);
    expect(mail.sent).toEqual([]);
  });

  it("watches nothing without channels", () => {
    const empty = new NotificationEngine(db, {}, null);
    empty.start([plugin("nas")]);
    expect(empty.watching).toBe(false);
  });

  it("escapes the id in a monitor's link", () => {
    expect(monitor_url("http://v:8080", "a b/c")).toBe("http://v:8080/monitor/a%20b%2Fc");
    expect(monitor_url(null, "a")).toBeNull();
  });
});

// ── Desktop channel ──────────────────────────────────────────────────────────

type Frame = Record<string, unknown>;

function directory(capabilities: string[] = ["notify"]): { agents: AgentDirectory; sent: Frame[] } {
  const sent: Frame[] = [];
  const agent: DesktopAgent = {
    capabilities,
    notify: async (title, body, urgency, url, icon, key, timeout) => void sent.push({ t: "notify", title, body, urgency, url, icon, key, timeout }),
    dismiss: async (key) => void sent.push({ t: "dismiss", key }),
  };
  return { agents: { get: (agent_id) => (agent_id === "desktop" ? agent : null) }, sent };
}

const problem = (title: string, monitor_id = "", extra: Partial<ConstructorParameters<typeof Message>[0]> = {}) =>
  new Message({ title, body: "b", status: "failed", kind: PROBLEM, monitor_id, ...extra });
const recovered = (title: string, monitor_id = "") => new Message({ title, body: "b", status: "online", kind: RECOVERED, monitor_id });

describe("DesktopChannel", () => {
  it("asks the agent to show the notification", async () => {
    const { agents, sent } = directory();
    await new DesktopChannel("desk", { agent: "desktop" }, agents).send(new Message({ title: "Nas is failed", body: "why", status: "failed", kind: PROBLEM, monitor_id: "nas", url: "https://v/monitor/nas" }));
    expect(sent).toEqual([{ t: "notify", title: "Nas is failed", body: "why", urgency: "critical", url: "https://v/monitor/nas", icon: "x-monitor", key: "nas", timeout: 30 }]);
  });

  it("takes a changed timeout or none", async () => {
    for (const [setting, expected] of [["2m", 120], [0, 0]] as const) {
      const { agents, sent } = directory();
      await new DesktopChannel("desk", { agent: "desktop", timeout: setting }, agents).send(problem("t", "nas"));
      expect(sent[0]!.timeout).toBe(expected);
    }
  });

  it("dismisses the monitor's notification on recovery, or shows the recovery when it cannot", async () => {
    const { agents, sent } = directory(["notify", "dismiss"]);
    await new DesktopChannel("desk", { agent: "desktop" }, agents).send(recovered("Nas recovered", "nas"));
    expect(sent).toEqual([{ t: "dismiss", key: "nas" }]);
    for (const [capabilities, config] of [[["notify", "dismiss"], { dismiss_on_recovery: false }], [["notify"], {}]] as const) {
      const other = directory([...capabilities]);
      await new DesktopChannel("desk", { agent: "desktop", ...config }, other.agents).send(recovered("Nas recovered", "nas"));
      expect(other.sent.map((frame) => [frame.t, frame.title])).toEqual([["notify", "Nas recovered"]]);
    }
  });

  it("takes icon and urgency once or per status", async () => {
    const { agents, sent } = directory();
    const channel = new DesktopChannel("desk", { agent: "desktop", icon: "dialog-warning", urgency: { failed: "normal" } }, agents);
    await channel.send(problem("t"));
    await channel.send(recovered("t"));
    expect(sent.map((frame) => [frame.icon, frame.urgency])).toEqual([["dialog-warning", "normal"], ["dialog-warning", "low"]]);
  });

  it("shows a batch as one group notification that shrinks and closes", async () => {
    const { agents, sent } = directory(["notify", "dismiss"]);
    const channel = new DesktopChannel("desk", { agent: "desktop" }, agents);
    const failed = ["nas", "web", "dns"].map((name) => problem(`${name} is failed`, name, { monitor_name: name, timestamp: 100 }));
    await channel.send_batch(failed, digest(failed, "https://v"));
    expect(sent).toHaveLength(1);
    expect([sent[0]!.key, sent[0]!.title, sent[0]!.url]).toEqual(["group:nas:100", "X-Monitor: 3 failed", "https://v"]);

    await channel.send(recovered("nas recovered", "nas"));
    expect([sent.at(-1)!.key, sent.at(-1)!.title]).toEqual(["group:nas:100", "X-Monitor: 2 failed"]);
    await channel.send(new Message({ title: "web is still failed", body: "b", status: "failed", kind: REMINDER, monitor_id: "web" }));
    expect(sent.slice(-2).map((frame) => [frame.t, frame.title])).toEqual([["notify", "X-Monitor: 1 failed"], ["notify", "web is still failed"]]);
    await channel.send(recovered("dns recovered", "dns"));
    expect(sent.at(-1)).toEqual({ t: "dismiss", key: "group:nas:100" });
    await channel.send(recovered("web recovered", "web"));
    expect(sent.at(-1)).toEqual({ t: "dismiss", key: "web" });
  });

  it("shows a batch with one problem on its own", async () => {
    const { agents, sent } = directory(["notify", "dismiss"]);
    const batch = [problem("nas is failed", "nas"), recovered("web recovered", "web")];
    await new DesktopChannel("desk", { agent: "desktop" }, agents).send_batch(batch, digest(batch, null));
    expect(sent.map((frame) => [frame.t, frame.key])).toEqual([["notify", "nas"], ["dismiss", "web"]]);
  });

  it("refuses a bad icon or urgency", () => {
    const { agents } = directory();
    expect(() => new DesktopChannel("desk", { agent: "desktop", urgency: "urgent" }, agents)).toThrow("low, normal or critical");
    expect(() => new DesktopChannel("desk", { agent: "desktop", icon: { down: "x" } }, agents)).toThrow("keys must be");
  });

  it("skips bad entries when building channels", () => {
    const { agents } = directory();
    const channels = build_channels([
      { id: "desk", type: "desktop", agent: "desktop" },
      { id: "nowhere", type: "desktop", agent: "missing" },
      { id: "mystery", type: "carrier-pigeon" },
      { id: "desk", type: "desktop", agent: "desktop" },
    ], agents);
    expect([...channels.keys()]).toEqual(["desk"]);
  });
});
