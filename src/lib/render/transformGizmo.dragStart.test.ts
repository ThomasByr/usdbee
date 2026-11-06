// @vitest-environment happy-dom
// Drag-start ordering pin: the host re-anchors the proxy from the pause
// handler, and it must land BEFORE TransformControls snapshots the pose the
// drag is measured from (its own pointerdown listener on the same canvas).

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { TransformGizmo } from "./transformGizmo";

function makeGizmo() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const gizmo = new TransformGizmo(new THREE.PerspectiveCamera(), canvas, new THREE.Scene(), {
    enabled: true,
  });
  return { gizmo, canvas };
}

function press(canvas: HTMLElement, button = 0) {
  canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TransformGizmo drag start", () => {
  it("re-anchors before the controls' own pointerdown listener runs", () => {
    const { gizmo, canvas } = makeGizmo();
    const order: string[] = [];
    gizmo.onDragStart = () => order.push("reanchor");
    // Stands in for TransformControls' target-phase listener, which the
    // controls registered on this same canvas when they were constructed.
    canvas.addEventListener("pointerdown", () => order.push("controls"));

    gizmo.controls.axis = "X";
    press(canvas);

    expect(order).toEqual(["reanchor", "controls"]);
    gizmo.dispose();
  });

  it("stays silent without a gizmo axis under the pointer", () => {
    const { gizmo, canvas } = makeGizmo();
    const onDragStart = vi.fn();
    gizmo.onDragStart = onDragStart;

    // Plain canvas press: the orbit's gesture, not a gizmo drag.
    press(canvas);
    // A non-primary button on a handle is the orbit's too.
    gizmo.controls.axis = "X";
    press(canvas, 2);

    expect(onDragStart).not.toHaveBeenCalled();
    gizmo.dispose();
  });

  it("stops listening on dispose", () => {
    const { gizmo, canvas } = makeGizmo();
    const onDragStart = vi.fn();
    gizmo.onDragStart = onDragStart;
    gizmo.controls.axis = "X";

    gizmo.dispose();
    press(canvas);

    expect(onDragStart).not.toHaveBeenCalled();
  });
});
