// Move -> rotate regression (the rotate-reverted-the-move bug): drives the
// REAL gizmoCommit / renderState / stageState modules against a fake
// in-memory "Rust stage" (authored xformOpOrder + op values), with
// controllable IPC interleavings. The supersede hole in selectPrim let a
// stale pre-move details payload reach the rotate commit's math, which
// then authored xformOpOrder without the move's translate op.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import { invoke } from "@tauri-apps/api/core";
import { renderState } from "$lib/render/renderState.svelte";
import { stageState } from "$lib/stage/stageState.svelte";
import { disposeGizmo, frameSyncGizmo, gizmoPolicy, initGizmo } from "$lib/render/gizmoCommit.svelte";
import type { RendererKit } from "$lib/three/RendererKit.svelte";
import type { PrimDetails, RenderNode } from "$lib/stage/types";

const PATH = "/Scene/Shape";
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

type Vec = [number, number, number];

interface FakeStage {
  order: string[];
  translate: Vec;
  rotateXYZ: Vec;
}

let stage: FakeStage = { order: [], translate: [0, 0, 0], rotateXYZ: [0, 0, 0] };

function axisRotation(axis: "X" | "Y" | "Z", deg: number): THREE.Matrix4 {
  const r = (deg * Math.PI) / 180;
  if (axis === "X") return new THREE.Matrix4().makeRotationX(r);
  if (axis === "Y") return new THREE.Matrix4().makeRotationY(r);
  return new THREE.Matrix4().makeRotationZ(r);
}

// Mirrors xformOps.opMatrix: list-order product, rotateXYZ = Rz*Ry*Rx.
function opMatrix(entry: string): THREE.Matrix4 | null {
  if (entry === "xformOp:translate") return new THREE.Matrix4().makeTranslation(...stage.translate);
  if (entry === "xformOp:rotateXYZ") {
    return axisRotation("Z", stage.rotateXYZ[2])
      .multiply(axisRotation("Y", stage.rotateXYZ[1]))
      .multiply(axisRotation("X", stage.rotateXYZ[0]));
  }
  return null;
}

function composedLocal(): THREE.Matrix4 {
  const out = new THREE.Matrix4();
  for (const entry of stage.order) {
    const m = opMatrix(entry);
    if (m) out.multiply(m);
  }
  return out;
}

function localArray(): number[] {
  return composedLocal().toArray() as number[];
}

function manifestSnapshot(): RenderNode[] {
  const mk = (path: string, transform: number[], children: RenderNode[] = []): RenderNode => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    type_name: "Xform",
    has_geometry: false,
    animated: false,
    geometry_animated: false,
    material: null,
    instances: [],
    transform,
    visible: true,
    children,
  });
  return [mk("/Scene", IDENTITY, [mk(PATH, localArray())])];
}

// get_prim_details payload for the AUTHORED state right now.
function detailsSnapshot(): PrimDetails {
  const attributes: PrimDetails["attributes"] = [
    {
      name: "xformOpOrder",
      type_name: "token[]",
      variability: "uniform",
      authored: stage.order.length > 0,
      value: { type: "token_array", data: [...stage.order] },
    },
  ];
  if (stage.order.includes("xformOp:translate")) {
    attributes.push({
      name: "xformOp:translate",
      type_name: "double3",
      variability: "varying",
      authored: true,
      value: { type: "vec3d", data: [...stage.translate] },
    });
  }
  if (stage.order.includes("xformOp:rotateXYZ")) {
    attributes.push({
      name: "xformOp:rotateXYZ",
      type_name: "float3",
      variability: "varying",
      authored: true,
      value: { type: "vec3f", data: [...stage.rotateXYZ] },
    });
  }
  const local = localArray();
  return {
    path: PATH,
    type_name: "Xform",
    kind: "component",
    is_active: true,
    is_instance: false,
    is_abstract: false,
    instance_of: null,
    attributes,
    metadata: [],
    variant_sets: [],
    composition_arcs: [],
    local_transform: local,
    world_transform: local,
  };
}

// --- IPC fake + holds --------------------------------------------------

const mockedInvoke = vi.mocked(invoke);
const writeLog: { name: string; data: unknown; path: string; stageId: number }[] = [];
let onWrite: () => void = () => {};

let holdNextWrites = 0;
const heldWrites: (() => void)[] = [];
// A write matching this name fails (backend error) instead of authoring:
// the partial-commit tests need write 2 to fail after write 1 landed.
let failWriteName: string | null = null;

function releaseWrites(n = 1) {
  const batch = heldWrites.splice(0, n);
  batch.forEach((h) => h());
  return batch.length;
}

let holdNextManifests = 0;
const heldManifests: (() => void)[] = [];
let holdNextDetails = 0;
const heldDetails: (() => void)[] = [];

function releaseManifests() {
  const batch = heldManifests.splice(0);
  batch.forEach((d) => d());
  return batch.length;
}

function releaseDetails(n = 1) {
  const batch = heldDetails.splice(0, n);
  batch.forEach((h) => h());
  return batch.length;
}

function write(name: string, data: unknown) {
  if (name === "xformOpOrder") stage.order = [...(data as string[])];
  else if (name === "xformOp:translate") stage.translate = [...(data as Vec)];
  else if (name === "xformOp:rotateXYZ") stage.rotateXYZ = [...(data as Vec)];
  else throw new Error(`unexpected write ${name}`);
}

function installBackend() {
  mockedInvoke.mockImplementation((async (cmd: string, args: any) => {
    switch (cmd) {
      case "get_scene_manifest": {
        const snap = manifestSnapshot();
        if (holdNextManifests > 0) {
          holdNextManifests -= 1;
          return new Promise<RenderNode[]>((resolve) => heldManifests.push(() => resolve(snap)));
        }
        return snap;
      }
      case "get_prim_details": {
        const snap = detailsSnapshot();
        if (holdNextDetails > 0) {
          holdNextDetails -= 1;
          return new Promise<PrimDetails>((resolve) => heldDetails.push(() => resolve(snap)));
        }
        return snap;
      }
      case "get_stage_tree":
        return [
          {
            path: "/Scene",
            name: "Scene",
            type_name: "Xform",
            kind: "group",
            is_active: true,
            is_instance: false,
            is_abstract: false,
            children: [
              {
                path: PATH,
                name: "Shape",
                type_name: "Xform",
                kind: "component",
                is_active: true,
                is_instance: false,
                is_abstract: false,
                children: [],
              },
            ],
          },
        ];
      case "get_time_codes":
        return [];
      case "set_attribute_value": {
        const done = () => {
          if (failWriteName !== null && args.name === failWriteName)
            return Promise.reject("backend write failed");
          write(args.name, args.value.data);
          writeLog.push({ name: args.name, data: args.value.data, path: args.path, stageId: args.stageId });
          onWrite();
          return null;
        };
        if (holdNextWrites > 0) {
          holdNextWrites -= 1;
          return new Promise((resolve) => heldWrites.push(() => resolve(done())));
        }
        return done();
      }
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  }) as any);
}

// --- viewer + gizmo ----------------------------------------------------

let viewer: RendererKit;
let mode: "translate" | "rotate" | "scale" = "translate";
let pendingCommit: Promise<unknown> | null = null;

function node(): THREE.Object3D {
  return (viewer.loadedGroup as THREE.Group).getObjectByName(PATH) as THREE.Object3D;
}

function proxy(): THREE.Object3D {
  return gizmoPolicy.kit!.controls.object as THREE.Object3D;
}

async function boot() {
  installBackend();
  stageState.activeStageId = 1;
  stageState.status = "ready";
  stageState.selectedPath = PATH;
  stageState.stageInfo = {
    stage_id: 1,
    root_layer: "/tmp/fake.usda",
    time_codes_per_second: 24,
    start_time_code: 0,
    end_time_code: 24,
    composition_errors: [],
    up_axis: "Y",
  } as any;

  const domElement = { addEventListener: () => {}, removeEventListener: () => {}, style: {} };
  viewer = {
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement },
    scene: new THREE.Scene(),
    controls: { enabled: true },
    loadedGroup: null,
    selectionHelper: null,
    selectedNode: null,
    isPlayingAnim: false,
  } as unknown as RendererKit;

  const group = await renderState.loadRenderScene(0);
  viewer.loadedGroup = group;
  viewer.scene!.add(group!);
  viewer.selectedNode = group!.getObjectByName(PATH) as THREE.Object3D;
  // A drawable child so the wrapper carries the transform (real gprim shape).
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  mesh.visible = false;
  node().add(mesh);
  viewer.selectionHelper = {
    box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
  } as unknown as THREE.Box3Helper;
  await stageState.refreshSelectedDetails();

  initGizmo(viewer, () => mode);
  const handler = gizmoPolicy.kit!.onCommit!;
  gizmoPolicy.kit!.onCommit = (commit) => {
    pendingCommit = handler(commit) as unknown as Promise<unknown>;
  };
}

function beginDrag(mutate: (p: THREE.Object3D) => void) {
  const kit = gizmoPolicy.kit!;
  // The real helper's box tracks the node every frame; recenter it so the
  // rotate anchor rides the prim like it does in the viewport.
  node().updateWorldMatrix(true, false);
  viewer.selectionHelper!.box.setFromCenterAndSize(
    node().getWorldPosition(new THREE.Vector3()),
    new THREE.Vector3(2, 2, 2),
  );
  frameSyncGizmo(viewer);
  kit.controls.dragging = true;
  kit.controls.dispatchEvent({ type: "dragging-changed", value: true });
  mutate(proxy());
  proxy().updateMatrix();
  kit.controls.dispatchEvent({ type: "objectChange" });
}

function endDrag() {
  const kit = gizmoPolicy.kit!;
  kit.controls.dragging = false;
  kit.controls.dispatchEvent({ type: "dragging-changed", value: false });
  return pendingCommit;
}

async function drag(mutate: (p: THREE.Object3D) => void, between?: () => Promise<void>) {
  beginDrag(mutate);
  if (between) await between();
  const pending = endDrag();
  await pending;
}

function flush() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mockedInvoke.mockReset();
  writeLog.length = 0;
  holdNextWrites = 0;
  heldWrites.length = 0;
  failWriteName = null;
  holdNextManifests = 0;
  heldManifests.length = 0;
  holdNextDetails = 0;
  heldDetails.length = 0;
  mode = "translate";
  onWrite = () => {};
  stage = { order: [], translate: [0, 0, 0], rotateXYZ: [0, 0, 0] };
  renderState.time = null;
  renderState.timeCodes = [];
  renderState.status = "idle";
  stageState.status = "idle";
  stageState.selectedPath = null;
  stageState.details = null;
  pendingCommit = null;
});

afterEach(() => {
  disposeGizmo();
});

describe("move then rotate keeps the moved position", () => {
  async function moveThenRotate(opts: {
    holdBetweenWrites?: boolean;
    releaseAt: "mid-drag" | "after-commit" | "after-drain";
    existingOp?: boolean;
  }) {
    if (opts.existingOp) stage.order = ["xformOp:translate"];
    onWrite = () => {
      if (opts.holdBetweenWrites && writeLog.length === 1) holdNextManifests += 1;
      void renderState.refreshAfterEdit([PATH]);
      void stageState.refreshAfterEdit();
    };
    await boot();
    await drag((p) => p.position.set(p.position.x + 5, p.position.y, p.position.z));
    await flush();
    mode = "rotate";
    await drag(
      (p) => {
        p.rotation.z += Math.PI / 2;
      },
      async () => {
        if (opts.releaseAt === "mid-drag") {
          releaseManifests();
          await flush();
        }
      },
    );
    if (opts.releaseAt === "after-commit") {
      releaseManifests();
      await flush();
    }
    if (opts.releaseAt === "after-drain") {
      await flush();
      releaseManifests();
      await flush();
      await flush();
    }
    await flush();
    await flush();
    return node().matrix.elements[12];
  }

  it("baseline: the rotate keeps the moved position", async () => {
    const tx = await moveThenRotate({ releaseAt: "mid-drag" });
    expect(tx).toBeCloseTo(5, 6);
  });

  it("stale manifest mid-rotate-drag", async () => {
    const tx = await moveThenRotate({ holdBetweenWrites: true, releaseAt: "mid-drag" });
    expect(tx).toBeCloseTo(5, 6);
  });

  it("stale manifest after the rotate commit", async () => {
    const tx = await moveThenRotate({ holdBetweenWrites: true, releaseAt: "after-commit" });
    expect(tx).toBeCloseTo(5, 6);
  });

  it("stale manifest after the queue drain (last writer)", async () => {
    const tx = await moveThenRotate({ holdBetweenWrites: true, releaseAt: "after-drain" });
    expect(tx).toBeCloseTo(5, 6);
  });

  it("existing translate op (1-write move)", async () => {
    const tx = await moveThenRotate({ holdBetweenWrites: true, releaseAt: "mid-drag", existingOp: true });
    expect(tx).toBeCloseTo(5, 6);
  });
});

describe("stale details payload at the rotate commit", () => {
  // The supersede hole in stageState.selectPrim: the commit's awaited
  // details refresh resolved while a newer selectPrim was in flight, so
  // the commit read a pre-move snapshot and authored xformOpOrder
  // WITHOUT the move's translate op — the persistent revert.
  it("re-runs the superseded refresh and keeps the translate op in the order", async () => {
    onWrite = () => {
      void renderState.refreshAfterEdit([PATH]);
      void stageState.refreshAfterEdit();
    };
    await boot();
    await drag((p) => p.position.set(p.position.x + 5, p.position.y, p.position.z));
    await flush();

    // Snapshot of the stack BEFORE the move: nothing authored yet.
    stage.translate = [5, 0, 0];
    stage.order = [];
    const betweenWrites = detailsSnapshot(); // translate authored, order empty
    stage.order = ["xformOp:translate"];
    const parked = betweenWrites;

    mode = "rotate";
    // Park the commit's own details fetch AND a newer superseding fetch.
    holdNextDetails = 2;
    beginDrag((p) => {
      p.rotation.z += Math.PI / 2;
    });
    const pending = endDrag();
    await flush();
    // A newer selectPrim lands first and supersedes the commit's fetch.
    void stageState.selectPrim(PATH);
    await flush();
    // ...and the payload on screen is still the stale one.
    stageState.details = parked;
    holdNextDetails = 1;
    void stageState.selectPrim(PATH); // keep one in flight so the stale stays
    await flush();
    releaseDetails(1); // the commit's fetch: assignment dropped
    await flush();
    releaseDetails(1);
    await pending;
    await flush();
    await flush();

    // The commit must have re-run its refresh on fresh details: the
    // move's translate op stays in xformOpOrder and the prim keeps its
    // moved position (rotated), instead of reverting to the pre-move one.
    expect(stage.order).toContain("xformOp:translate");
    expect(node().matrix.elements[12]).toBeCloseTo(5, 6);
  });
});

describe("commit writes follow the drag's prim, not the live selection", () => {
  // The tree stays clickable while a commit's writes await IPC: a
  // selection change (or a tab switch) mid-commit must not redirect the
  // later writes onto another prim/stage.
  it("authors both writes on the original prim when the selection changes mid-commit", async () => {
    await boot();
    // A tree click lands the instant write 1 resolves: the live selection
    // (and the active tab's stage) change while write 2 is still pending.
    onWrite = () => {
      if (writeLog.length === 1) {
        stageState.selectedPath = "/Scene";
        stageState.activeStageId = 2;
      }
    };
    holdNextWrites = 2;
    beginDrag((p) => p.position.set(p.position.x + 5, p.position.y, p.position.z));
    const pending = endDrag();
    await flush();
    releaseWrites(1); // write 1 resolves; the selection flips right here
    await flush(); // write 2 (xformOpOrder) computes its target
    releaseWrites(1);
    await pending;
    await flush();

    const commitWrites = writeLog.filter((w) => w.name.startsWith("xformOp"));
    expect(commitWrites).toHaveLength(2);
    expect(
      commitWrites.every((w) => w.path === PATH && w.stageId === 1),
      `writes went to ${JSON.stringify(commitWrites.map((w) => [w.path, w.stageId]))}`,
    ).toBe(true);
    expect(stage.order).toEqual(["xformOp:translate"]);
  });
});

describe("a partially authored commit lands on stage truth", () => {
  it("keeps the refreshed partial truth instead of the pre-drag latch when write 2 fails", async () => {
    // Both ops exist, so the rotate drag emits exactly two writes: the
    // rotateXYZ update and the pivot-residual translate update. Write 2
    // fails on the backend after write 1 already landed: the node must
    // sit on the stage's PARTIAL truth (rotated, stale translate), not
    // snap back to the pre-drag latch.
    stage.order = ["xformOp:rotateXYZ", "xformOp:translate"];
    stage.translate = [3, 0, 0];
    failWriteName = "xformOp:translate";
    mode = "rotate";
    // The viewport's usd-stage-changed listener refreshes the scene as
    // write 1 lands (partial truth reaches the node before write 2 fails).
    onWrite = () => {
      void renderState.refreshAfterEdit([PATH]);
    };
    await boot();
    await drag((p) => {
      p.rotation.z += Math.PI / 2; // pivot at (3, 0, 0): a translate residual
    });
    await flush();
    await flush();

    expect(gizmoPolicy.error).toContain("backend write failed");
    // Write 1 landed; write 2 was refused by the backend.
    expect(writeLog.map((w) => w.name)).toEqual(["xformOp:rotateXYZ"]);
    const truth = composedLocal().toArray() as number[]; // Rz(90) * T(3)
    const latch = new THREE.Matrix4().makeTranslation(3, 0, 0).toArray() as number[];
    const elements = node().matrix.elements;
    for (let i = 0; i < 16; i++) {
      expect(Math.abs(elements[i] - truth[i])).toBeLessThan(1e-6);
    }
    expect(truth).not.toEqual(latch); // control: the two poses genuinely differ
  });
});
