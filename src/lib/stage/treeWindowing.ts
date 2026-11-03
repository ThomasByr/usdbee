import type { PrimNode } from "./types";

// Uniform row pitch of the prim tree (tree-row height, .tree-node-label
// pinned to the same value in page.css). Single-line rows: nowrap label,
// badges inline — nothing wraps, so every row is exactly this tall.
export const ROW_HEIGHT = 28;

// Extra rows rendered above and below the viewport so fast scrolling does
// not flash blank rows.
export const OVERSCAN = 8;

export interface TreeRow {
  node: PrimNode;
  depth: number;
}

// The flat render list: exactly the rows the old recursive render produced,
// depth-first, descending only into open (expanded or forceOpen) nodes.
export function flattenTree(
  nodes: PrimNode[],
  expandedPaths: Record<string, boolean>,
  forceOpen = false,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (entries: PrimNode[], depth: number): void => {
    for (const node of entries) {
      rows.push({ node, depth });
      if (node.children.length > 0 && (forceOpen || expandedPaths[node.path] === true)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return rows;
}

export interface RowRange {
  start: number;
  end: number;
}

// The half-open [start, end) slice of rows to mount for the current scroll
// state, clamped to the list on both ends.
export function visibleRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): RowRange {
  if (rowCount === 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start: Math.min(start, end), end };
}

// The scrollTop that brings row `rowIndex` fully into view, or null when it
// already is (or the index is out of range). Top-aligns rows above the
// viewport, bottom-aligns rows below it, and never scrolls past the end.
export function ensureRowVisible(
  rowCount: number,
  rowIndex: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number | null {
  if (rowIndex < 0 || rowIndex >= rowCount) return null;
  const top = rowIndex * rowHeight;
  const bottom = top + rowHeight;
  if (top >= scrollTop && bottom <= scrollTop + viewportHeight) return null;
  const maxScroll = Math.max(0, rowCount * rowHeight - viewportHeight);
  if (top < scrollTop) return Math.min(top, maxScroll);
  return Math.min(bottom - viewportHeight, maxScroll);
}
