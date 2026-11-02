// Transform-gizmo op math (Phase 3, Task 4). Pure functions only: given
// the prim's authored xform ops (from get_prim_details) plus the desired
// local matrix after a gizmo drag, compute the single op (and, when the
// op must be created, the xformOpOrder append) to author through Task 1's
// set_attribute_value command.
//
// Conventions (see sceneBuilder.ts and values.rs): USD row-major
// row-vector [f64; 16] arrays and three.js Matrix4 store the same 16
// numbers in the same order, and the composed local matrix is the
// LIST-ORDER product of the op matrices in three.js terms (first-listed
// op = most global; reverse-of-list application, mirroring the Phase 1
// Rust evaluator). The composed product is cross-checked against the
// evaluator's local_matrix and the helper refuses on any disagreement —
// no data beats wrong data.

import * as THREE from "three";
import type { AttributeInfo, PrimDetails } from "../stage/types";

export type GizmoMode = "translate" | "rotate" | "scale";

// One set_attribute_value write: attribute name, wire payload type
// spelling, and data (xyz numbers, or the appended order for token_array).
export interface OpWrite {
  name: string;
  type: string;
  data: number[] | string[];
}

export type ComposeResult = { ok: true; writes: OpWrite[] } | { ok: false; error: string };

// The op each gizmo mode authors. Rotations always land in rotateXYZ (XYZ
// Euler, degrees — the USD convention), matching the numeric editor.
export const GIZMO_TARGET_OPS: Record<GizmoMode, string> = {
  translate: "xformOp:translate",
  rotate: "xformOp:rotateXYZ",
  scale: "xformOp:scale",
};

// Declared spellings for ops the gizmo creates (UsdGeomXformable defaults:
// translate double3, rotateXYZ/scale float3).
const CREATED_OP_TYPES: Record<GizmoMode, string> = {
  translate: "double3",
  rotate: "float3",
  scale: "float3",
};

const RESET_TOKEN = "!resetXformStack!";

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function number3(data: unknown, type: string): [number, number, number] | null {
  if (!Array.isArray(data) || data.length !== 3) return null;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = data[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

function axisRotation(axis: "X" | "Y" | "Z", deg: number): THREE.Matrix4 {
  const radians = (deg * Math.PI) / 180;
  switch (axis) {
    case "X":
      return new THREE.Matrix4().makeRotationX(radians);
    case "Y":
      return new THREE.Matrix4().makeRotationY(radians);
    default:
      return new THREE.Matrix4().makeRotationZ(radians);
  }
}

// The three.js matrix of one xformOp entry. `entry` is the raw
// xformOpOrder spelling (may carry an !invert!/!inverted! prefix); the
// op's value comes from the composed attributes. Returns null with a
// readable reason when the op cannot be evaluated exactly.
function opMatrix(entry: string, attrs: AttributeInfo[]): { matrix: THREE.Matrix4 } | { error: string } {
  let name = entry;
  const inverted = name.startsWith("!invert!") || name.startsWith("!inverted!");
  if (inverted) name = name.replace(/^!(invert|inverted)!/, "");
  if (!name.startsWith("xformOp:")) {
    return { error: `unsupported xformOpOrder entry ${entry}` };
  }
  const attr = attrs.find((a) => a.name === name);
  if (!attr || attr.value.data == null) {
    return { error: `no composed value for ${entry}` };
  }
  const base = name.slice("xformOp:".length).split(":")[0];
  const data = attr.value.data;
  let matrix: THREE.Matrix4;
  if (base === "translate" || base === "scale") {
    const vec = number3(data, attr.value.type);
    if (!vec) return { error: `${entry} has no readable vec3 value` };
    matrix =
      base === "translate"
        ? new THREE.Matrix4().makeTranslation(vec[0], vec[1], vec[2])
        : new THREE.Matrix4().makeScale(vec[0], vec[1], vec[2]);
  } else if (base === "rotateX" || base === "rotateY" || base === "rotateZ") {
    if (typeof data !== "number" || !Number.isFinite(data)) {
      return { error: `${entry} has no readable scalar rotation` };
    }
    matrix = axisRotation(base.slice(-1) as "X" | "Y" | "Z", data);
  } else if (/^rotate[XYZ]{3}$/.test(base)) {
    const vec = number3(data, attr.value.type);
    if (!vec) return { error: `${entry} has no readable vec3 value` };
    const letters = base.slice("rotate".length).split("") as [
      "X" | "Y" | "Z",
      "X" | "Y" | "Z",
      "X" | "Y" | "Z",
    ];
    // Mirror the Rust evaluator exactly (values.rs op_transform): each
    // component pairs with its axis by NAME (X->v0, Y->v1, Z->v2 — the USD
    // rotateABC contract, regardless of the op's letter order), and the
    // row-vector product multiplies in letter order with the first-named
    // letter leftmost. Transposed into three.js the LAST-named letter
    // applies first. A wrong mirror would trip the divergence guard below
    // and refuse every non-XYZ stack, so supported stacks stay uneditable.
    const angle = { X: vec[0], Y: vec[1], Z: vec[2] };
    const [A, B, C] = letters;
    matrix = axisRotation(C, angle[C])
      .multiply(axisRotation(B, angle[B]))
      .multiply(axisRotation(A, angle[A]));
  } else {
    // orient, transform, and anything unknown: refuse rather than guess.
    return { error: `gizmo does not support ${entry}` };
  }
  return { matrix: inverted ? matrix.clone().invert() : matrix };
}

// Element-wise closeness with a relative tolerance (drag no-ops and
// evaluator agreement both pass through this).
export function matricesClose(a: number[], b: number[]): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-6 * (1 + Math.abs(b[i]))) return false;
  }
  return true;
}

// The gizmo gate (pure so Vitest can pin it): a gizmo needs a world
// matrix to anchor to and a local stack it can author into. Instances and
// stacks the Rust evaluator refuses (None transforms: orient, unsupported
// ops, an unevaluable ancestor somewhere in the chain) disable it with a
// readable status — no data beats wrong data. A prim with no authored
// xformOpOrder reports identity transforms and stays EDITABLE: the
// create-op path authors both the op and the order from scratch.
export function evaluateGizmoGate(
  selectedPath: string | null,
  details: PrimDetails | null,
): { attachable: boolean; message: string | null } {
  if (!selectedPath || !details) return { attachable: false, message: null };
  if (!details.is_active) {
    return {
      attachable: false,
      message: "prim is inactive; reactivate it before editing",
    };
  }
  if (details.is_instance) {
    return {
      attachable: false,
      message: `instance — edit the prototype at ${details.instance_of ?? "?"}`,
    };
  }
  if (!details.local_transform || !details.world_transform) {
    return {
      attachable: false,
      message: "transform stack not editable (unsupported op in this prim or an ancestor)",
    };
  }
  return { attachable: true, message: null };
}

// The op the gizmo flow must author for one drag. `targetLocalMatrix` is
// the desired composed local transform after the drag (the caller derives
// it from the gizmo proxy's world matrices — the parent/world chain
// cancels out). Existing target op: the value is recomputed in place.
// Missing target op: created with the UsdGeom default spelling and
// appended at the END of xformOpOrder (most-local position, per the
// task's authoring ruling). A prim with NO authored xformOpOrder (empty
// `order`, identity `localMatrix`) goes through the same create-op path
// and authors the order from scratch as `[<op>]`.
export function composeOpUpdate(input: {
  mode: GizmoMode;
  order: string[];
  attrs: AttributeInfo[];
  localMatrix: number[];
  targetLocalMatrix: number[];
}): ComposeResult {
  const ops: THREE.Matrix4[] = [];
  for (const [index, entry] of input.order.entries()) {
    if (entry === RESET_TOKEN) {
      // USD only defines the reset token first; anywhere else the helper
      // would have to discard earlier ops, so refuse the edit.
      if (index > 0) return fail("!resetXformStack! mid-stack is not editable");
      continue;
    }
    const built = opMatrix(entry, input.attrs);
    if ("error" in built) return fail(built.error);
    ops.push(built.matrix);
  }

  const composed = new THREE.Matrix4();
  for (const op of ops) composed.multiply(op);
  if (!matricesClose(composed.toArray() as number[], input.localMatrix)) {
    return fail("composed ops disagree with the stage transform; refusing to author");
  }

  const target = GIZMO_TARGET_OPS[input.mode];
  const orderIndex = input.order.indexOf(target);
  const exists = orderIndex !== -1;
  const opIndex = exists
    ? input.order.slice(0, orderIndex).filter((entry) => entry !== RESET_TOKEN).length
    : ops.length;

  // A (ops before the target, most-global side) and B (ops after it).
  const before = new THREE.Matrix4();
  for (let j = 0; j < opIndex; j++) before.multiply(ops[j]);
  const after = new THREE.Matrix4();
  for (let j = opIndex + 1; j < ops.length; j++) after.multiply(ops[j]);
  if (Math.abs(before.determinant()) < 1e-12 || Math.abs(after.determinant()) < 1e-12) {
    return fail("transform stack is singular; cannot author a gizmo edit");
  }

  // Oi' = A^-1 * M' * B^-1 (exact given the desired local matrix).
  const newOp = before
    .clone()
    .invert()
    .multiply(new THREE.Matrix4().fromArray(input.targetLocalMatrix))
    .multiply(after.clone().invert());

  const e = newOp.elements;
  // Snap float noise (6e-17, -0, 119.99999999996) so authored values
  // stay readable.
  const snap = (v: number) => {
    // Normalize -0 and genuine float noise only — a small-but-real
    // component (0.23) is NOT zero and must survive authoring.
    if (Math.abs(v) < 1e-9) return 0;
    const near = Math.round(v);
    return Math.abs(v - near) < 1e-9 ? near : v;
  };
  let data: number[];
  if (input.mode === "translate") {
    // shortcut: residual rotation/scale from a mixed stack is dropped —
    // only the translation component of the recomputed op is authored.
    data = [e[12], e[13], e[14]];
  } else if (input.mode === "scale") {
    // shortcut: basis-column lengths assume no rotation leaked into the
    // recomputed op (true for the usual SRT stacks).
    data = [Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])];
  } else {
    // shortcut: Euler-order fidelity beyond default XYZ — the gizmo only
    // authors rotateXYZ; sheared stacks lose their shear here.
    const c0 = Math.hypot(e[0], e[1], e[2]);
    const c1 = Math.hypot(e[4], e[5], e[6]);
    const c2 = Math.hypot(e[8], e[9], e[10]);
    if (c0 < 1e-12 || c1 < 1e-12 || c2 < 1e-12) return fail("rotation collapsed; refusing");
    // Solve R = Rz(c)·Ry(b)·Rx(a) from the normalized basis (three.js
    // stores columns: elements[c*4+r] = R[r][c]).
    const r20 = e[2] / c0;
    let a: number, b: number, c: number;
    if (Math.abs(r20) < 1 - 1e-6) {
      b = Math.asin(-r20);
      c = Math.atan2(e[1] / c0, e[0] / c0);
      a = Math.atan2(e[6] / c1, e[10] / c2);
    } else {
      // Gimbal lock: pin a = 0, solve c from the remaining pair.
      b = r20 < 0 ? Math.PI / 2 : -Math.PI / 2;
      a = 0;
      c = r20 < 0 ? -Math.atan2(e[4] / c1, e[5] / c1) : Math.atan2(-e[4] / c1, e[5] / c1);
    }
    data = [(a * 180) / Math.PI, (b * 180) / Math.PI, (c * 180) / Math.PI];
  }
  data = data.map(snap);

  let type: string;
  if (exists) {
    const attr = input.attrs.find((x) => x.name === target);
    type =
      attr && attr.type_name ? attr.type_name : attr && attr.value.type === "vec3d" ? "double3" : "float3";
  } else {
    type = CREATED_OP_TYPES[input.mode];
  }

  const writes: OpWrite[] = [{ name: target, type, data }];
  if (!exists) {
    writes.push({ name: "xformOpOrder", type: "token_array", data: [...input.order, target] });
  }
  return { ok: true, writes };
}
