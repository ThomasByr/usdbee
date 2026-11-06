// Viewport transform gizmo (Phase 3, Task 4). A scene-root proxy object
// carries the selected prim's world transform (decomposed into
// position/quaternion/scale so TransformControls can drag it); on drag
// end the host receives the proxy's start/end world matrices and authors
// through Task 1's set_attribute_value command (the delta -> op math lives
// in xformOps.ts). The proxy never IS the scene node: USD is the source
// of truth and the round trip re-anchors it after every refresh.
//
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export interface GizmoCommit {
  // The prim's true world matrices at drag start (the anchor pose) and
  // drag end: the visible proxy pose plus the anchor-offset correction.
  // The host derives the desired USD local matrix from their ratio —
  // every parent/world transform (up-axis rotation, scene recentering)
  // cancels out.
  startWorld: THREE.Matrix4;
  endWorld: THREE.Matrix4;
}

// The proxy can sit away from the prim's origin (at the selection's bbox
// center), so a proxy pose is not the prim's world matrix. This maps one
// back: C = inv(proxyPose) * world, and true = proxyPose * C.
// shortcut: shear in a prim's composed world transform is dropped by the
// position/quaternion/scale decomposition; the correction below absorbs it
// for the commit math, but the drawn proxy still cannot show shear.
export function gizmoCorrection(proxyMatrix: THREE.Matrix4, worldMatrix: THREE.Matrix4): THREE.Matrix4 {
  return proxyMatrix.clone().invert().multiply(worldMatrix);
}

// The node's local matrix for a desired world pose: preview applies this
// to the frozen node matrix, mirroring the commit's world->local ratio.
export function previewLocalMatrix(parentWorld: THREE.Matrix4, endWorld: THREE.Matrix4): THREE.Matrix4 {
  return endWorld.clone().premultiply(parentWorld.clone().invert());
}

export class TransformGizmo {
  readonly controls: TransformControls;
  private readonly proxy = new THREE.Object3D();
  private readonly anchor = new THREE.Matrix4();
  private readonly correction = new THREE.Matrix4();
  onCommit: ((commit: GizmoCommit) => void) | null = null;
  // Fired on the gizmo's pointerdown, before TransformControls latches its
  // drag-start pose: the host pauses playback and re-anchors the proxy here
  // so the latch reads the current pose, not one frozen by playback.
  onDragStart: (() => void) | null = null;
  // Removes the document-level drag-start listener on dispose.
  private readonly removeDragStartListener: () => void;
  // Fired continuously while a drag is active, with the same endWorld the
  // commit would compute: the host previews the prim's node at that pose.
  onPreview: ((endWorld: THREE.Matrix4) => void) | null = null;

  constructor(
    camera: THREE.Camera,
    domElement: HTMLElement,
    scene: THREE.Scene,
    orbit: { enabled: boolean },
  ) {
    this.proxy.name = "usdbee-gizmo-proxy";
    scene.add(this.proxy);
    this.controls = new TransformControls(camera, domElement);
    this.controls.attach(this.proxy);
    scene.add(this.controls.getHelper());
    // TransformControls' own pointerdown listener sits on the same element
    // and must not run first: it snapshots the proxy pose (positionStart,
    // pointStart) that a drag is measured from. Capture on the document
    // runs before any target-phase listener, whatever its capture flag.
    const beforeDragStart = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== domElement || this.controls.axis === null) return;
      this.onDragStart?.();
    };
    const doc = domElement.ownerDocument;
    doc?.addEventListener("pointerdown", beforeDragStart, true);
    this.removeDragStartListener = () => doc?.removeEventListener("pointerdown", beforeDragStart, true);
    // The camera orbit must not fight the gizmo drag.
    this.controls.addEventListener("dragging-changed", (event: any) => {
      orbit.enabled = !event.value;
      if (event.value) {
        this.proxy.updateMatrixWorld();
        this.anchor.copy(this.proxy.matrixWorld);
      } else {
        this.proxy.updateMatrixWorld();
        // proxy pose * correction = the prim's true world matrix, so
        // translate drags move by the dragged delta and rotate drags spin
        // the prim about the visible (bbox) center.
        this.onCommit?.({
          startWorld: this.anchor.clone().multiply(this.correction),
          endWorld: this.proxy.matrixWorld.clone().multiply(this.correction),
        });
      }
    });
    // objectChange fires continuously mid-drag: the host moves the prim's
    // node with the knob instead of waiting for the drag to end.
    this.controls.addEventListener("objectChange", () => {
      if (!this.controls.dragging || !this.onPreview) return;
      this.proxy.updateMatrixWorld();
      this.onPreview(this.proxy.matrixWorld.clone().multiply(this.correction));
    });
  }

  // Places the proxy at the prim's world transform (host computes it from
  // details.world_transform composed with the loaded group's matrix) and
  // shows the gizmo. An anchor (the selection's bbox center) moves the
  // knob there while rotation/scale still come from worldMatrix. Also
  // used to re-anchor after commits and refreshes.
  attach(worldMatrix: THREE.Matrix4, anchor?: THREE.Vector3 | null): void {
    worldMatrix.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    if (anchor) this.proxy.position.copy(anchor);
    this.proxy.updateMatrix();
    this.correction.copy(gizmoCorrection(this.proxy.matrix, worldMatrix));
    // The per-frame sync re-poses the proxy every frame; the attach call
    // reloads controls state, so keep it off the steady path.
    if (this.controls.object !== this.proxy) this.controls.attach(this.proxy);
  }

  detach(): void {
    this.controls.detach();
  }

  dispose(): void {
    this.removeDragStartListener();
    this.controls.detach();
    this.controls.dispose();
    this.proxy.removeFromParent();
  }
}
