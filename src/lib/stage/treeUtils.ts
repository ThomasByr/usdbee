import type { PrimNode } from "./types";

// Returns nodes matching the query (name, path, or type_name, case-insensitive),
// keeping ancestors of matches. A matching node keeps its full subtree.
export function filterTree(nodes: PrimNode[], query: string): PrimNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: PrimNode[] = [];
  for (const node of nodes) {
    const selfMatch =
      node.name.toLowerCase().includes(q) ||
      node.path.toLowerCase().includes(q) ||
      node.type_name.toLowerCase().includes(q);
    if (selfMatch) {
      out.push(node);
    } else {
      const children = filterTree(node.children, q);
      if (children.length > 0) out.push({ ...node, children });
    }
  }
  return out;
}

export function collectPaths(nodes: PrimNode[]): string[] {
  return nodes.flatMap((n) => [n.path, ...collectPaths(n.children)]);
}

// Exact type names the render manifest treats as renderable geometry —
// the frontend mirror of stage.rs `renders_geometry`, not a second
// classification.
const GPRIM_TYPES = new Set([
  "Mesh",
  "BasisCurves",
  "NurbsCurves",
  "Points",
  "Sphere",
  "Cube",
  "Plane",
  "Cylinder",
  "Cone",
  "Capsule",
]);

export function isGprim(node: PrimNode): boolean {
  return GPRIM_TYPES.has(node.type_name);
}

export interface SubtreeGprims {
  paths: string[];
  // Instance gprims the backend edit arms reject ("edit the prototype"):
  // reported so the branch summary can mention them, never attempted.
  skippedInstances: string[];
}

// The gprim paths under `path` (inclusive) in the stage tree, for branch
// appearance application. Instance prims are skipped and reported — the
// backend refuses edits on them — and non-gprims (xforms, scopes,
// materials) are not appearance targets.
export function collectSubtreeGprims(nodes: PrimNode[], path: string): SubtreeGprims {
  const out: SubtreeGprims = { paths: [], skippedInstances: [] };
  const walk = (node: PrimNode): void => {
    if (!isGprim(node)) {
      node.children.forEach(walk);
      return;
    }
    if (node.is_instance) {
      out.skippedInstances.push(node.path);
      return;
    }
    out.paths.push(node.path);
    node.children.forEach(walk);
  };
  const find = (entries: PrimNode[]): boolean => {
    for (const node of entries) {
      if (node.path === path) {
        walk(node);
        return true;
      }
      if (find(node.children)) return true;
    }
    return false;
  };
  find(nodes);
  return out;
}
