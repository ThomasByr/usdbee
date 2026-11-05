import * as THREE from "three";
import { TransformGizmo, previewLocalMatrix, type GizmoCommit } from "$lib/render/transformGizmo";
import { composeOpUpdate, evaluateGizmoGate, matricesClose, type GizmoMode } from "$lib/render/xformOps";
import { stageState } from "$lib/stage/stageState.svelte";
import type { RendererKit } from "$lib/three/RendererKit.svelte";

// Transform gizmo editing policy (Phase 3 Task 4), moved out of the
// viewport component: anchor sync, commit lock + error state and the
// commit math. The Viewport calls these functions synchronously from
// $effect / onMount, so the stage reads inside them stay tracked. The
// gizmo lives with the renderer kit's camera/scene/orbit: drag events
// come off the same canvas, and the orbit disables while a gizmo drag
// is active.

let gizmoViewer: RendererKit | null = null;
let mode: () => GizmoMode = () => "translate";

// The gate logic is pure code in xformOps.ts (Vitest-pinned): a prim
// with no authored xformOpOrder reports identity transforms and stays
// editable, so the create-op path can author the op AND xformOpOrder
// from scratch; only genuinely unsupported stacks disable the gizmo.
export function getGizmoGate() {
  return evaluateGizmoGate(stageState.selectedPath, stageState.details);
}

export const gizmoPolicy = $state({
  kit: null as TransformGizmo | null,
  error: null as string | null,
});

export function getGizmoError() {
  return gizmoPolicy.error;
}

// The prim's world matrix in VIEWPORT space: the USD world transform
// composed with the loaded group's recentering + up-axis transform.
export function gizmoWorldMatrix(viewer: RendererKit): THREE.Matrix4 | null {
  const details = stageState.details;
  if (!details?.world_transform) return null;
  const world = new THREE.Matrix4().fromArray(details.world_transform);
  const group = viewer.loadedGroup;
  if (group) {
    group.updateMatrixWorld();
    world.premultiply(group.matrixWorld);
  }
  return world;
}

// The gizmo's anchor: the center of the selection's bounding box, i.e.
// the same box the orange selection helper draws. setFromObject yields
// scene-space coordinates, the space gizmoWorldMatrix already works in,
// so the center needs no extra transform.
export function gizmoAnchorCenter(viewer: { selectedNode: THREE.Object3D | null }): THREE.Vector3 | null {
  const node = viewer.selectedNode;
  if (!node) return null;
  const box = new THREE.Box3().setFromObject(node, true);
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

// Commit errors clear with the next selection; a fresh anchor snaps the
// proxy back to stage truth (also the failure path: a refused commit
// leaves details unchanged, so the re-anchor undoes the drag).
export function clearGizmoError() {
  const _path = stageState.details?.path;
  gizmoPolicy.error = null;
}

// Attach, re-anchor or detach: called synchronously from the Viewport's
// effect, so every stage read inside is tracked.
export function syncGizmoAnchor(viewer: RendererKit, gizmoMode: GizmoMode) {
  const kit = gizmoPolicy.kit;
  if (!kit) return;
  // A details refresh can land mid-drag (the pause catch-up): re-attaching
  // then would snap the proxy back and corrupt the commit math.
  if (kit.controls.dragging) return;
  kit.controls.setMode(gizmoMode);
  if (!getGizmoGate().attachable) {
    kit.detach();
    return;
  }
  const world = gizmoWorldMatrix(viewer);
  if (world) kit.attach(world, gizmoAnchorCenter(viewer));
}

// Per-frame pose sync (called from the kit's render loop): the selected
// prim keeps animating while details are suppressed, so the pose comes
// from the live node. Skipped mid-drag: the proxy's own drag latch owns
// the pose then, and re-anchoring would corrupt the commit math.
// Scratch for the per-frame box center: attach copies it into the proxy,
// so it never escapes this call.
const frameAnchor = new THREE.Vector3();

export function frameSyncGizmo(viewer: RendererKit) {
  const kit = gizmoPolicy.kit;
  if (!kit || kit.controls.dragging) return;
  const node = viewer.selectedNode as THREE.Object3D | null;
  if (!node || !getGizmoGate().attachable) return;
  // The renderer already refreshed the node's world matrix this frame.
  node.updateWorldMatrix(true, false);
  // The selection helper's box was computed from this same node a moment
  // ago: reuse its center instead of running a second subtree traversal.
  const box = viewer.selectionHelper?.box;
  const anchor = box ? (box.isEmpty() ? null : box.getCenter(frameAnchor)) : gizmoAnchorCenter(viewer);
  kit.attach(node.matrixWorld, anchor);
}

// A drag started during playback saw stale details (playback suppresses
// their refresh): pause so the commit's own refresh reads the current
// time instead of the animated pose the drag began from.
function pauseOnDragStart() {
  if (gizmoViewer) gizmoViewer.isPlayingAnim = false;
}

// Plain (non-$state) lock: it is only ever read inside the commit
// handler and is never rendered, so a rune adds nothing there.
let gizmoCommitInFlight = false;

// The node's frozen local matrix at drag start: the pose a release hands
// back when the commit authors nothing, so a refused or failed commit
// leaves the node at stage truth instead of the previewed pose.
const latchedNodeMatrix = new THREE.Matrix4();
let previewActive = false;

// Drag-end bookkeeping: on success the previewed pose equals the committed
// truth, so the node keeps it and the scene refresh lands seamlessly; any
// other path hands the node back to its pre-drag (stage-truth) matrix.
function releasePreviewNode(viewer: RendererKit, keepPose: boolean) {
  if (!previewActive) return;
  previewActive = false;
  if (keepPose) return;
  const node = viewer.selectedNode as THREE.Object3D | null;
  if (!node) return;
  node.matrixAutoUpdate = false;
  node.matrix.copy(latchedNodeMatrix);
  node.matrixWorldNeedsUpdate = true;
}

// Re-anchor after a drag: stage truth wins, the commit's true end matrix
// is the fallback when details are gone.
function reattach(gizmo: TransformGizmo, viewer: RendererKit, fallback: THREE.Matrix4) {
  gizmo.attach(gizmoWorldMatrix(viewer) ?? fallback, gizmoAnchorCenter(viewer));
}

export function initGizmo(viewer: RendererKit, getMode: () => GizmoMode) {
  gizmoViewer = viewer;
  mode = getMode;
  // On a component remount this restores the old component-local state
  // semantics: a fresh commit lock and no stale error message.
  gizmoPolicy.error = null;
  gizmoCommitInFlight = false;
  // A remount mid-drag leaves a stale latch behind; a fresh mount starts
  // clean, same as the commit lock above.
  previewActive = false;
  gizmoPolicy.kit = new TransformGizmo(
    viewer.camera,
    viewer.renderer.domElement,
    viewer.scene,
    viewer.controls,
  );
  gizmoPolicy.kit.onCommit = handleGizmoCommit;
  gizmoPolicy.kit.onDragStart = () => {
    pauseOnDragStart();
    const node = viewer.selectedNode as THREE.Object3D | null;
    if (node) {
      latchedNodeMatrix.copy(node.matrix);
      previewActive = true;
    }
  };
  gizmoPolicy.kit.onPreview = (endWorld: THREE.Matrix4) => {
    if (!previewActive) return;
    const node = viewer.selectedNode as THREE.Object3D | null;
    if (!node?.parent) return;
    node.parent.updateWorldMatrix(true, false);
    node.matrixAutoUpdate = false;
    node.matrix.copy(previewLocalMatrix(node.parent.matrixWorld, endWorld));
    node.matrixWorldNeedsUpdate = true;
  };
  viewer.onFrameGizmoSync = () => frameSyncGizmo(viewer);
  // Effects created here run inside the component's initialization
  // (initGizmo is called from onMount), so they live and die with it.
  $effect(() => clearGizmoError());
  $effect(() => syncGizmoAnchor(viewer, mode()));
}

export function disposeGizmo() {
  gizmoPolicy.kit?.dispose();
  gizmoPolicy.kit = null;
  if (gizmoViewer) gizmoViewer.onFrameGizmoSync = null;
}

// Drag end -> desired USD local matrix -> the op(s) to author. The
// parent/world chain cancels in the start/end ratio, so no ancestor
// walk is needed: L' = L * inv(startWorld) * endWorld.
async function handleGizmoCommit(commit: GizmoCommit) {
  // initGizmo always runs first (onCommit is only wired there), so the
  // captured viewer is never null when a commit fires.
  const viewer = gizmoViewer!;
  const gizmo = gizmoPolicy.kit;
  const gizmoMode = mode();
  if (gizmoCommitInFlight) return;
  gizmoCommitInFlight = true;
  // Only a commit that authored everything may keep the previewed pose.
  let keepPreviewPose = false;
  if (gizmo) gizmo.controls.enabled = false;
  try {
    // The math must not run on suppressed details: a playback drag, or a
    // grab inside the window after a manual pause, both leave them stale.
    await stageState.refreshSelectedDetails();
    const details = stageState.details;
    if (!details?.local_transform || !details.world_transform) return;
    const local = new THREE.Matrix4().fromArray(details.local_transform);
    const target = local
      .clone()
      .multiply(commit.startWorld.clone().invert())
      .multiply(commit.endWorld)
      .toArray() as number[];
    if (matricesClose(target, details.local_transform)) {
      if (gizmo) reattach(gizmo, viewer, commit.endWorld);
      return;
    }
    const orderAttribute = details.attributes.find((a) => a.name === "xformOpOrder");
    const order = Array.isArray(orderAttribute?.value.data) ? (orderAttribute!.value.data as string[]) : [];
    const result = composeOpUpdate({
      mode: gizmoMode,
      order,
      attrs: details.attributes,
      localMatrix: details.local_transform,
      targetLocalMatrix: target,
    });
    if (!result.ok) {
      gizmoPolicy.error = result.error;
      if (gizmo) reattach(gizmo, viewer, commit.endWorld);
      return;
    }
    let failed = false;
    for (const write of result.writes) {
      // xformOpOrder is uniform: it authors its default, never a time
      // sample; the op values author at the viewer's current time code.
      const error = await stageState.setAttributeValue(
        write.name,
        { type: write.type, data: write.data },
        write.name === "xformOpOrder" ? null : undefined,
      );
      if (error !== null) {
        gizmoPolicy.error = error;
        failed = true;
        break;
      }
    }
    keepPreviewPose = !failed;
    // Keep commits disabled until fresh details land; a second drag must
    // never compute from the pre-commit local transform.
    if (!failed) await stageState.refreshAfterEdit();
    if (gizmo) reattach(gizmo, viewer, commit.endWorld);
  } finally {
    releasePreviewNode(viewer, keepPreviewPose);
    gizmoCommitInFlight = false;
    if (gizmo) gizmo.controls.enabled = true;
  }
}
