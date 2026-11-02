// composeOpUpdate tests (Phase 3, Task 4): the gizmo's delta -> op math is
// pure and pinned here. Conventions (see src/lib/render/sceneBuilder.ts):
// a USD row-major row-vector [f64; 16] and a three.js Matrix4 store the
// same 16 numbers in the same order (translation at 12-14), and the
// composed local matrix is the list-order product of the op matrices in
// three.js terms (first-listed op = most global).

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { AttributeInfo } from "../stage/types";
import { composeOpUpdate, matricesClose } from "./xformOps";

function attr(name: string, declared: string, vecType: string, data: unknown): AttributeInfo {
  return {
    name,
    type_name: declared,
    variability: "varying",
    authored: true,
    value: { type: vecType, data },
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function rotZ(deg: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationZ(rad(deg));
}

function translation(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

function scaleOf(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeScale(x, y, z);
}

// list-order product in three.js terms: first-listed op is left-most.
function compose(ops: THREE.Matrix4[]): number[] {
  const m = new THREE.Matrix4();
  for (const op of ops) m.multiply(op);
  return m.toArray() as number[];
}

function vec(data: number[]): number[] {
  return data;
}

describe("composeOpUpdate", () => {
  it("returns the unchanged op value for a zero-delta drag", () => {
    const local = compose([translation(10, 0, 0)]);
    const result = composeOpUpdate({
      mode: "translate",
      order: ["xformOp:translate"],
      attrs: [attr("xformOp:translate", "double3", "vec3d", vec([10, 0, 0]))],
      localMatrix: local,
      targetLocalMatrix: local,
    });

    expect(result).toEqual({
      ok: true,
      writes: [{ name: "xformOp:translate", type: "double3", data: [10, 0, 0] }],
    });
  });

  it("adds a parent-space delta to an existing translate under a rotation", () => {
    // order [rotateZ 90, translate (1,0,0)]: translate acts in the rotated
    // frame. Moving +Y in parent space means +X in that frame, so the
    // authored translate goes (1,0,0) -> (2,0,0).
    const local = compose([rotZ(90), translation(1, 0, 0)]);
    const target = compose([translation(0, 1, 0), rotZ(90), translation(1, 0, 0)]);
    const result = composeOpUpdate({
      mode: "translate",
      order: ["xformOp:rotateZ", "xformOp:translate"],
      attrs: [
        attr("xformOp:rotateZ", "float", "float", 90),
        attr("xformOp:translate", "double3", "vec3d", vec([1, 0, 0])),
      ],
      localMatrix: local,
      targetLocalMatrix: target,
    });

    expect(result).toEqual({
      ok: true,
      writes: [{ name: "xformOp:translate", type: "double3", data: [2, 0, 0] }],
    });
  });

  it("creates a translate op and appends it to xformOpOrder when none exists", () => {
    // Appended at the END of the order = most-local, so the authored value
    // lives in the prim's pre-rotation frame: inv(Rz90)*(1,0,0) = (0,-1,0).
    const local = compose([rotZ(90)]);
    const target = compose([translation(1, 0, 0), rotZ(90)]);
    const result = composeOpUpdate({
      mode: "translate",
      order: ["xformOp:rotateXYZ"],
      attrs: [attr("xformOp:rotateXYZ", "float3", "vec3f", vec([0, 0, 90]))],
      localMatrix: local,
      targetLocalMatrix: target,
    });

    expect(result).toEqual({
      ok: true,
      writes: [
        { name: "xformOp:translate", type: "double3", data: [0, -1, 0] },
        {
          name: "xformOpOrder",
          type: "token_array",
          data: ["xformOp:rotateXYZ", "xformOp:translate"],
        },
      ],
    });
  });

  it("authors XYZ Euler degrees into an existing rotateXYZ op", () => {
    const local = compose([rotZ(90)]);
    const target = compose([rotZ(120)]);
    const result = composeOpUpdate({
      mode: "rotate",
      order: ["xformOp:rotateXYZ"],
      attrs: [attr("xformOp:rotateXYZ", "float3", "vec3f", vec([0, 0, 90]))],
      localMatrix: local,
      targetLocalMatrix: target,
    });

    expect(result).toEqual({
      ok: true,
      writes: [{ name: "xformOp:rotateXYZ", type: "float3", data: [0, 0, 120] }],
    });
  });

  it("creates a rotateXYZ op under a translate and appends it to the order", () => {
    // Rotating 90 deg about the moved origin: the new most-local op is a
    // plain Rz(90) in the prim's frame; the translate above it is untouched.
    const local = compose([translation(5, 0, 0)]);
    const target = compose([translation(5, 0, 0), rotZ(90)]);
    const result = composeOpUpdate({
      mode: "rotate",
      order: ["xformOp:translate"],
      attrs: [attr("xformOp:translate", "double3", "vec3d", vec([5, 0, 0]))],
      localMatrix: local,
      targetLocalMatrix: target,
    });

    expect(result).toEqual({
      ok: true,
      writes: [
        { name: "xformOp:rotateXYZ", type: "float3", data: [0, 0, 90] },
        {
          name: "xformOpOrder",
          type: "token_array",
          data: ["xformOp:translate", "xformOp:rotateXYZ"],
        },
      ],
    });
  });

  it("re-authors an existing scale op from the gizmo's scale factors", () => {
    const local = compose([scaleOf(2, 2, 2)]);
    const target = compose([scaleOf(3, 2, 2)]);
    const result = composeOpUpdate({
      mode: "scale",
      order: ["xformOp:scale"],
      attrs: [attr("xformOp:scale", "float3", "vec3f", vec([2, 2, 2]))],
      localMatrix: local,
      targetLocalMatrix: target,
    });

    expect(result).toEqual({
      ok: true,
      writes: [{ name: "xformOp:scale", type: "float3", data: [3, 2, 2] }],
    });
  });

  it("refuses stacks it cannot evaluate (orient, missing values, mid-stack reset, mismatch)", () => {
    const orient = compose([new THREE.Matrix4()]); // orient never composes here
    expect(
      composeOpUpdate({
        mode: "translate",
        order: ["xformOp:orient"],
        attrs: [attr("xformOp:orient", "quatf", "quatf", [1, 0, 0, 0])],
        localMatrix: orient,
        targetLocalMatrix: orient,
      }),
    ).toMatchObject({ ok: false });

    expect(
      composeOpUpdate({
        mode: "translate",
        order: ["xformOp:translate"],
        attrs: [],
        localMatrix: IDENTITY,
        targetLocalMatrix: IDENTITY,
      }),
    ).toMatchObject({ ok: false });

    expect(
      composeOpUpdate({
        mode: "translate",
        order: ["xformOp:translate", "!resetXformStack!", "xformOp:rotateZ"],
        attrs: [
          attr("xformOp:translate", "double3", "vec3d", vec([1, 0, 0])),
          attr("xformOp:rotateZ", "float", "float", 90),
        ],
        localMatrix: IDENTITY,
        targetLocalMatrix: IDENTITY,
      }),
    ).toMatchObject({ ok: false });

    // Composed ops disagree with the stage-evaluator matrix: refuse.
    expect(
      composeOpUpdate({
        mode: "translate",
        order: ["xformOp:translate"],
        attrs: [attr("xformOp:translate", "double3", "vec3d", vec([10, 0, 0]))],
        localMatrix: IDENTITY,
        targetLocalMatrix: IDENTITY,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("matricesClose", () => {
  it("treats a zero-delta drag as unchanged", () => {
    const local = compose([rotZ(90), translation(1, 2, 3)]);
    const target = compose([translation(0, 0, 1e-9), rotZ(90), translation(1, 2, 3)]);
    expect(matricesClose(local, target)).toBe(true);
    expect(matricesClose(local, compose([translation(1, 0, 0), rotZ(90), translation(1, 2, 3)]))).toBe(false);
  });
});
