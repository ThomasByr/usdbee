import { describe, expect, it } from "vitest";
import type { PrimNode } from "./types";
import { ROW_HEIGHT, ensureRowVisible, flattenTree, visibleRange } from "./treeWindowing";

const leaf = (path: string, name: string, type_name = "Mesh"): PrimNode => ({
  path,
  name,
  type_name,
  kind: "",
  is_active: true,
  is_instance: false,
  is_abstract: false,
  children: [],
});

const tree: PrimNode[] = [
  {
    ...leaf("/Root", "Root", "Xform"),
    children: [
      {
        ...leaf("/Root/Group", "Group", "Xform"),
        children: [leaf("/Root/Group/A", "A"), leaf("/Root/Group/B", "B")],
      },
      leaf("/Root/Solo", "Solo"),
    ],
  },
  leaf("/Other", "Other", "Scope"),
];

describe("flattenTree", () => {
  it("renders only roots when nothing is expanded", () => {
    const rows = flattenTree(tree, {});
    expect(rows.map((r) => r.node.path)).toEqual(["/Root", "/Other"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it("includes expanded subtrees depth-first in render order", () => {
    const rows = flattenTree(tree, { "/Root": true, "/Root/Group": true });
    expect(rows.map((r) => r.node.path)).toEqual([
      "/Root",
      "/Root/Group",
      "/Root/Group/A",
      "/Root/Group/B",
      "/Root/Solo",
      "/Other",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1, 0]);
  });

  it("excludes a collapsed parent's children even when the parent is open", () => {
    // Group closed => its subtree disappears, but Root's other children stay.
    const rows = flattenTree(tree, { "/Root": true });
    expect(rows.map((r) => r.node.path)).toEqual(["/Root", "/Root/Group", "/Root/Solo", "/Other"]);
  });

  it("forceOpen flattens every subtree (filter behavior)", () => {
    const rows = flattenTree(tree, {}, true);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.node.path)).toContain("/Root/Group/B");
  });

  it("handles empty input", () => {
    expect(flattenTree([], {})).toEqual([]);
  });
});

describe("visibleRange", () => {
  it("returns an empty range for zero rows", () => {
    expect(visibleRange(0, 0, 400, ROW_HEIGHT, 8)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(0, 1000, 400, ROW_HEIGHT, 8)).toEqual({ start: 0, end: 0 });
  });

  it("covers a list shorter than the viewport entirely", () => {
    expect(visibleRange(5, 0, 400, ROW_HEIGHT, 8)).toEqual({ start: 0, end: 5 });
  });

  it("windows a scrolled viewport with overscan on both sides", () => {
    // 100 rows of 28px = 2800px; scrolled to 560 => rows 20..~34, overscan 8.
    const { start, end } = visibleRange(100, 560, 280, ROW_HEIGHT, 8);
    expect(start).toBe(12);
    expect(end).toBe(38);
  });

  it("clamps the last window to the row count", () => {
    const { start, end } = visibleRange(100, 100 * ROW_HEIGHT - 280, 280, ROW_HEIGHT, 8);
    expect(end).toBe(100);
    expect(start).toBeLessThan(100);
  });

  it("clamps a start scrolled past the end to an empty range", () => {
    const { start, end } = visibleRange(10, 10_000, 400, ROW_HEIGHT, 8);
    expect(end).toBe(10);
    expect(start).toBe(10);
  });

  it("never lets overscan push start below zero", () => {
    expect(visibleRange(100, 100, 400, ROW_HEIGHT, 8).start).toBe(0);
  });
});

describe("ensureRowVisible", () => {
  const rowCount = 100;

  it("returns null when the row is already fully visible", () => {
    // viewport 280px = 10 rows; rows 0..9 visible at scrollTop 0.
    expect(ensureRowVisible(rowCount, 5, 0, 280, ROW_HEIGHT)).toBeNull();
  });

  it("top-aligns a row above the viewport", () => {
    expect(ensureRowVisible(rowCount, 4, 20 * ROW_HEIGHT, 280, ROW_HEIGHT)).toBe(4 * ROW_HEIGHT);
  });

  it("bottom-aligns a row below the viewport", () => {
    const target = 26 * ROW_HEIGHT - 280;
    expect(ensureRowVisible(rowCount, 25, 0, 280, ROW_HEIGHT)).toBe(target);
  });

  it("clamps bottom-alignment to the maximum scroll offset", () => {
    // Row 99 bottom-aligned would scroll past the end; clamp to max scroll.
    const maxScroll = rowCount * ROW_HEIGHT - 280;
    expect(ensureRowVisible(rowCount, 99, 0, 280, ROW_HEIGHT)).toBe(maxScroll);
  });

  it("returns null for an out-of-range row", () => {
    expect(ensureRowVisible(rowCount, 100, 0, 280, ROW_HEIGHT)).toBeNull();
    expect(ensureRowVisible(0, 0, 0, 280, ROW_HEIGHT)).toBeNull();
  });
});
