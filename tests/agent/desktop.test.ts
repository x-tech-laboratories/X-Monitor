import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { close_command, command, ICON_FILE, Notifier, type DesktopProcess } from "../../src/agent/desktop.ts";
import { CAPABILITIES } from "../../src/agent/agent.ts";

// A notify-send that prints its id, then waits for a click or a close when --wait is given.
class FakeNotifySend implements DesktopProcess {
  readonly id: number;
  private code: number | null = null;
  private rest = "";
  private done!: () => void;
  private readonly ended = new Promise<void>((resolve) => (this.done = resolve));

  constructor(id: number, waits: boolean) {
    this.id = id;
    if (!waits) this.finish("");
  }

  async first_line(): Promise<string> {
    // A real notify-send takes a moment to report the id.
    for (let index = 0; index < 3; index += 1) await Promise.resolve();
    return `${this.id}\n`;
  }

  finish(rest: string): void {
    if (this.code !== null) return;
    this.rest = rest;
    this.code = 0;
    this.done();
  }

  async finished(): Promise<[string, string]> {
    await this.ended;
    return [this.rest, ""];
  }

  exit_code(): number | null {
    return this.code;
  }

  kill(): void {
    this.finish("");
  }
}

// Stands in for notify-send, busctl and xdg-open, with a notification server behind them.
class FakeDesktop {
  readonly calls: string[][] = [];
  readonly open = new Map<number, FakeNotifySend>();
  private next_id = 100;

  readonly start = async (args: string[]): Promise<DesktopProcess> => {
    this.calls.push(args);
    if (args[0] === "notify-send") {
      const replace = args.find((arg) => arg.startsWith("--replace-id="))?.split("=")[1];
      if (replace === undefined) this.next_id += 1;
      const process = new FakeNotifySend(replace ? Number(replace) : this.next_id, args.includes("--wait"));
      this.open.set(process.id, process);
      return process;
    }
    if (args[0] === "busctl") {
      const id = Number(args.at(-1));
      this.open.get(id)?.finish("");
      this.open.delete(id);
    }
    return new FakeNotifySend(0, false);
  };

  click(id: number, action = "default\n"): void {
    const process = this.open.get(id)!;
    this.open.delete(id);
    process.finish(action);
  }

  names(): string[] {
    return this.calls.map((call) => call[0]);
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe("the icon", () => {
  it("means the bundled icon for x-monitor", () => {
    const icon = command("t", "b", "normal", null, "x-monitor").find((arg) => arg.startsWith("--icon="))!;
    expect(icon.endsWith("resources/icon.svg")).toBe(true);
    expect(existsSync(ICON_FILE)).toBe(true);
  });

  it("passes other icons through and adds no flag without one", () => {
    expect(command("t", "b", "normal", null, "dialog-error")).toContain("--icon=dialog-error");
    expect(command("t", "b", "normal", null).some((arg) => arg.startsWith("--icon"))).toBe(false);
  });
});

describe("showing a notification", () => {
  it("opens the link on a click", async () => {
    const fake = new FakeDesktop();
    const shown = new Notifier(fake.start).show({ title: "Nas is failed", body: "why", urgency: "critical", url: "https://v/monitor/nas" });
    await settle();
    fake.click(101);
    await shown;
    expect(fake.calls).toEqual([
      ["notify-send", "--app-name=X-Monitor", "--urgency=critical", "--print-id", "--action=default=Open", "--action=dismiss=Dismiss", "--wait", "--", "Nas is failed", "why"],
      ["xdg-open", "https://v/monitor/nas"],
    ]);
  });

  it("offers only Dismiss without a link and reads a bad urgency as normal", async () => {
    const fake = new FakeDesktop();
    const shown = new Notifier(fake.start).show({ title: "-t", body: "b", urgency: "bogus" });
    await settle();
    fake.click(101, "dismiss\n");
    await shown;
    expect(fake.calls).toEqual([["notify-send", "--app-name=X-Monitor", "--urgency=normal", "--print-id", "--action=dismiss=Dismiss", "--wait", "--", "-t", "b"]]);
  });

  it("opens nothing when the Dismiss button closes it", async () => {
    const fake = new FakeDesktop();
    const shown = new Notifier(fake.start).show({ title: "t", body: "b", url: "https://v" });
    await settle();
    fake.click(101, "dismiss\n");
    await shown;
    expect(fake.names()).toEqual(["notify-send"]);
  });

  it("closes it at its timeout even when critical", async () => {
    const fake = new FakeDesktop();
    await new Notifier(fake.start).show({ title: "t", body: "b", urgency: "critical", timeout: 0.05 });
    expect(fake.calls[0]).toContain("--expire-time=50");
    expect(fake.calls[1]).toEqual(close_command(101));
    expect(fake.open.size).toBe(0);
  });

  it("logs a missing notify-send rather than throwing", async () => {
    await expect(new Notifier(async () => { throw new Error("spawn notify-send ENOENT"); }).show({ title: "t", body: "b" })).resolves.toBeUndefined();
  });
});

describe("keys", () => {
  const FAILED = { title: "Nas is failed", body: "b", url: "https://v/monitor/nas", key: "nas" };

  it("close the key's notification on dismiss and open nothing", async () => {
    const fake = new FakeDesktop();
    const notifier = new Notifier(fake.start);
    const shown = notifier.show(FAILED);
    await settle();
    await notifier.dismiss({ key: "nas" });
    await shown;
    expect(fake.calls[1]).toEqual(close_command(101));
    expect(fake.names()).not.toContain("xdg-open");
    expect(fake.open.size).toBe(0);
  });

  it("let a newer notification for the key replace it", async () => {
    const fake = new FakeDesktop();
    const notifier = new Notifier(fake.start);
    const first = notifier.show(FAILED);
    await settle();
    const second = notifier.show({ ...FAILED, title: "Nas is still failed" });
    await settle();
    await first;
    expect(fake.calls[1]).toContain("--replace-id=101");
    await notifier.dismiss({ key: "nas" });
    await second;
    expect(fake.calls[2]).toEqual(close_command(101));
  });

  it("still close a replacement dismissed right after it", async () => {
    const fake = new FakeDesktop();
    const notifier = new Notifier(fake.start);
    const first = notifier.show(FAILED);
    await settle();
    const replacement = notifier.show({ ...FAILED, title: "1 failed" });
    await notifier.dismiss({ key: "nas" });
    await replacement;
    await first;
    expect(fake.calls.at(-1)).toEqual(close_command(101));
    expect(fake.open.size).toBe(0);
  });

  it("do nothing for an unknown key", async () => {
    const fake = new FakeDesktop();
    await new Notifier(fake.start).dismiss({ key: "nas" });
    expect(fake.calls).toEqual([]);
  });

  it("forget a notification the user closed", async () => {
    const fake = new FakeDesktop();
    const notifier = new Notifier(fake.start);
    const shown = notifier.show(FAILED);
    await settle();
    fake.click(101, "");
    await shown;
    await notifier.dismiss({ key: "nas" });
    expect(fake.names()).not.toContain("busctl");
  });
});

describe("the agent", () => {
  it("advertises notify and dismiss", () => {
    expect(CAPABILITIES).toEqual(expect.arrayContaining(["notify", "dismiss"]));
  });
});
