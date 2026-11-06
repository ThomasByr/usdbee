import * as THREE from "three";
import { TransformGizmo, previewLocalMatrix, type GizmoCommit } from "$lib/render/transformGizmo";
import { composeOpUpdate, evaluateGizmoGate, matricesClose, type GizmoMode } from "$lib/render/xformOps";
import { stageState } from "$lib/stage/stageState.svelte";
import { renderState } from "$lib/render/renderState.svelte";
import { refreshSceneAfterEdit } from "$lib/render/sceneIntegration";
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
  if (!node || !getGizmoGate().attachable) {
    // Detach on the closed gate: the anchor effect usually hides the
    // gizmo when the selection clears, but the per-frame sync guarantees
    // it — a closed file, a tab switch or a deselection never leaves the
    // gizmo floating over an empty view.
    kit.detach();
    return;
  }
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

// A commit is not one write: the mode op, its pivot-residual translate and
// xformOpOrder author separately, and each write makes the backend emit a
// usd-stage-changed event. An event handled MID-COMMIT refreshes the scene
// onto an intermediate stage (a new op value the order does not carry yet
// composes as the original pose), which renders as the release snap-back.
// The viewport listener gates its events through gateCommitStageRefresh;
// the commit runs one refresh of its own once its writes are done.
const deferredStagePaths = new Set<string>();

// The viewport's usd-stage-changed gate: while a commit is in flight the
// event's paths are deferred to the commit's own refresh. Returns true when
// the caller must NOT refresh.
export function gateCommitStageRefresh(paths: string[]): boolean {
  if (!gizmoCommitInFlight) return false;
  for (const path of paths) deferredStagePaths.add(path);
  return true;
}

// The one refresh a commit runs: whatever its own writes deferred, seeded
// with the prim it authored (the partial-commit case refreshes that prim
// itself). Ordered so the prim's own paths lead.
function drainDeferredStagePaths(seed: string[]): string[] {
  const paths = [...new Set([...seed, ...deferredStagePaths])];
  deferredStagePaths.clear();
  return paths;
}

// The node's frozen local matrix at drag start: the pose a release hands
// back when the commit authors nothing, so a refused or failed commit
// leaves the node at stage truth instead of the previewed pose.
const latchedNodeMatrix = new THREE.Matrix4();
// The loaded group's world matrix at drag start: the stale-drag guard
// compares in raw USD world space, cancelling THIS matrix out of the
// drag-start pose — a recentering rebuild between attach and commit
// legitimately changes the live one.
const latchedGroupMatrix = new THREE.Matrix4();
let previewActive = false;

// Drag-end bookkeeping: the release pose is a three-way policy. Full
// success keeps the previewed pose (it equals the committed truth, so the
// scene refresh lands seamlessly). A PARTIALLY authored commit (write 1
// landed, write 2 failed) also keeps the pose — the awaited edit refresh
// has already re-posed the node onto the partial stage truth, and a latch
// restore would diverge it from the stage with nothing left to correct
// it. Every other exit (guard refusal, no-op, failed compose, details
// missing, nothing authored at all) hands the node back to its pre-drag
// stage-truth matrix.
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
  deferredStagePaths.clear();
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
    const group = viewer.loadedGroup;
    if (group) {
      group.updateMatrixWorld();
      latchedGroupMatrix.copy(group.matrixWorld);
    } else {
      latchedGroupMatrix.identity();
    }
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
    // Defense in depth against a stale details payload: the commit math
    // must run on the same stack the drag started from, or the op writes
    // could delete ops from xformOpOrder (the rotate-revert bug). The
    // comparison runs in RAW USD world space — the one space a full scene
    // rebuild never touches: recentering between attach and commit
    // legitimately changes the loaded group's matrixWorld
    // (sceneIntegration), so the group matrix latched at drag start is
    // cancelled out of the drag pose instead of the live one.
    const startUSD = latchedGroupMatrix.clone().invert().multiply(commit.startWorld);
    const freshUSD = new THREE.Matrix4().fromArray(details.world_transform);
    if (!matricesClose(freshUSD.toArray() as number[], startUSD.toArray() as number[])) {
      gizmoPolicy.error = "selection changed during the drag; edit not applied";
      if (gizmo) reattach(gizmo, viewer, commit.endWorld);
      return;
    }
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
    // Whether ANY write landed: a partial commit's refresh must run, and
    // its verdict decides the release pose (see releasePreviewNode).
    let authoredAny = false;
    // The write loop must not follow the live selection: the tree (and
    // the tab bar) stay clickable while writes await IPC, so a mid-commit
    // selection change would redirect the later writes onto another
    // prim/stage. Pin the drag's prim and stage for every write.
    const primPath = details.path;
    const stageId = stageState.activeStageId;
    // Hybrid authoring time: on a static stage the op values author at
    // the DEFAULT time — no phantom samples, and the rust caches stay
    // warm across writes (the c5156f2 keep only covers default-time
    // writes). Animated stages keep playhead authoring so an edit lands
    // where the user is looking.
    // shortcut: stage-level granularity, not per-prim; per-prim when
    // animated stages' static prims feel slow to release
    const opTime: number | null = renderState.hasAnimated ? renderState.time : null;
    for (const write of result.writes) {
      // xformOpOrder is uniform: it authors its default, never a time
      // sample.
      const error = await stageState.setAttributeValue(
        write.name,
        { type: write.type, data: write.data },
        write.name === "xformOpOrder" ? null : opTime,
        primPath,
        stageId,
      );
      if (error !== null) {
        gizmoPolicy.error = error;
        failed = true;
        break;
      }
      authoredAny = true;
    }
    keepPreviewPose = !failed;
    if (failed && authoredAny) {
      // Write 1's event refresh already applied the partial truth to the
      // node; restoring the pre-drag latch now would leave the node
      // diverged from the stage with nothing to correct it. Await a scene
      // refresh on the drag's prim: its manifest application re-poses the
      // node onto (partial) stage truth, so the release keeps this pose.
      // Runs inside the try: the controls stay disabled until it lands.
      // Its gated events ride along, so the finally drains nothing here.
      await refreshSceneAfterEdit(viewer, drainDeferredStagePaths([primPath]));
      keepPreviewPose = true;
    }
    // Keep commits disabled until fresh details land; a second drag must
    // never compute from the pre-commit local transform.
    if (!failed) await stageState.refreshAfterEdit();
    if (gizmo) reattach(gizmo, viewer, commit.endWorld);
  } finally {
    // The commit's writes deferred their events: one refresh applies the
    // committed end state, and it must land before the controls come back
    // (a second drag never starts from the pre-commit pose). An empty
    // queue means no write landed, so there is nothing to refresh.
    const deferred = drainDeferredStagePaths([]);
    if (deferred.length > 0) await refreshSceneAfterEdit(viewer, deferred);
    releasePreviewNode(viewer, keepPreviewPose);
    gizmoCommitInFlight = false;
    if (gizmo) gizmo.controls.enabled = true;
  }
}
