import { beforeEach, describe, expect, it } from "vitest";

import { all_monitors, child_label, Link, parent_ids, resolve_links, type GraphNode } from "../../../src/core/coordination/monitor_graph.ts";
import { capture_logs } from "../log_capture.ts";

const caplog = capture_logs();

function node(id: string, ...children: (GraphNode | Link)[]): GraphNode {
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1).replace(/-(.)/g, (_, letter: string) => `-${letter.toUpperCase()}`), children: children as GraphNode[], links: new Map() };
}

let host_a: GraphNode;
let host_b: GraphNode;
let domain: GraphNode;
let roots: GraphNode[];

// Two hosts each holding a cpu, and a second root grouping both cpus under one domain.
beforeEach(() => {
  host_a = node("a", node("a-cpu"));
  host_b = node("b", node("b-cpu"));
  domain = node("compute", new Link("a-cpu", "A"), new Link("b-cpu", "B"));
  roots = resolve_links([node("by-host", host_a, host_b), node("by-domain", domain)]);
});

describe("resolving links", () => {
  it("makes a link the same monitor its definition made", () => {
    expect(domain.children).toEqual([host_a.children[0], host_b.children[0]]);
    expect(domain.children[0]).toBe(host_a.children[0]);
  });

  it("labels only the link's own edge", () => {
    const cpu = host_a.children[0];
    expect(child_label(domain, cpu)).toBe("A");
    expect(child_label(host_a, cpu)).toBe("A-Cpu");
  });

  it("shows the monitor's name for a link without one", () => {
    const host = node("a", node("a-cpu"));
    const group = node("compute", new Link("a-cpu"));
    resolve_links([host, group]);
    expect(child_label(group, host.children[0])).toBe("A-Cpu");
  });

  it("lets a link name a monitor defined later", () => {
    const group = node("compute", new Link("a-cpu"));
    const host = node("a", node("a-cpu"));
    resolve_links([group, host]);
    expect(group.children).toEqual(host.children);
  });

  it("drops a top-level link", () => {
    const sensors = node("sensors");
    expect(resolve_links([sensors, new Link("sensors")])).toEqual([sensors]);
    expect(caplog.text()).toContain("top-level");
  });

  it("drops a link to an unknown id", () => {
    const group = node("compute", new Link("nowhere"));
    resolve_links([group]);
    expect(group.children).toEqual([]);
    expect(caplog.text()).toContain("nowhere");
  });

  it("drops a link back to an ancestor and keeps the definitions", () => {
    const leaf = node("leaf");
    const mid = node("mid", leaf);
    const root = node("root", mid);
    (leaf.children as (GraphNode | Link)[]).push(new Link("root"));
    resolve_links([node("other", new Link("leaf")), root]);
    expect(leaf.children).toEqual([]);
    expect(mid.children).toEqual([leaf]);
    expect(root.children).toEqual([mid]);
    expect(caplog.text()).toContain("cycle");
  });

  it("drops a link to itself", () => {
    const group = node("g", new Link("g"));
    resolve_links([group]);
    expect(group.children).toEqual([]);
  });
});

describe("walks", () => {
  it("visits a monitor held twice once", () => {
    expect(all_monitors({ plugins: roots }).map((plugin) => plugin.id)).toEqual(["by-host", "a", "a-cpu", "b", "b-cpu", "by-domain", "compute"]);
  });

  it("gives a monitor every group that holds it as a parent", () => {
    expect(parent_ids(roots).get("a-cpu")).toEqual(new Set(["a", "compute"]));
  });
});
