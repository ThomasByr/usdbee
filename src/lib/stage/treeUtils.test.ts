import { describe, expect, it } from "vitest";
import type { PrimNode } from "./types";
import { collectPaths, filterTree } from "./treeUtils";

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

const root: PrimNode = {
  ...leaf("/", "root", "Xform"),
  children: [
    {
      ...leaf("/Bike", "Bike", "Xform"),
      children: [leaf("/Bike/Frame", "Frame"), leaf("/Bike/Fork", "Fork")],
    },
    leaf("/Lights", "Lights", "Scope"),
  ],
};

describe("filterTree", () => {
  it("returns input unchanged on empty query", () => {
    expect(filterTree([root], "")).toEqual([root]);
    expect(filterTree([root], "   ")).toEqual([root]);
  });

  it("keeps full subtree of a self-matching node", () => {
    const out = filterTree([root], "bike");
    expect(out).toHaveLength(1);
    expect(out[0].children.map((c) => c.name)).toEqual(["Bike"]);
    expect(out[0].children[0].children).toHaveLength(2);
  });

  it("keeps ancestors of a child match and drops unmatched siblings", () => {
    const out = filterTree([root], "frame");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("root");
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children[0].name).toBe("Bike");
    expect(out[0].children[0].children.map((c) => c.name)).toEqual(["Frame"]);
  });

  it("matches type_name case-insensitively", () => {
    const out = filterTree([root], "scope");
    expect(out[0].children.map((c) => c.name)).toEqual(["Lights"]);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterTree([root], "nope")).toEqual([]);
  });

  it("does not mutate the input tree", () => {
    filterTree([root], "frame");
    expect(root.children[0].children).toHaveLength(2);
  });
});

describe("collectPaths", () => {
  it("lists every path depth-first", () => {
    expect(collectPaths([root])).toEqual(["/", "/Bike", "/Bike/Frame", "/Bike/Fork", "/Lights"]);
  });

  it("handles empty input", () => {
    expect(collectPaths([])).toEqual([]);
  });
});
