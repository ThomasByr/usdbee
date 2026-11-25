import { describe, expect, it } from "vitest";
import type { PrimNode } from "./types";
import { collectPaths, collectSubtreeGprims, filterTree, isGprim } from "./treeUtils";

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

describe("isGprim", () => {
  it("classifies exactly the families the render manifest tessellates", () => {
    expect(
      [
        "Mesh",
        "BasisCurves",
        "NurbsCurves",
        "Points",
        "Sphere",
        "Cube",
        "Plane",
        "Cylinder",
        "Cylinder_1",
        "Cone",
        "Capsule",
        "Capsule_1",
      ]
        .map((type) => leaf("/A", type, type))
        .map(isGprim),
    ).toEqual([true, true, true, true, true, true, true, true, true, true, true, true]);
    expect(
      ["Xform", "Scope", "Material", "PointInstancer", ""].map((type) => leaf("/A", type, type)).map(isGprim),
    ).toEqual([false, false, false, false, false]);
  });
});

describe("collectSubtreeGprims", () => {
  const branch: PrimNode = {
    ...leaf("/World", "World", "Xform"),
    children: [
      leaf("/World/Ball", "Ball"),
      leaf("/World/Stroke", "Stroke", "BasisCurves"),
      leaf("/World/Cloud", "Cloud", "Points"),
      leaf("/World/Bead", "Bead", "Sphere"),
      {
        ...leaf("/World/Group", "Group", "Xform"),
        children: [leaf("/World/Group/Cube", "Cube")],
      },
      { ...leaf("/World/InstBall", "InstBall"), is_instance: true },
      {
        ...leaf("/World/Looks", "Looks", "Scope"),
        children: [leaf("/World/Looks/Mat", "Mat", "Material")],
      },
    ],
  };
  const tree: PrimNode[] = [{ ...root, children: [branch] }];

  it("collects every subtree gprim depth-first, root gprim inclusive", () => {
    expect(collectSubtreeGprims(tree, "/World").paths).toEqual([
      "/World/Ball",
      "/World/Stroke",
      "/World/Cloud",
      "/World/Bead",
      "/World/Group/Cube",
    ]);
    expect(collectSubtreeGprims(tree, "/World/Group/Cube").paths).toEqual(["/World/Group/Cube"]);
  });

  it("excludes xforms, scopes and materials from the paths", () => {
    const paths = collectSubtreeGprims(tree, "/World").paths;
    expect(paths).not.toContain("/World/Group");
    expect(paths).not.toContain("/World/Looks");
    expect(paths).not.toContain("/World/Looks/Mat");
  });

  it("skips instance gprims and reports them instead of collecting", () => {
    const { paths, skippedInstances } = collectSubtreeGprims(tree, "/World");
    expect(paths).not.toContain("/World/InstBall");
    expect(skippedInstances).toEqual(["/World/InstBall"]);
  });

  it("reports an instance subtree root without collecting it", () => {
    const result = collectSubtreeGprims(tree, "/World/InstBall");
    expect(result.paths).toEqual([]);
    expect(result.skippedInstances).toEqual(["/World/InstBall"]);
  });

  it("collects nothing for a path that is not in the tree", () => {
    const result = collectSubtreeGprims(tree, "/Nope");
    expect(result.paths).toEqual([]);
    expect(result.skippedInstances).toEqual([]);
  });
});
