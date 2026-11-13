// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeaderActionView } from "../../src/shared/page_view.ts";
import { calls } from "../../src/web/api.ts";
import { MonitorPage } from "../../src/web/views/monitor.tsx";
import { Hosted, page_of, reply } from "./page_fixtures.tsx";

vi.mock("../../src/web/api.ts", async (original) => {
  const actual = await original<typeof import("../../src/web/api.ts")>();
  return { ...actual, calls: Object.fromEntries(Object.keys(actual.calls).map((name) => [name, vi.fn()])) };
});

const mocked = calls as unknown as Record<keyof typeof calls, ReturnType<typeof vi.fn>>;

function action(fields: Partial<HeaderActionView>): HeaderActionView {
  return { action_id: "switch", name: "Rebuild", icon: "play_arrow", danger: false, kind: null, dialog: null, confirm: null, more: false, state: "normal", toggle: null, ...fields };
}

function draw(fields: Parameters<typeof page_of>[0] = {}, reload = vi.fn()) {
  render(<Hosted><MonitorPage view={page_of(fields)} reload={reload} /></Hosted>);
  return reload;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("Poll Now", () => {
  it("says Polling... while the poll runs and tells the viewer when it finishes", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocked.poll.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Poll Now" }));
    expect(screen.getByRole("button", { name: "Polling..." })).toBeTruthy();
    await act(async () => finish({ polled: true }));
    expect(await screen.findByText("Host polled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Poll Now" })).toBeTruthy();
  });
});

describe("a toggle", () => {
  const toggle = (pressed: boolean | null) => action({ action_id: "start_on_boot", name: "Start on Boot", kind: "toggle", toggle: { pressed, on_action_id: "enable_service", off_action_id: "disable_service" } });

  it("is pressed while the state is on and released while off", () => {
    draw({ actions: [toggle(true)] });
    expect(screen.getByRole("button", { name: "Start on Boot" }).getAttribute("aria-pressed")).toBe("true");
    cleanup();
    draw({ actions: [toggle(false)] });
    expect(screen.getByRole("button", { name: "Start on Boot" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("runs the on action from released and shows what came back", async () => {
    mocked.toggle.mockResolvedValue(reply({ notice: "Start on Boot: on" }));
    draw({ actions: [toggle(false)] });
    fireEvent.click(screen.getByRole("button", { name: "Start on Boot" }));
    expect(await screen.findByText("Start on Boot: on")).toBeTruthy();
    expect(mocked.toggle).toHaveBeenCalledWith("host", { action_id: "enable_service", wanted: true, label: "Start on Boot" });
  });

  it("is disabled before the state is known", () => {
    draw({ actions: [toggle(null)] });
    expect((screen.getByRole("button", { name: "Start on Boot" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("an action button", () => {
  it("runs a normal action and shows its notice", async () => {
    mocked.run_action.mockResolvedValue(reply({ notice: "Rebuild succeeded" }));
    draw({ actions: [action({})] });
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(await screen.findByText("Rebuild succeeded")).toBeTruthy();
  });

  it("asks first when it has a confirm question, and runs nothing on Cancel", async () => {
    draw({ actions: [action({ confirm: "Rebuild now?" })] });
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(await screen.findByText("Rebuild now?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Rebuild now?")).toBeNull());
    expect(mocked.run_action).not.toHaveBeenCalled();
  });

  it("is greyed out while disabled and ignores clicks while running", () => {
    draw({ actions: [action({ state: "disabled" }), action({ action_id: "verify", name: "Verify", state: "accent" })] });
    expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(mocked.run_action).not.toHaveBeenCalled();
  });

  it("is not shown while hidden", () => {
    draw({ actions: [action({ state: "hidden" })] });
    expect(screen.queryByRole("button", { name: "Rebuild" })).toBeNull();
  });

  it("opens the live log of a detached job it started", async () => {
    mocked.run_action.mockResolvedValue(reply({ notice: "Sync started", job_id: 9 }));
    mocked.job_log.mockResolvedValue({ id: 9, title: "Sync log", summary: "Started now · running", command: "sync-all", error: null, running: false, lines: [{ seq: 0, stream: "stdout", message: "copied 1", timestamp: "" }] });
    draw({ actions: [action({ action_id: "custom:sync", name: "Sync" })] });
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Sync log")).toBeTruthy();
    expect(await screen.findByText("copied 1")).toBeTruthy();
  });
});

describe("the header's other buttons", () => {
  it("come in order: Poll Now, the actions, Cancel, then Notifications", () => {
    draw({ actions: [action({})], cancel: { present: true, visible: true }, mute: { present: true, maintenance: null, muted_by: null, sending: true } });
    expect(screen.getAllByRole("button").map((button) => button.textContent).slice(0, 4)).toEqual(["Poll Now", "Rebuild", "Cancel", "Notifications"]);
  });

  it("hide Cancel while no job runs", () => {
    draw({ actions: [action({})], cancel: { present: true, visible: false } });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("cancel the running job", async () => {
    mocked.cancel.mockResolvedValue(reply({ notice: "Cancellation requested", tone: "warning" }));
    draw({ actions: [action({})], cancel: { present: true, visible: true } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Cancellation requested")).toBeTruthy();
  });

  it("hold the less used actions under More, a running one filling it", () => {
    draw({ actions: [action({}), action({ action_id: "prune", name: "Prune", more: true, danger: true })], more: { visible: true, filled: true } });
    expect(screen.queryByRole("button", { name: "Prune" })).toBeNull();
    expect(screen.getByRole("button", { name: "More" }).className).toContain("accent");
  });

  it("say which group mutes the monitor", () => {
    draw({ mute: { present: true, maintenance: "Patch night", muted_by: "Site", sending: false } });
    expect((screen.getByRole("button", { name: "Muted by Site" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "In maintenance: Patch night" })).toBeTruthy();
  });
});
