import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Connections, parse_states } from "../../src/monitors/connections.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-connections", id: "test-connections", ssh_config: { host: "test.host" } };
const tcp_header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function make_tcp(states: string[]): string {
  return tcp_header + states.map((state, index) => `   ${index}: 0100007F:0050 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 0\n`).join("");
}

const connections = (extra: PluginConfig = {}): Connections => make_plugin(Connections, { ...config, ...extra });
const latest_status = (plugin: Connections) => store_of(plugin).latest_status("test-connections");
const latest_metric = (plugin: Connections, name: string) => store_of(plugin).latest_metric("test-connections", name)?.value ?? null;
const total = (counts: Map<string, number>) => [...counts.values()].reduce((sum, count) => sum + count, 0);

describe("parse states", () => {
  it("counts established and listening sockets", () => {
    const counts = parse_states(make_tcp(["01", "01", "0A"]));
    expect(counts.get("ESTABLISHED")).toBe(2);
    expect(counts.get("LISTEN")).toBe(1);
  });

  it("ignores the header", () => expect(total(parse_states(make_tcp(["01"])))).toBe(1));
  it("handles lower-case hex", () => expect(parse_states(make_tcp(["0a"])).get("LISTEN")).toBe(1));
  it("ignores an unknown state", () => expect(total(parse_states(make_tcp(["FF"])))).toBe(0));
});

describe("collection", () => {
  it("records the total", () => {
    const plugin = connections();
    run_cycle(plugin, () => cmd_result(0, make_tcp(["01", "0A", "06"]), ""));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "conn_total")).toBeCloseTo(3.0);
  });

  it("warns on a high total", () => {
    const plugin = connections({ warning: 2, threshold: 10 });
    run_cycle(plugin, () => cmd_result(0, make_tcp(["01", "01", "01"]), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("calls a flood only a warning", () => {
    const plugin = connections({ warning: 2, threshold: 3 });
    run_cycle(plugin, () => cmd_result(0, make_tcp(Array<string>(50).fill("06")), ""));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("calls an unreadable table unavailable", () => {
    const plugin = connections();
    run_cycle(plugin, () => cmd_result(-1, "", "Agent 'h' is not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("records zero connections", () => {
    const plugin = connections();
    run_cycle(plugin, () => cmd_result(0, make_tcp([]), ""));
    expect(latest_metric(plugin, "conn_total")).toBeCloseTo(0.0);
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("page", () => {
  const states = ["conn_established", "conn_listen", "conn_time_wait"];

  it("colors the total card by the warning only", () => {
    expect(connections({ warning: 100, threshold: 200 }).UI_SPEC.cards!.conn_total_card.color).toEqual({ warning: 100, threshold: null });
  });

  it("shares one bar between the states", () => {
    const card = connections().UI_SPEC.cards!.conn_states_card;
    expect(card.kind).toBe("share");
    expect(card.parts!.map((part) => part.metric)).toEqual(states);
  });

  it("stacks the states on one chart", () => {
    const charts = connections().UI_SPEC.charts!;
    expect(Object.keys(charts)).toEqual(["conn_total_chart"]);
    expect(charts.conn_total_chart.style).toBe("stack");
    expect(charts.conn_total_chart.series!.map((series) => series.metric)).toEqual(states);
  });
});

describe("optional limits", () => {
  it("stays online without a warning limit", () => {
    const plugin = connections({ warning: null });
    run_cycle(plugin, () => cmd_result(0, make_tcp(Array<string>(50).fill("01")), ""));
    expect(latest_status(plugin)).toBe("online");
  });
});
