// Viewport transform gizmo (Phase 3, Task 4). A scene-root proxy object
// carries the selected prim's world transform (decomposed into
// position/quaternion/scale so TransformControls can drag it); on drag
// end the host receives the proxy's start/end world matrices and authors
// through Task 1's set_attribute_value command (the delta -> op math lives
// in xformOps.ts). The proxy never IS the scene node: USD is the source
// of truth and the round trip re-anchors it after every refresh.
//
// shortcut: shear in a prim's composed world transform is dropped by the
// position/quaternion/scale decomposition, so gizmo drags on sheared
// stacks are approximate; upgrade by authoring full matrices.

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export interface GizmoCommit {
  // The proxy's world matrices at drag start (the anchor pose) and drag
  // end. The host derives the desired USD local matrix from their ratio —
  // every parent/world transform (up-axis rotation, scene recentering)
  // cancels out.
  startWorld: THREE.Matrix4;
  endWorld: THREE.Matrix4;
}

export class TransformGizmo {
  readonly controls: TransformControls;
  private readonly proxy = new THREE.Object3D();
  private readonly anchor = new THREE.Matrix4();
  onCommit: ((commit: GizmoCommit) => void) | null = null;

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
    // The camera orbit must not fight the gizmo drag.
    this.controls.addEventListener("dragging-changed", (event: any) => {
      orbit.enabled = !event.value;
      if (event.value) {
        this.proxy.updateMatrixWorld();
        this.anchor.copy(this.proxy.matrixWorld);
      } else {
        this.proxy.updateMatrixWorld();
        this.onCommit?.({
          startWorld: this.anchor.clone(),
          endWorld: this.proxy.matrixWorld.clone(),
        });
      }
    });
  }

  // Places the proxy at the prim's world transform (host computes it from
  // details.world_transform composed with the loaded group's matrix) and
  // shows the gizmo. Also used to re-anchor after commits and refreshes.
  attach(worldMatrix: THREE.Matrix4): void {
    worldMatrix.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    this.controls.attach(this.proxy);
  }

  detach(): void {
    this.controls.detach();
  }

  dispose(): void {
    this.controls.detach();
    this.controls.dispose();
    this.proxy.removeFromParent();
  }
}
