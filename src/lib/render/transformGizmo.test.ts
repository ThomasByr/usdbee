// Anchored gizmo math (bbox-center anchor): the proxy carries the knob at
// the selection's box center while the commit still authors the prim's
// true world matrix. The correction is pure and pinned here.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { gizmoAnchorCenter } from "./gizmoCommit.svelte";
import { gizmoCorrection, previewLocalMatrix, TransformGizmo } from "./transformGizmo";

const IDENTITY = new THREE.Matrix4();

function translation(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

function rotZ(deg: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationZ((deg * Math.PI) / 180);
}

function close(actual: THREE.Matrix4, expected: THREE.Matrix4, digits = 6) {
  const a = actual.toArray();
  const e = expected.toArray();
  for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(e[i], digits);
}

describe("gizmoCorrection", () => {
  it("is the identity when the proxy pose is the world matrix", () => {
    const world = translation(10, -4, 3);
    close(gizmoCorrection(world, world), IDENTITY);
  });

  it("maps the proxy pose back to the prim's origin", () => {
    const world = translation(10, 0, 0);
    const proxy = translation(30, 5, 0);
    const correction = gizmoCorrection(proxy, world);
    close(proxy.clone().multiply(correction), world);
  });

  it("commits a translate drag as the dragged delta", () => {
    const world = translation(10, 0, 0);
    const proxy = translation(30, 5, 0);
    const correction = gizmoCorrection(proxy, world);
    // TransformControls translates the proxy in world space.
    const endProxy = translation(2, 0, 0).multiply(proxy);
    close(endProxy.clone().multiply(correction), translation(12, 0, 0));
  });

  it("commits a rotate drag about the visible center, not the prim origin", () => {
    const world = translation(10, 0, 0);
    const center = new THREE.Vector3(30, 5, 0);
    const proxy = translation(center.x, center.y, center.z);
    const correction = gizmoCorrection(proxy, world);
    // A 90 degree Z spin about the proxy's own origin.
    const endProxy = proxy.clone().multiply(rotZ(90));
    const expected = translation(center.x, center.y, center.z)
      .multiply(rotZ(90))
      .multiply(translation(-center.x, -center.y, -center.z))
      .multiply(world);
    close(endProxy.clone().multiply(correction), expected);
    // The prim origin orbits the center: (10,0,0) -> (30,5,0) + rotZ90*([-20,-5,0]).
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(expected);
    expect(origin.x).toBeCloseTo(35, 6);
    expect(origin.y).toBeCloseTo(-15, 6);
  });
});

describe("previewLocalMatrix", () => {
  it("is the world pose when the parent is the identity", () => {
    const endWorld = translation(3, -2, 7).multiply(rotZ(30));
    close(previewLocalMatrix(IDENTITY, endWorld), endWorld);
  });

  it("strips the parent transform from the world pose", () => {
    const endWorld = translation(10, 0, 0);
    close(previewLocalMatrix(translation(5, 0, 0), endWorld), translation(5, 0, 0));
    // A rotated parent: the preview must undo the full parent pose, not
    // just its translation.
    const parent = translation(5, 0, 0).multiply(rotZ(45));
    close(previewLocalMatrix(parent, endWorld), parent.clone().invert().multiply(endWorld));
  });
});

// The controls only need the event-listener surface; the per-frame pose sync
// reuses the same attach path, so only the proxy pose and the attach latch
// are observed here.
function makeGizmo(): TransformGizmo {
  const domElement = {
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
  } as unknown as HTMLElement;
  return new TransformGizmo(new THREE.PerspectiveCamera(), domElement, new THREE.Scene(), { enabled: true });
}

describe("TransformGizmo drag lifecycle", () => {
  it("fires onDragStart once when a drag begins", () => {
    const gizmo = makeGizmo();
    const onDragStart = vi.fn();
    gizmo.onDragStart = onDragStart;

    gizmo.controls.dispatchEvent({ type: "dragging-changed", value: true });
    expect(onDragStart).toHaveBeenCalledTimes(1);

    gizmo.controls.dispatchEvent({ type: "dragging-changed", value: false });
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it("does not re-attach while the proxy stays the attached object", () => {
    const gizmo = makeGizmo();
    const proxy = gizmo.controls.object;
    const attach = vi.spyOn(gizmo.controls, "attach");

    gizmo.attach(translation(1, 2, 3));
    gizmo.attach(translation(4, 5, 6), new THREE.Vector3(7, 8, 9));

    expect(attach).not.toHaveBeenCalled();
    expect(gizmo.controls.object).toBe(proxy);
    // The pose still moved: skipping the attach only skips the reload.
    expect(gizmo.controls.object.position.x).toBe(7);

    // A detached gizmo must re-attach on the next pose sync.
    gizmo.detach();
    gizmo.attach(translation(1, 1, 1));
    expect(attach).toHaveBeenCalledTimes(1);
  });
});

describe("TransformGizmo drag preview", () => {
  it("fires onPreview with the prim's end world pose", () => {
    const gizmo = makeGizmo();
    const world = translation(10, 0, 0);
    gizmo.attach(world, new THREE.Vector3(30, 5, 0));
    const proxy = gizmo.controls.object!;
    // The correction attach latched, recomputed from the pinned math.
    const correction = gizmoCorrection(proxy.matrix, world);
    const onPreview = vi.fn();
    gizmo.onPreview = onPreview;

    // Assigning the property stands in for TransformControls' own pointer
    // handlers: a dispatched dragging-changed event does not set it.
    (gizmo.controls as any).dragging = true;
    // TransformControls translates the proxy in world space.
    proxy.position.set(32, 5, 0);
    proxy.updateMatrix();
    gizmo.controls.dispatchEvent({ type: "objectChange" });

    expect(onPreview).toHaveBeenCalledTimes(1);
    close(onPreview.mock.calls[0][0], proxy.matrixWorld.clone().multiply(correction));
    // T(32,5,0) * inv(T(30,5,0)) * T(10,0,0) = T(12,0,0).
    close(onPreview.mock.calls[0][0], translation(12, 0, 0));
  });

  it("stays silent outside a drag", () => {
    const gizmo = makeGizmo();
    gizmo.attach(translation(10, 0, 0), new THREE.Vector3(30, 5, 0));
    const onPreview = vi.fn();
    gizmo.onPreview = onPreview;

    (gizmo.controls as any).dragging = false;
    gizmo.controls.object!.position.set(32, 5, 0);
    gizmo.controls.object!.updateMatrix();
    gizmo.controls.dispatchEvent({ type: "objectChange" });

    expect(onPreview).not.toHaveBeenCalled();
  });
});

describe("gizmoAnchorCenter", () => {
  it("returns null without a selection", () => {
    expect(gizmoAnchorCenter({ selectedNode: null })).toBeNull();
  });

  it("returns null for a node with no geometry", () => {
    expect(gizmoAnchorCenter({ selectedNode: new THREE.Group() })).toBeNull();
  });

  it("returns the box center of the selected node", () => {
    // Geometry far from the group origin, like an asset authored off-origin.
    const group = new THREE.Group();
    group.position.set(5, 0, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    mesh.position.set(100, 10, 0);
    group.add(mesh);
    mesh.updateMatrixWorld();
    const center = gizmoAnchorCenter({ selectedNode: group });
    expect(center).not.toBeNull();
    expect(center!.x).toBeCloseTo(105, 6);
    expect(center!.y).toBeCloseTo(10, 6);
    expect(center!.z).toBeCloseTo(0, 6);
  });
});
