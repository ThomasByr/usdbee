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
