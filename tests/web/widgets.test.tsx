// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Gauge, gauge_dash } from "../../src/web/widgets/gauge.tsx";
import { ShareBar } from "../../src/web/widgets/share_bar.tsx";
import { squarify, Treemap } from "../../src/web/widgets/treemap.tsx";

afterEach(cleanup);

describe("the gauge", () => {
  it("prints its value and says how full it is", () => {
    render(<Gauge label="CPU" value_text="78.0%" percent={78} color="var(--status-warning-text)" caption="8 cores" />);
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("78.0%")).toBeTruthy();
    expect(screen.getByText("8 cores")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "CPU" }).getAttribute("aria-valuenow")).toBe("78");
  });

  it("draws no arc when empty", () => {
    expect(gauge_dash(0)).toBeNull();
    expect(gauge_dash(50)).toMatch(/^\d+\.\d\d 999$/);
  });
});

describe("the share bar", () => {
  it("prints every part's value in the legend", () => {
    render(<ShareBar label="QUERIES" parts={[{ label: "Allowed", value_text: "3", percent: 75, color: "var(--series-1)" }, { label: "Blocked", value_text: "1", percent: 25, color: "var(--status-warning-text)" }]} />);
    expect(screen.getByText("Allowed 3")).toBeTruthy();
    expect(screen.getByText("Blocked 1")).toBeTruthy();
    expect(screen.getByRole("img", { name: "QUERIES: Allowed 3, Blocked 1" })).toBeTruthy();
  });
});

describe("the treemap", () => {
  it("fills its box with tiles whose areas are their values, largest first", () => {
    const placed = squarify([{ name: "a", value: 1 }, { name: "b", value: 3 }]);
    expect(placed.map((tile) => tile.tile.name)).toEqual(["b", "a"]);
    const areas = placed.map((tile) => tile.width * tile.height);
    expect(areas[0]).toBeCloseTo(7500);
    expect(areas[1]).toBeCloseTo(2500);
  });

  it("leaves out empty tiles and draws nothing with no total", () => {
    expect(squarify([{ value: 0 }])).toEqual([]);
  });

  it("hands back a clicked tile", () => {
    const picked = vi.fn();
    render(<Treemap label="Monitors by type" tiles={[{ name: "CPU", value: 4, color: "var(--status-danger)" }, { name: "ZFS", value: 1, color: "var(--status-success)" }]} on_select={picked} />);
    fireEvent.click(screen.getByRole("button", { name: /CPU/ }));
    expect(picked).toHaveBeenCalledWith(expect.objectContaining({ name: "CPU" }));
  });
});
