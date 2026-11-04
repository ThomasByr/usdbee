// Anchored gizmo math (bbox-center anchor): the proxy carries the knob at
// the selection's box center while the commit still authors the prim's
// true world matrix. The correction is pure and pinned here.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { gizmoAnchorCenter } from "./gizmoCommit.svelte";
import { gizmoCorrection } from "./transformGizmo";

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
