// Per-frame gizmo follow + pause-on-drag-start: the gizmo rides the
// animated prim like the orange selection box does, and a drag started
// during playback commits from fresh details (the pause catch-up is
// async, so the commit must await it).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

vi.mock("$lib/stage/stageState.svelte", () => {
  const stageState = {
    activeStageId: 1,
    selectedPath: "/Scene/Prim" as string | null,
    details: null as unknown,
    refreshSelectedDetails: vi.fn(async () => {}),
    setAttributeValue: vi.fn(async () => null),
    refreshAfterEdit: vi.fn(async () => {}),
  };
  return { stageState };
});

import { stageState } from "$lib/stage/stageState.svelte";
import { renderState } from "$lib/render/renderState.svelte";
import type { PrimDetails } from "$lib/stage/types";
import type { RendererKit } from "$lib/three/RendererKit.svelte";
import { disposeGizmo, frameSyncGizmo, gizmoPolicy, initGizmo, syncGizmoAnchor } from "./gizmoCommit.svelte";

const stage = stageState as unknown as {
  selectedPath: string | null;
  details: PrimDetails | null;
  refreshSelectedDetails: ReturnType<typeof vi.fn>;
  setAttributeValue: ReturnType<typeof vi.fn>;
  refreshAfterEdit: ReturnType<typeof vi.fn>;
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translateMatrix(x: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, 0, 0);
}

function translateArray(x: number): number[] {
  return [...IDENTITY.slice(0, 12), x, 0, 0, 1];
}

// A prim whose only authored op is a translate: enough for the commit path
// to author one op value.
function detailsAt(x: number): PrimDetails {
  return {
    path: "/Scene/Prim",
    type_name: "Xform",
    kind: "component",
    is_active: true,
    is_instance: false,
    is_abstract: false,
    instance_of: null,
    attributes: [
      {
        name: "xformOpOrder",
        type_name: "token[]",
        variability: "uniform",
        authored: true,
        value: { type: "token_array", data: ["xformOp:translate"] },
      },
      {
        name: "xformOp:translate",
        type_name: "double3",
        variability: "varying",
        authored: true,
        value: { type: "vec3d", data: [x, 0, 0] },
      },
    ],
    metadata: [],
    variant_sets: [],
    composition_arcs: [],
    local_transform: translateArray(x),
    world_transform: translateArray(x),
  };
}

// The camera/scene/orbit triple plus the per-frame pose source the gizmo
// policy reads; the domElement only needs the listener surface.
function makeViewer(node: THREE.Object3D | null): RendererKit {
  const domElement = {
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
  };
  return {
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement },
    scene: new THREE.Scene(),
    controls: { enabled: true },
    loadedGroup: null,
    selectionHelper: null,
    selectedNode: node,
    isPlayingAnim: false,
  } as unknown as RendererKit;
}

function proxy(): THREE.Object3D {
  return gizmoPolicy.kit!.controls.object as THREE.Object3D;
}

function commit(start: number, end: number): Promise<void> {
  return gizmoPolicy.kit!.onCommit!({
    startWorld: translateMatrix(start),
    endWorld: translateMatrix(end),
  }) as unknown as Promise<void>;
}

beforeEach(() => {
  renderState.hasAnimated = false;
  renderState.time = null;
  stage.selectedPath = "/Scene/Prim";
  stage.details = null;
  stage.refreshSelectedDetails.mockReset();
  stage.refreshSelectedDetails.mockResolvedValue(undefined);
  stage.setAttributeValue.mockReset();
  stage.setAttributeValue.mockResolvedValue(null);
  stage.refreshAfterEdit.mockReset();
  stage.refreshAfterEdit.mockResolvedValue(undefined);
});

afterEach(() => {
  disposeGizmo();
});

describe("frameSyncGizmo", () => {
  it("follows the selected node every frame, anchored on the selection box", () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.position.set(100, 10, 0);
    group.add(mesh);
    const viewer = makeViewer(group);
    const box = new THREE.Box3().setFromObject(group, true);
    viewer.selectionHelper = { box } as unknown as THREE.Box3Helper;
    stage.details = detailsAt(0);
    initGizmo(viewer, () => "translate");
    expect(viewer.onFrameGizmoSync).toBeTypeOf("function");

    const setFromObject = vi.spyOn(THREE.Box3.prototype, "setFromObject");
    frameSyncGizmo(viewer);
    expect(proxy().position.x).toBeCloseTo(100, 6);
    expect(proxy().position.y).toBeCloseTo(10, 6);

    // A static prim re-synced every frame must not drift.
    frameSyncGizmo(viewer);
    expect(proxy().position.x).toBeCloseTo(100, 6);
    expect(proxy().position.y).toBeCloseTo(10, 6);

    // The node animates and the renderer recomputes the helper box in the
    // same frame block: the gizmo rides along through the frame hook.
    group.position.set(0, 50, 0);
    group.updateMatrixWorld(true);
    box.setFromObject(group, true);
    setFromObject.mockClear();
    viewer.onFrameGizmoSync!();
    expect(proxy().position.y).toBeCloseTo(60, 6);
    // No second subtree traversal for the anchor.
    expect(setFromObject).not.toHaveBeenCalled();
    setFromObject.mockRestore();
  });

  it("keeps the drag latch: no re-anchor while dragging", () => {
    const node = new THREE.Object3D();
    const viewer = makeViewer(node);
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2));
    viewer.selectionHelper = { box } as unknown as THREE.Box3Helper;
    stage.details = detailsAt(0);
    initGizmo(viewer, () => "translate");
    frameSyncGizmo(viewer);
    const anchorPose = proxy().position.clone();
    expect(anchorPose.x).toBeCloseTo(1, 6);

    // A drag owns the pose: the drag-start latch must not be disturbed.
    node.position.set(9, 9, 9);
    node.updateMatrixWorld(true);
    gizmoPolicy.kit!.controls.dragging = true;
    frameSyncGizmo(viewer);
    expect(proxy().position.equals(anchorPose)).toBe(true);
  });

  it("leaves the pose alone without a selection or with a closed gate", () => {
    const node = new THREE.Object3D();
    const viewer = makeViewer(node);
    viewer.selectionHelper = {
      box: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2)),
    } as unknown as THREE.Box3Helper;
    stage.details = detailsAt(0);
    initGizmo(viewer, () => "translate");
    frameSyncGizmo(viewer);
    const anchorPose = proxy().position.clone();

    // A sync would move the proxy to this pose if it ran.
    node.position.set(9, 9, 9);
    node.updateMatrixWorld(true);

    viewer.selectedNode = null;
    frameSyncGizmo(viewer);
    expect(proxy().position.equals(anchorPose)).toBe(true);

    // Details gone: the gate closes.
    viewer.selectedNode = node;
    stage.details = null;
    frameSyncGizmo(viewer);
    expect(proxy().position.equals(anchorPose)).toBe(true);
  });
});

describe("syncGizmoAnchor", () => {
  it("leaves the proxy alone mid-drag and re-anchors once the drag ends", () => {
    // An empty node has no bbox, so the pose comes straight from details.
    const viewer = makeViewer(new THREE.Object3D());
    stage.details = detailsAt(0);
    initGizmo(viewer, () => "translate");
    syncGizmoAnchor(viewer, "translate");
    const anchorPose = proxy().position.clone();
    expect(anchorPose.x).toBeCloseTo(0, 6);

    // The pause catch-up lands mid-drag: re-attaching would snap the proxy
    // back and corrupt the commit math.
    gizmoPolicy.kit!.controls.dragging = true;
    stage.details = detailsAt(5);
    syncGizmoAnchor(viewer, "translate");
    expect(proxy().position.equals(anchorPose)).toBe(true);

    // Drag over: the same sync restores the pose from fresh data.
    gizmoPolicy.kit!.controls.dragging = false;
    syncGizmoAnchor(viewer, "translate");
    expect(proxy().position.x).toBeCloseTo(5, 6);
  });
});

describe("stale stack guard", () => {
  it("refuses a commit whose details went stale mid-drag", async () => {
    // The drag started at world 5, but the details still describe the
    // pre-drag pose (a superseded refresh): authoring from them would
    // write ops computed against the wrong stack. No writes may land.
    const viewer = makeViewer(new THREE.Object3D());
    stage.details = detailsAt(1);
    initGizmo(viewer, () => "translate");

    await commit(5, 8);

    expect(stage.setAttributeValue).not.toHaveBeenCalled();
    expect(stage.refreshAfterEdit).not.toHaveBeenCalled();
    expect(gizmoPolicy.error).toContain("selection changed during the drag");
  });

  it("commits when the fresh details match the drag-start pose", async () => {
    const viewer = makeViewer(new THREE.Object3D());
    stage.details = detailsAt(5);
    initGizmo(viewer, () => "translate");

    await commit(5, 8);

    expect(gizmoPolicy.error).toBeNull();
    expect(stage.setAttributeValue).toHaveBeenCalledWith(
      "xformOp:translate",
      { type: "double3", data: [8, 0, 0] },
      null,
    );
  });
});

describe("hybrid authoring time", () => {
  it("authors op values at the default time on a static stage", async () => {
    // Static stage: default-time writes keep the rust caches warm and
    // author no phantom time samples.
    const viewer = makeViewer(new THREE.Object3D());
    stage.details = detailsAt(5);
    initGizmo(viewer, () => "translate");

    await commit(5, 8);

    expect(stage.setAttributeValue).toHaveBeenCalledWith(
      "xformOp:translate",
      { type: "double3", data: [8, 0, 0] },
      null,
    );
  });

  it("authors op values at the playhead on an animated stage", async () => {
    renderState.hasAnimated = true;
    renderState.time = 5;
    const viewer = makeViewer(new THREE.Object3D());
    stage.details = detailsAt(5);
    initGizmo(viewer, () => "translate");

    await commit(5, 8);

    expect(stage.setAttributeValue).toHaveBeenCalledWith(
      "xformOp:translate",
      { type: "double3", data: [8, 0, 0] },
      5,
    );
  });
});

describe("pause on gizmo drag start", () => {
  it("pauses playback and commits from fresh details", async () => {
    const viewer = makeViewer(new THREE.Object3D());
    viewer.isPlayingAnim = true;
    // Stale pose: playback suppressed the details refresh.
    stage.details = detailsAt(1);
    initGizmo(viewer, () => "translate");

    gizmoPolicy.kit!.controls.dispatchEvent({ type: "dragging-changed", value: true });
    expect(viewer.isPlayingAnim).toBe(false);
    // The pause only stops playback: the commit refreshes on its own.
    expect(stage.refreshSelectedDetails).not.toHaveBeenCalled();

    // The pause catch-up is async: hold it open to pin the ordering.
    let release!: () => void;
    stage.refreshSelectedDetails.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            stage.details = detailsAt(5);
            resolve();
          };
        }),
    );

    // The drag moved the prim +3 from its animated pose at 5.
    const pending = commit(5, 8);
    expect(stage.refreshSelectedDetails).toHaveBeenCalledTimes(1);
    expect(stage.setAttributeValue).not.toHaveBeenCalled();

    release();
    await pending;
    // Fresh details (5) + the +3 delta: the stale 1 would author 4.
    expect(stage.setAttributeValue).toHaveBeenCalledWith(
      "xformOp:translate",
      { type: "double3", data: [8, 0, 0] },
      null,
    );
  });

  it("commits from fresh details after a manual pause too", async () => {
    // The user paused with the button and grabbed the gizmo inside the
    // catch-up window: no drag-start pause fires here, details are stale.
    const viewer = makeViewer(new THREE.Object3D());
    viewer.isPlayingAnim = false;
    stage.details = detailsAt(1);
    initGizmo(viewer, () => "translate");

    let release!: () => void;
    stage.refreshSelectedDetails.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            stage.details = detailsAt(5);
            resolve();
          };
        }),
    );

    const pending = commit(5, 8);
    expect(stage.refreshSelectedDetails).toHaveBeenCalledTimes(1);
    expect(stage.setAttributeValue).not.toHaveBeenCalled();

    release();
    await pending;
    // Fresh details (5) + the +3 delta: the stale 1 would author 4.
    expect(stage.setAttributeValue).toHaveBeenCalledWith(
      "xformOp:translate",
      { type: "double3", data: [8, 0, 0] },
      null,
    );

    // Unconditional per commit, not a latch: a later commit refreshes again.
    stage.refreshSelectedDetails.mockReset();
    stage.refreshSelectedDetails.mockResolvedValue(undefined);
    await commit(5, 8);
    expect(stage.refreshSelectedDetails).toHaveBeenCalledTimes(1);
  });
});
