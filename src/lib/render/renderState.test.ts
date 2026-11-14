// renderState tests (Phase 2, Task 4): the stale-response lesson from
// stageState (Phase 1) — a manifest response from a superseded load must
// never reach the viewport.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import {
  advanceStageTime,
  prefetchPoses,
  renderState,
  snapToTimeCodes,
  snapToPlayableTime,
  toAbsoluteTime,
  toPlayheadOffset,
} from "./renderState.svelte";
import { POSE_PREFETCH, poseCoverage, invalidatePoseBuffer } from "./posePrefetch";
import * as frameDiag from "../perf/frameDiag";
import { disposeScene, GEOMETRY_BATCH_SIZE } from "./sceneBuilder";
import type { MaterialInfo, RenderNode } from "../stage/types";
import { stageState } from "../stage/stageState.svelte";
import { consumeShadowUpdate } from "../three/shadowMapUpdate";
import { encodePoseBatch, encodePoseFrame, type PoseFixtureNode } from "./poseFrameFixture";

const mockedInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  renderState.time = null;
  renderState.timeCodes = [];
  consumeShadowUpdate();
});

describe("renderState", () => {
  it("loads an empty manifest into a ready state", async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    const group = await renderState.loadRenderScene();

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", {
      stageId: stageState.activeStageId,
      time: 0,
    });
    expect(group).toBeTruthy();
    expect(group!.children).toHaveLength(0);
    expect(renderState.status).toBe("ready");
    expect(renderState.error).toBeNull();
  });

  it("resets stale stage time to the new stage start on load", async () => {
    renderState.time = 99;
    mockedInvoke.mockResolvedValueOnce([]);

    await renderState.loadRenderScene(10);

    expect(renderState.time).toBe(10);
    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", {
      stageId: stageState.activeStageId,
      time: 10,
    });
  });

  it("caches the stage's authored time codes on load", async () => {
    mockedInvoke
      .mockResolvedValueOnce([]) // manifest
      .mockResolvedValueOnce([0, 12, 24]); // get_time_codes

    await renderState.loadRenderScene();
    await Promise.resolve();

    expect(mockedInvoke).toHaveBeenCalledWith("get_time_codes", {
      stageId: stageState.activeStageId,
    });
    expect(renderState.timeCodes).toEqual([0, 12, 24]);
  });

  it("keeps the time-code fetch valid across playback steps", async () => {
    // Autoplay's first step can land before the codes IPC resolves (the
    // fetch is detached). The reply still belongs to the current load, so a
    // step must not make it look stale.
    const codes = deferred<number[]>();
    mockedInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_scene_manifest") return [];
      if (cmd === "get_time_codes") return codes.promise;
      if (cmd === "get_animated_pose") return poseFrame([], packedBatch([]));
      throw new Error(`unexpected command: ${cmd}`);
    }) as any);

    await renderState.loadRenderScene();
    // Two steps before the codes land: the second is deduped, the counter
    // moved twice regardless.
    await renderState.setStageTime(12);
    await renderState.setStageTime(13);
    codes.resolve([0, 12, 24]);
    // Two microtask hops: the mock's async wrapper, then the IIFE's await.
    await Promise.resolve();
    await Promise.resolve();

    expect(renderState.timeCodes).toEqual([0, 12, 24]);
  });

  it("discards the time codes of a load superseded before they land", async () => {
    const staleCodes = deferred<number[]>();
    mockedInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_scene_manifest") return [];
      if (cmd === "get_time_codes") return staleCodes.promise;
      throw new Error(`unexpected command: ${cmd}`);
    }) as any);
    await renderState.loadRenderScene();

    mockedInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_scene_manifest") return [];
      if (cmd === "get_time_codes") return [0, 12];
      throw new Error(`unexpected command: ${cmd}`);
    }) as any);
    await renderState.loadRenderScene();
    await Promise.resolve();

    staleCodes.resolve([7, 8]);
    await Promise.resolve();

    expect(renderState.timeCodes).toEqual([0, 12]);
  });

  it("discards the time codes of a load that failed", async () => {
    const staleCodes = deferred<number[]>();
    mockedInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_scene_manifest") return [];
      if (cmd === "get_time_codes") return staleCodes.promise;
      throw new Error(`unexpected command: ${cmd}`);
    }) as any);
    await renderState.loadRenderScene();

    mockedInvoke.mockRejectedValueOnce("reload blew up");
    await renderState.loadRenderScene();
    expect(renderState.status).toBe("error");

    staleCodes.resolve([0, 12]);
    await Promise.resolve();

    expect(renderState.timeCodes).toEqual([]);
  });

  it("discards a stale manifest response after a newer load", async () => {
    const stale = deferred<never>();
    mockedInvoke.mockReturnValueOnce(stale.promise);
    const staleLoad = renderState.loadRenderScene();

    mockedInvoke.mockResolvedValueOnce([]);
    const currentLoad = renderState.loadRenderScene();
    const current = await currentLoad;
    expect(current).toBeTruthy();
    expect(renderState.status).toBe("ready");

    // The stale manifest resolves after the newer scene was built: it must
    // be discarded, not committed.
    stale.resolve([] as never);
    expect(await staleLoad).toBeNull();
    expect(renderState.status).toBe("ready");
  });

  it("records a failed manifest fetch as an error", async () => {
    mockedInvoke.mockRejectedValueOnce("manifest blew up");

    const group = await renderState.loadRenderScene();

    expect(group).toBeNull();
    expect(renderState.status).toBe("error");
    expect(renderState.error).toBe("manifest blew up");
  });

  it("releases the old scene after a failed reload so time steps cannot mutate it", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", transform: translate(1) });
    const group = await loadScene(() => [wobble]);

    mockedInvoke.mockRejectedValueOnce("reload blew up");
    const reloaded = await renderState.loadRenderScene();
    expect(reloaded).toBeNull();
    expect(renderState.status).toBe("error");
    expect(renderState.error).toBe("reload blew up");

    // A dead scene must not be stepped: no IPC, no mutation of the old group.
    mockIpc(() => [node({ ...wobble, transform: translate(9) })]);
    mockedInvoke.mockClear();
    await renderState.setStageTime(5);

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(group.children[0].matrix.elements[12]).toBe(1);
  });
});

// --- Task 6: time codes end-to-end ------------------------------------

// A valid packed geometry payload for one triangle (layout: geometryDecoder).
// `y` parameterizes the third vertex's height so tests can tell payloads apart.
function packedGeometry(y = 1): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + 9 * 4 + 3 * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 3, true);
  view.setUint32(12, 3, true);
  view.setUint32(16, 0, true);
  new Float32Array(buffer, 20, 9).set([-1, 0, 0, 1, 0, 0, 0, y, 0]);
  new Uint32Array(buffer, 20 + 36, 3).set([0, 1, 2]);
  return buffer;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A payload with a custom vertex/index count (positions zeroed, indices
// sequential): layout-INcompatible with the default triangle frame.
function packedGeometryCounts(vertexCount: number, indexCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + vertexCount * 9 * 4 + indexCount * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, indexCount, true);
  view.setUint32(16, 0, true);
  new Uint32Array(buffer, 20 + vertexCount * 12, indexCount).set(
    Array.from({ length: indexCount }, (_, i) => i % vertexCount),
  );
  return buffer;
}

function translate(x: number): number[] {
  return [...IDENTITY.slice(0, 12), x, 0, 0, 1];
}

function node(overrides: Partial<RenderNode>): RenderNode {
  return {
    path: "/Scene",
    name: "Scene",
    type_name: "Xform",
    has_geometry: false,
    animated: false,
    geometry_animated: false,
    material: null,
    instances: [],
    transform: IDENTITY,
    visible: true,
    children: [],
    ...overrides,
  };
}

// Dispatches the IPC commands sceneBuilder drives; `manifest`
// supplies the answer for get_scene_manifest AND the playback pose
// (the step fetches the delta through the merged pose command).
function mockIpc(manifest: () => RenderNode[] | Promise<RenderNode[]>) {
  const dispatcher = async (cmd: string, args: any) => {
    if (cmd === "get_scene_manifest") return manifest();
    if (cmd === "get_animated_pose") {
      const nodes = await manifest();
      return poseFrame(nodes, packedBatchGeometry(1, animatedPaths(nodes).length));
    }
    if (cmd === "get_animated_pose_batch") {
      const nodes = await manifest();
      const frame = poseFrame(nodes, packedBatchGeometry(1, animatedPaths(nodes).length));
      return poseBatch(args.times.map(() => frame));
    }
    if (cmd === "get_time_codes") return [];
    if (cmd === "get_geometry_data") return packedGeometry();
    if (cmd === "get_geometry_batch") return packedBatchGeometry(1, args.paths.length);
    if (cmd === "get_material_data") return { name: "Mat", surface: null };
    if (cmd === "get_material_batch") return packedBatchMaterials(args.paths.length);
    throw new Error(`unexpected command: ${cmd}`);
  };
  mockedInvoke.mockImplementation(dispatcher as any);
}

// The pose's geometry slot order (stage.rs::animated_geometry_paths):
// pre-order walk, has_geometry && geometry_animated, deduped.
function animatedPaths(nodes: RenderNode[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const walk = (entries: RenderNode[]) => {
    for (const entry of entries) {
      if (entry.has_geometry && entry.geometry_animated && !seen.has(entry.path)) {
        seen.add(entry.path);
        paths.push(entry.path);
      }
      walk(entry.children);
    }
  };
  walk(nodes);
  return paths;
}

// One merged pose response (layout: stage.rs::frame_pose): the path and
// material tables, then the pre-order node table, then the geometry batch
// frame whose slot i belongs to the i-th deforming path.
function poseFrame(nodes: RenderNode[], batch: ArrayBuffer): ArrayBuffer {
  return encodePoseFrame(asFixture(nodes), batch);
}

/// The manifest as the frame writer sees it: the two fields the frame drops
/// (name, animated) are absent by construction.
function asFixture(nodes: RenderNode[]): PoseFixtureNode[] {
  return nodes.map((node) => ({
    path: node.path,
    children: asFixture(node.children),
    transform: node.transform,
    visible: node.visible,
    has_geometry: node.has_geometry,
    geometry_animated: node.geometry_animated,
    animated: node.animated,
    type_name: node.type_name,
    material: node.material,
    instances: node.instances,
  }));
}

// The batch pose response (stage.rs::frame_poses): u32 frame count then the
// frames back to back.
function poseBatch(frames: ArrayBuffer[]): ArrayBuffer {
  return encodePoseBatch(frames);
}

// `count` ok slots carrying the default triangle frame (geometryDecoder
// layout: batch magic, version, count, then status/length/padded bytes).
function packedBatchGeometry(y = 1, count = 1): ArrayBuffer {
  return packedBatch(Array.from({ length: count }, () => packedGeometry(y)));
}

// Material batch slots share the frame but carry MaterialInfo JSON bytes.
function packedBatchMaterials(count = 1): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify({ name: "Mat", surface: null }));
  const slot = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return packedBatch(Array.from({ length: count }, () => slot));
}

// Batch response with one ok slot per frame passed in.
function packedBatch(frames: ArrayBuffer[]): ArrayBuffer {
  const bytes = frames.map((frame) => new Uint8Array(frame));
  const padded = bytes.map((frame) => (frame.byteLength + 3) & ~3);
  const buffer = new ArrayBuffer(12 + padded.reduce((sum, length) => sum + 8 + length, 0));
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534247, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, bytes.length, true);
  let offset = 12;
  bytes.forEach((frame, slot) => {
    view.setUint32(offset, 0, true);
    view.setUint32(offset + 4, frame.byteLength, true);
    new Uint8Array(buffer, offset + 8, frame.byteLength).set(frame);
    offset += 8 + padded[slot]!;
  });
  return buffer;
}

async function loadScene(manifest: () => RenderNode[] | Promise<RenderNode[]>) {
  mockIpc(manifest);
  const group = await renderState.loadRenderScene();
  expect(group).toBeTruthy();
  mockedInvoke.mockClear();
  return group!;
}

function findMesh(group: THREE.Group): THREE.Mesh {
  let mesh: THREE.Mesh | null = null;
  group.traverse((object) => {
    if (!mesh && (object as THREE.Mesh).isMesh) mesh = object as THREE.Mesh;
  });
  return mesh!;
}

describe("renderState.setStageTime", () => {
  it("notifies the inspector hook whenever time changes", async () => {
    const listener = vi.fn();
    (renderState as any).onTimeChange = listener;

    await renderState.setStageTime(4);

    expect(listener).toHaveBeenCalledWith(4);
    (renderState as any).onTimeChange = null;
  });

  it("queues a time step during a scene build instead of mutating the old group", async () => {
    const oldNode = node({ path: "/Old", name: "Old", transform: translate(1) });
    const oldGroup = await loadScene(() => [oldNode]);
    const pending = deferred<RenderNode[]>();
    let manifestCalls = 0;
    mockIpc(() => {
      manifestCalls += 1;
      return manifestCalls === 1
        ? pending.promise
        : [node({ path: "/New", name: "New", transform: translate(7) })];
    });

    const loading = renderState.loadRenderScene();
    // The queued step's promise now resolves only after the load's refresh
    // runs, so it cannot be awaited until the pending manifest resolves.
    const step = renderState.setStageTime(5);
    const callsDuringLoad = manifestCalls;
    pending.resolve([node({ path: "/New", name: "New", transform: translate(2) })]);
    const newGroup = await loading;
    await step;

    expect(callsDuringLoad).toBe(1);
    expect(newGroup).toBeTruthy();
    expect(oldGroup.children[0].matrix.elements[12]).toBe(1);
    expect(newGroup!.children[0].matrix.elements[12]).toBe(7);
    expect(renderState.time).toBe(5);
  });

  it("does not resolve a time step requested during a load before that load's refresh applied", async () => {
    const pending = deferred<RenderNode[]>();
    mockIpc(() => pending.promise);
    const loading = renderState.loadRenderScene();

    const step = renderState.setStageTime(5);
    let resolved = false;
    void step.then(() => {
      resolved = true;
    });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(resolved).toBe(false);

    pending.resolve([node({ path: "/Scene/New", name: "New", transform: translate(7) })]);
    const group = await loading;
    await Promise.resolve();
    expect(resolved).toBe(true);
    // The load's queued refresh ran and applied before the promise resolved.
    expect(group!.children[0].matrix.elements[12]).toBe(7);
    expect(renderState.time).toBe(5);
  });

  it("prefetches load-time materials in bounded batches instead of per prim", async () => {
    // The wiring pin: the backend command name and the 32-path slices, so a
    // broken fetcher cannot hide behind the per-path fail-soft fallback.
    const mesh = (i: number) =>
      node({
        path: `/Scene/M${i}`,
        name: `M${i}`,
        type_name: "Mesh",
        has_geometry: true,
        material: `/Scene/Looks/M${i}`,
      });
    mockIpc(() => Array.from({ length: GEOMETRY_BATCH_SIZE + 1 }, (_, i) => mesh(i)));
    await renderState.loadRenderScene();

    const batches = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_material_batch");
    expect(batches.map(([, args]) => (args as { paths: string[] }).paths.length)).toEqual([
      GEOMETRY_BATCH_SIZE,
      1,
    ]);
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_material_data"),
      "the prefill served every prim",
    ).toHaveLength(0);
    mockedInvoke.mockClear();
  });

  it("refetches geometry for deforming nodes and applies transforms in place", async () => {
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
    });
    const still = node({ path: "/Scene/Still", name: "Still", type_name: "Mesh", has_geometry: true });
    const group = await loadScene(() => [wobble, still]);

    await renderState.setStageTime(5);

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    // One pose = one invoke: no follow-up geometry round trip.
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(renderState.time).toBe(5);

    // The time-step updates the ALREADY-integrated group: the same
    // object stays in the scene, no full rebuild.
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wrapper).toBeTruthy();
    const stillWrapper = group.children.find((child) => child.name === "/Scene/Still");
    expect(stillWrapper).toBeTruthy();
  });

  it("skips the geometry refetch for transform-only animated nodes", async () => {
    // The bike case: every node animates via ancestor xformOps but no
    // points are sampled. One playback step must fetch the manifest and
    // ZERO geometry payloads, while the transform still applies.
    const mover = node({
      path: "/Scene/Mover",
      name: "Mover",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: false,
    });
    const group = await loadScene(() => [mover]);

    mockIpc(() => [node({ ...mover, transform: translate(5) })]);
    await renderState.setStageTime(5);

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_data")).toHaveLength(0);
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_batch")).toHaveLength(0);
    const wrapper = group.children.find((child) => child.name === "/Scene/Mover");
    expect(wrapper!.matrix.elements[12]).toBe(5);
  });

  it("applies new transforms from the time manifest in place", async () => {
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
    });
    const group = await loadScene(() => [wobble]);

    mockIpc(() => [node({ ...wobble, transform: translate(3) })]);
    await renderState.setStageTime(8);

    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wrapper!.matrix.elements[12]).toBe(3);
  });

  it("updates a layout-compatible animated geometry in place, same instance", async () => {
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
    });
    const group = await loadScene(() => [wobble]);
    const mesh = findMesh(group);
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex()!;

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose") return poseFrame([wobble], packedBatch([packedGeometry(4)]));
      if (cmd === "get_material_data") return { name: "Mat", surface: null };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await renderState.setStageTime(5);

    // Steady-state playback keeps the same BufferGeometry (no realloc,
    // no full re-upload) and writes the new positions into it.
    expect(mesh.geometry).toBe(geometry);
    expect(geometry.getAttribute("position")).toBe(position);
    expect(geometry.getIndex()).toBe(index);
    expect(position.getY(2)).toBe(4);
    expect(geometry.boundingSphere!.center.y).toBe(2);
  });

  it("recreates and disposes the geometry when the payload layout changes", async () => {
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
    });
    const group = await loadScene(() => [wobble]);
    const mesh = findMesh(group);
    const oldGeometry = mesh.geometry;
    const disposeSpy = vi.spyOn(oldGeometry, "dispose");

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose") return poseFrame([wobble], packedBatch([packedGeometryCounts(4, 6)]));
      if (cmd === "get_material_data") return { name: "Mat", surface: null };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await renderState.setStageTime(5);

    expect(mesh.geometry).not.toBe(oldGeometry);
    expect(mesh.geometry.getAttribute("position").count).toBe(4);
    expect(mesh.geometry.getIndex()!.count).toBe(6);
    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("updates animated nodes from the delta and leaves static nodes untouched", async () => {
    // The delta manifest carries ONLY the animated node: the static
    // sibling must keep its transform, visibility and geometry untouched.
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
    });
    const still = node({
      path: "/Scene/Still",
      name: "Still",
      type_name: "Mesh",
      has_geometry: true,
      transform: translate(2),
    });
    const group = await loadScene(() => [wobble, still]);
    const stillWrapper = group.children.find((child) => child.name === "/Scene/Still")!;

    mockIpc(() => [node({ ...wobble, transform: translate(7) })]);
    await renderState.setStageTime(5);

    const wobbleWrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wobbleWrapper!.matrix.elements[12]).toBe(7);
    expect(stillWrapper.matrix.elements[12]).toBe(2);
    expect(stillWrapper.visible).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    // The pose carries only Wobble's geometry: the static sibling is not
    // refetched (and no per-prim fallback ran).
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_data")).toHaveLength(0);
  });

  it("does not hide a static instanced mesh absent from the delta", async () => {
    // Delta pitfall: updateScene hides instanced meshes absent from the
    // FULL manifest; a delta omits static instancers by design, so the
    // delta update must leave them drawn.
    const staticProto = node({
      path: "/Scene/Instancer/__proto_0",
      name: "__proto_0",
      type_name: "Mesh",
      has_geometry: true,
      instances: [IDENTITY],
    });
    const scene = (delta: RenderNode[]) => [
      node({
        path: "/Scene/Instancer",
        name: "Instancer",
        type_name: "PointInstancer",
        children: [staticProto],
      }),
      ...delta,
    ];
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", animated: true });
    const group = await loadScene(() => scene([wobble]));
    const instanced = findMesh(group) as THREE.InstancedMesh;

    // The delta mentions ONLY the animated node — the instancer is absent.
    mockIpc(() => [node({ ...wobble, transform: translate(4) })]);
    await renderState.setStageTime(5);

    expect(instanced.parent!.visible).toBe(true);
    expect(instanced.count).toBe(1);
  });

  it("hides a prototype wrapper whose instance count dropped to zero", async () => {
    // Blocker 1, fail B: the delta's zero-instance wrapper (instances: [],
    // visible: false) is the hide carrier — the in-place update must hide
    // the wrapper that was drawn at load, even though the old parent-present
    // rule could not reach an Xform-rooted wrapper's threaded descendants.
    const proto = node({
      path: "/Scene/Inst/__proto_0",
      name: "__proto_0",
      type_name: "Mesh",
      has_geometry: true,
      instances: [IDENTITY],
    });
    const instancer = (protoChild: RenderNode) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children: [protoChild],
      });
    const group = await loadScene(() => [instancer(proto)]);
    const wrapper = group.children[0].children[0]!;
    expect(wrapper.visible).toBe(true);

    mockIpc(() => [instancer(node({ ...proto, instances: [], visible: false }))]);
    await renderState.setStageTime(5);

    expect(wrapper.visible).toBe(false);
  });

  it("hides threaded descendants through a zero-instance Xform wrapper", async () => {
    // Blocker 1, fail B for an Xform-rooted prototype: the zero-instance
    // wrapper is present in the delta with visible: false, and three.js
    // cascades the wrapper's invisibility onto the threaded children.
    const mesh = node({
      path: "/Scene/Inst/__proto_0/Mesh",
      name: "Mesh",
      type_name: "Mesh",
      has_geometry: true,
    });
    const protoX = node({
      path: "/Scene/Inst/__proto_0",
      name: "__proto_0",
      type_name: "Xform",
      instances: [IDENTITY],
      children: [mesh],
    });
    const instancer = (child: RenderNode) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children: [child],
      });
    const group = await loadScene(() => [instancer(protoX)]);
    const protoWrapper = group.children[0].children[0]!;
    const threaded = findMesh(group) as THREE.InstancedMesh;
    expect(threaded.count).toBe(1);

    mockIpc(() => [instancer(node({ ...protoX, instances: [], visible: false, children: [] }))]);
    await renderState.setStageTime(5);

    expect(protoWrapper.visible).toBe(false);
    expect(threaded.count).toBe(1); // untouched; hidden via the cascade
  });

  it("keeps a connector wrapper's filtered static descendants visible", async () => {
    // Blocker 1, fail A: a connector synthetic wrapper is present in the
    // delta while its static threaded descendants are filtered out BY
    // DESIGN — absent must not mean hidden there (the old parent-present
    // rule hid them).
    const mesh = node({
      path: "/Scene/Inst/__proto_0/Mesh",
      name: "Mesh",
      type_name: "Mesh",
      has_geometry: true,
    });
    const protoX = node({
      path: "/Scene/Inst/__proto_0",
      name: "__proto_0",
      type_name: "Xform",
      instances: [IDENTITY],
      children: [mesh],
    });
    const instancer = (child?: RenderNode) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        children: child ? [child] : [],
      });
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", animated: true });
    const group = await loadScene(() => [instancer(protoX), wobble]);
    const threaded = findMesh(group) as THREE.InstancedMesh;

    // The delta holds the connector wrapper (its prototype root samples
    // visibility) but NOT its static threaded child.
    mockIpc(() => [
      instancer(node({ ...protoX, children: [] })),
      node({ ...wobble, transform: translate(4) }),
    ]);
    await renderState.setStageTime(5);

    expect(threaded.parent!.visible).toBe(true);
    expect(threaded.count).toBe(1);
  });

  it("hides an absent direct prototype wrapper under a present instancer", async () => {
    // The safety net behind the backend invariant (a delta-present
    // instancer carries every wrapper): if a DIRECT `__proto_` wrapper is
    // still absent, its count dropped and it must hide.
    const proto = node({
      path: "/Scene/Inst/__proto_0",
      name: "__proto_0",
      type_name: "Mesh",
      has_geometry: true,
      instances: [IDENTITY],
    });
    const instancer = (children: RenderNode[]) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children,
      });
    const group = await loadScene(() => [instancer([proto])]);
    const instanced = findMesh(group) as THREE.InstancedMesh;

    mockIpc(() => [instancer([])]); // wrapper absent: count dropped to zero
    await renderState.setStageTime(5);

    expect(instanced.parent!.visible).toBe(false);
  });

  it("requests a shadow redraw when a pose applies, not on a deduped frame", async () => {
    // Playback moves casters: the map must follow the pose, once per pose,
    // not once per render frame.
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", animated: true });
    await loadScene(() => [wobble]);
    consumeShadowUpdate();

    mockIpc(() => [node({ ...wobble, transform: translate(2) })]);
    await renderState.setStageTime(5);
    expect(consumeShadowUpdate()).toBe(true);

    await renderState.setStageTime(5); // same snapped code: nothing moved
    expect(consumeShadowUpdate()).toBe(false);
  });

  it("does not request a shadow redraw when a pose changes nothing visible", async () => {
    // C4: the map follows the CASTERS, not the pose traffic. A pose that
    // lands the same matrix and the same visibility re-rasterizes nothing.
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      animated: true,
      transform: translate(2),
    });
    await loadScene(() => [wobble]);
    consumeShadowUpdate();

    mockIpc(() => [node({ ...wobble })]);
    await renderState.setStageTime(5);

    expect(consumeShadowUpdate()).toBe(false);
  });

  it("requests one shadow redraw when a pose flips a node's visibility", async () => {
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      animated: true,
      transform: translate(2),
    });
    await loadScene(() => [wobble]);
    consumeShadowUpdate();

    mockIpc(() => [node({ ...wobble, visible: false })]);
    await renderState.setStageTime(5);

    expect(consumeShadowUpdate()).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);
  });

  it("requests one shadow redraw when a pose writes a geometry slot", async () => {
    // A deformed mesh always moves its shadow, even at a fixed transform.
    const deforming = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      geometry_animated: true,
      animated: true,
      transform: translate(2),
    });
    await loadScene(() => [deforming]);
    consumeShadowUpdate();
    mockedInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_animated_pose") return poseFrame([deforming], packedBatch([packedGeometry(2)]));
      if (cmd === "get_time_codes") return [];
      throw new Error(`unexpected command: ${cmd}`);
    }) as any);

    await renderState.setStageTime(5);

    expect(consumeShadowUpdate()).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);
  });

  it("requests one shadow redraw when a pose moves only the instances", async () => {
    // An instanced prototype's wrapper keeps the manifest's identity
    // transform: the motion is entirely in the instance buffer.
    const proto = node({
      path: "/Scene/Inst/__proto_0",
      name: "__proto_0",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      instances: [IDENTITY],
    });
    const instancer = (child: RenderNode) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children: [child],
      });
    await loadScene(() => [instancer(proto)]);
    consumeShadowUpdate();

    mockIpc(() => [instancer(node({ ...proto, instances: [translate(3)] }))]);
    await renderState.setStageTime(5);

    expect(consumeShadowUpdate()).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);

    // Same count, different source float: the compare must notice it on a
    // mesh that already carries a recorded apply, not only on the first one.
    mockIpc(() => [instancer(node({ ...proto, instances: [translate(4)] }))]);
    await renderState.setStageTime(6);

    expect(consumeShadowUpdate()).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);
  });

  it("requests one shadow redraw when a pose drops an instance", async () => {
    // The surviving instance keeps its matrix: only the count shrank, and the
    // dropped copy must leave the depth target too.
    const proto = node({
      path: "/Scene/Inst/__proto_0",
      name: "__proto_0",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      instances: [IDENTITY, translate(3)],
    });
    const instancer = (child: RenderNode) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children: [child],
      });
    await loadScene(() => [instancer(proto)]);
    consumeShadowUpdate();

    mockIpc(() => [instancer(node({ ...proto, instances: [IDENTITY] }))]);
    await renderState.setStageTime(5);

    expect(consumeShadowUpdate()).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);
  });

  it("does not request a shadow redraw when a re-applied pose rounds the same instances", async () => {
    // A threaded descendant's only motion is its composed instance matrix
    // (the wrapper is collapsed to identity). The buffer holds the f32
    // rounding of that f64 product, so comparing the buffer would move every
    // pose; ancestor motion is already caught by the ancestor's own matrix
    // compare, so the SOURCE floats are what "moved" means here. 3 + 1/3 is
    // f32-exact on neither side of the product, so the sum rounds.
    const child = node({
      path: "/Scene/Inst/__proto_0/Body",
      name: "Body",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      transform: translate(1 / 3),
    });
    const proto = node({
      path: "/Scene/Inst/__proto_0",
      name: "__proto_0",
      animated: true,
      instances: [translate(3)],
      children: [child],
    });
    const instancer = (child: RenderNode) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children: [child],
      });
    await loadScene(() => [instancer(proto)]);
    mockIpc(() => [instancer(proto)]); // identical pose, identical inputs
    await renderState.setStageTime(5); // first apply records the sources
    consumeShadowUpdate();

    await renderState.setStageTime(6);

    expect(consumeShadowUpdate()).toBe(false);
  });

  it("requests one shadow redraw when a prototype descendant's transform moves", async () => {
    // A subtree descendant's local transform never reaches the root sources:
    // it is folded into the accumulated context transform and composed into
    // every instance matrix. Static root matrices + moving descendant still
    // rewrite the whole buffer, so the compare must see the transform too.
    const proto = (shape: number[]) =>
      node({
        path: "/Scene/Inst/__proto_0",
        name: "__proto_0",
        type_name: "Xform",
        animated: true,
        instances: [translate(3)],
        children: [
          node({
            path: "/Scene/Inst/__proto_0/Shape",
            name: "Shape",
            type_name: "Mesh",
            has_geometry: true,
            animated: true,
            transform: shape,
          }),
        ],
      });
    const instancer = (child: RenderNode) =>
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children: [child],
      });
    await loadScene(() => [instancer(proto(translate(1)))]);
    mockIpc(() => [instancer(proto(translate(1)))]); // identical: records
    await renderState.setStageTime(5);
    consumeShadowUpdate();

    mockIpc(() => [instancer(proto(translate(2)))]); // only the descendant moved
    await renderState.setStageTime(6);

    expect(consumeShadowUpdate()).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);
  });

  it("dedupes a repeated same-time step into zero extra fetches", async () => {
    // Playback perf: with time-code snapping the driver re-requests the
    // IDENTICAL time on most frames (60 Hz/30 tcps = every other frame,
    // 79% at 144 Hz); each redundant request is a full manifest fetch.
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", animated: true });
    await loadScene(() => [wobble]);

    mockIpc(() => [node({ ...wobble, transform: translate(2) })]);
    await renderState.setStageTime(5);
    mockedInvoke.mockClear();

    await renderState.setStageTime(5); // same snapped code as the last step

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(renderState.time).toBe(5);
  });

  it("drops a scrub to the load's own time cleanly instead of stepping", async () => {
    // A queued time equal to the load's final time can drop: the scene
    // is already built at that time, so the drain must not fetch a delta.
    const pending = deferred<RenderNode[]>();
    mockIpc(() => pending.promise);
    const loading = renderState.loadRenderScene(3);

    await renderState.setStageTime(3);
    pending.resolve([node({ path: "/Scene/New", name: "New", transform: translate(2) })]);
    const group = await loading;
    await Promise.resolve();

    const deltaCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose");
    expect(deltaCalls).toHaveLength(0);
    expect(renderState.time).toBe(3);
    expect(group).toBeTruthy();
  });

  it("coalesces rapid time steps to one active and one latest manifest fetch", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble" });
    await loadScene(() => [wobble]);
    const active = deferred<ArrayBuffer>();
    const requested: number[] = [];
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_animated_pose") {
        requested.push(args.time);
        return requested.length === 1
          ? active.promise
          : poseFrame([node({ ...wobble, transform: translate(9) })], packedBatch([]));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const steps = [
      renderState.setStageTime(5),
      renderState.setStageTime(6),
      renderState.setStageTime(7),
      renderState.setStageTime(8),
      renderState.setStageTime(9),
    ];
    const callsWhileActive = requested.length;
    active.resolve(poseFrame([node({ ...wobble, transform: translate(5) })], packedBatch([])));
    await Promise.all(steps);

    expect(callsWhileActive).toBe(1);
    expect(requested).toEqual([5, 9]);
    expect(renderState.time).toBe(9);
  });

  it("hides vanished instancer prototypes and restores their latest instance counts", async () => {
    const prototype = (count: number) =>
      node({
        path: "/Scene/Instancer/__proto_0",
        name: "__proto_0",
        type_name: "Mesh",
        has_geometry: true,
        animated: true,
        instances: Array.from({ length: count }, () => IDENTITY),
      });
    const instancer = (children: RenderNode[]) =>
      node({ path: "/Scene/Instancer", name: "Instancer", type_name: "PointInstancer", children });
    const group = await loadScene(() => [instancer([prototype(1)])]);
    const original = findMesh(group) as THREE.InstancedMesh;
    expect(original.count).toBe(1);

    mockIpc(() => [instancer([])]);
    await renderState.setStageTime(1);
    expect(original.parent!.visible).toBe(false);

    mockIpc(() => [instancer([prototype(2)])]);
    await renderState.setStageTime(2);
    const restored = findMesh(group) as THREE.InstancedMesh;
    expect(restored.parent!.visible).toBe(true);
    expect(restored.count).toBe(2);
  });

  it("builds an instancer prototype that becomes visible after starting empty", async () => {
    const prototype = node({
      path: "/Scene/Instancer/__proto_0",
      name: "__proto_0",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      instances: [IDENTITY],
    });
    const instancer = (children: RenderNode[]) =>
      node({ path: "/Scene/Instancer", name: "Instancer", type_name: "PointInstancer", children });
    const group = await loadScene(() => [instancer([])]);

    mockIpc(() => [instancer([prototype])]);
    await renderState.setStageTime(1);

    const appeared = findMesh(group) as THREE.InstancedMesh;
    expect(appeared).toBeTruthy();
    expect(appeared.count).toBe(1);
  });

  it("rebuilds an appearing prototype as points with its bound material", async () => {
    // The pose frame has to carry the two facts buildScene reads on the
    // delta-appearance branch: a Points prototype must not come back as a
    // Mesh, and its material binding must survive the round trip (it is
    // sticky — later frames find the object in byPath and never rebuild it).
    const prototype = node({
      path: "/Scene/Instancer/__proto_0",
      name: "__proto_0",
      type_name: "Points",
      has_geometry: true,
      animated: true,
      material: "/Scene/Looks/Spark",
      instances: [IDENTITY],
    });
    const instancer = (children: RenderNode[]) =>
      node({ path: "/Scene/Instancer", name: "Instancer", type_name: "PointInstancer", children });
    const group = await loadScene(() => [instancer([])]);

    mockIpc(() => [instancer([prototype])]);
    await renderState.setStageTime(1);

    const appeared = group.getObjectByName("/Scene/Instancer/__proto_0") as THREE.Group | undefined;
    expect(appeared?.children[0] && (appeared.children[0] as THREE.Points).isPoints).toBe(true);
    // The binding survived the frame: buildScene prefetches one material slot
    // per distinct binding path, so a dropped binding shows up as an empty list.
    expect(mockedInvoke).toHaveBeenCalledWith(
      "get_material_batch",
      expect.objectContaining({ paths: ["/Scene/Looks/Spark"] }),
    );
  });

  it("keeps an Xform-rooted prototype subtree alive across time ticks", async () => {
    // A subtree prototype: the instance matrices live on the synthetic
    // root, its descendant Mesh carries a local transform of its own. A
    // time tick must refresh count/matrices from the root (composed with
    // the child's transform), never from the descendant's empty instances.
    const offspring = (matrices: number[][]) =>
      node({
        path: "/Scene/Instancer/__proto_0",
        name: "__proto_0",
        type_name: "Xform",
        animated: true,
        instances: matrices,
        children: [
          node({
            path: "/Scene/Instancer/__proto_0/Shape",
            name: "Shape",
            type_name: "Mesh",
            has_geometry: true,
            animated: true,
            transform: translate(3),
          }),
        ],
      });
    const scene = (matrices: number[][]) => [
      node({
        path: "/Scene/Instancer",
        name: "Instancer",
        type_name: "PointInstancer",
        children: [offspring(matrices)],
      }),
    ];

    const group = await loadScene(() => scene([translate(1), translate(2), translate(3)]));
    let mesh = findMesh(group) as THREE.InstancedMesh;
    let wrapper = mesh.parent!;
    expect(mesh.count).toBe(3);
    // instance x child transform: translate(1..3) + translate(3) = 4..6.
    expect([...mesh.instanceMatrix.array][12]).toBe(4);
    expect([...mesh.instanceMatrix.array][28]).toBe(5);
    expect([...mesh.instanceMatrix.array][44]).toBe(6);
    // buildNode collapsed the wrapper to identity (transform folded into
    // the instance matrices).
    expect(wrapper.matrix.elements[12]).toBe(0);

    // Tick 1: count shrinks; matrices must re-derive from the root.
    mockIpc(() => scene([translate(4), translate(5)]));
    await renderState.setStageTime(1);
    mesh = findMesh(group) as THREE.InstancedMesh;
    wrapper = mesh.parent!;
    expect(mesh.count).toBe(2);
    expect([...mesh.instanceMatrix.array][12]).toBe(7);
    expect([...mesh.instanceMatrix.array][28]).toBe(8);
    expect(wrapper.matrix.elements[12]).toBe(0);

    // Tick 2: count grows past capacity; the whole subtree stays visible.
    mockIpc(() => scene([translate(6), translate(7), translate(8), translate(9)]));
    await renderState.setStageTime(2);
    mesh = findMesh(group) as THREE.InstancedMesh;
    wrapper = mesh.parent!;
    expect(mesh.count).toBe(4);
    expect([...mesh.instanceMatrix.array][12]).toBe(9);
    expect(wrapper.matrix.elements[12]).toBe(0);
    expect(wrapper.visible).toBe(true);
  });

  it("re-derives a direct prototype's instance matrices on every time step", async () => {
    // The per-step instancing path composes through one reused scratch
    // matrix: consecutive ticks must still write each tick's transforms,
    // and growth must reallocate exactly like the array path did.
    const prototype = (matrices: number[][]) =>
      node({
        path: "/Scene/Inst/__proto_0",
        name: "__proto_0",
        type_name: "Mesh",
        has_geometry: true,
        animated: true,
        instances: matrices,
      });
    const scene = (matrices: number[][]) => [
      node({
        path: "/Scene/Inst",
        name: "Inst",
        type_name: "PointInstancer",
        animated: true,
        children: [prototype(matrices)],
      }),
    ];

    const group = await loadScene(() => scene([translate(1), translate(2)]));
    let mesh = findMesh(group) as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    expect([...mesh.instanceMatrix.array][12]).toBe(1);
    expect([...mesh.instanceMatrix.array][28]).toBe(2);

    mockIpc(() => scene([translate(7), translate(8), translate(9)]));
    await renderState.setStageTime(1);
    mesh = findMesh(group) as THREE.InstancedMesh;
    expect(mesh.count).toBe(3);
    expect([...mesh.instanceMatrix.array][12]).toBe(7);
    expect([...mesh.instanceMatrix.array][28]).toBe(8);
    expect([...mesh.instanceMatrix.array][44]).toBe(9);

    // Shrinking keeps the allocated capacity but drops the extra instances.
    mockIpc(() => scene([translate(4)]));
    await renderState.setStageTime(2);
    mesh = findMesh(group) as THREE.InstancedMesh;
    expect(mesh.count).toBe(1);
    expect([...mesh.instanceMatrix.array][12]).toBe(4);
  });

  it("resolves loadRenderScene while a playback driver keeps queueing time steps", async () => {
    // ~60fps playback: requests stream in while a load and its drain are in
    // flight and never stop. With the chained recursive drain, every
    // completed step's finally re-awaits the latest queued request, so the
    // load's awaited first drained step never resolves — the app stays on
    // "Composing..." forever. The driver here paces setStageTime at one
    // call per macrotask over manifest responses that also take a
    // macrotask, so the drain chain cannot outrun it between ticks.
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble" });
    const first = deferred<RenderNode[]>();
    let calls = 0;
    mockIpc(() => {
      calls += 1;
      // Two macrotasks per step manifest: the driver (one setStageTime per
      // macrotask) can never be outrun by the drain chain between ticks.
      if (calls === 1) return first.promise;
      return new Promise<RenderNode[]>((resolve) =>
        setTimeout(() => setTimeout(() => resolve([wobble]), 0), 0),
      );
    });

    const loading = renderState.loadRenderScene();
    let running = true;
    try {
      const driver = (async () => {
        for (let i = 0; running; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (!running) break;
          void renderState.setStageTime(i);
        }
      })();
      // Let the driver tick while the load is in flight so queued requests
      // exist by the time the load drains.
      await new Promise((resolve) => setTimeout(resolve, 20));
      first.resolve([wobble]);

      // Bounded wait so a hang FAILS the test instead of stalling the suite.
      const outcome = await Promise.race([
        loading.then(() => "loaded" as const),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]);
      expect(outcome).toBe("loaded");
      expect(renderState.status).toBe("ready");
      running = false;
      await driver;
    } finally {
      running = false;
    }
  });

  it("does not double-apply a static prototype descendant's transform on update", async () => {
    const scene = () => [
      node({
        path: "/Scene/Instancer",
        name: "Instancer",
        type_name: "PointInstancer",
        children: [
          node({
            path: "/Scene/Instancer/__proto_0",
            name: "__proto_0",
            type_name: "Xform",
            instances: [translate(1)],
            children: [
              node({
                path: "/Scene/Instancer/__proto_0/Shape",
                name: "Shape",
                type_name: "Mesh",
                has_geometry: true,
                transform: translate(3),
              }),
            ],
          }),
        ],
      }),
    ];
    const group = await loadScene(scene);
    const wrapper = findMesh(group).parent!;
    expect(wrapper.matrix.elements[12]).toBe(0);

    await renderState.setStageTime(1);

    // The wrapper stays collapsed; the transform lives in the matrix of
    // each instance, and an in-place update must not re-apply it.
    expect(wrapper.matrix.elements[12]).toBe(0);
    expect((findMesh(group) as THREE.InstancedMesh).count).toBe(1);
  });

  it("keeps queued time-step promises pending until the coalesced refresh finishes", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble" });
    await loadScene(() => [wobble]);
    const active = deferred<RenderNode[]>();
    const latest = deferred<RenderNode[]>();
    let calls = 0;
    mockIpc(() => {
      calls += 1;
      return calls === 1 ? active.promise : latest.promise;
    });

    const activeStep = renderState.setStageTime(5);
    const queuedStep = renderState.setStageTime(6);
    let queuedDone = false;
    const tracked = queuedStep.then(() => {
      queuedDone = true;
    });
    await Promise.resolve();
    const doneBeforeRefresh = queuedDone;
    active.resolve([wobble]);
    latest.resolve([wobble]);
    await Promise.all([activeStep, tracked]);

    expect(doneBeforeRefresh).toBe(false);
    expect(queuedDone).toBe(true);
  });

  it("applies the latest queued transform after the active manifest completes", async () => {
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
    });
    const group = await loadScene(() => [wobble]);

    const active = deferred<RenderNode[]>();
    let manifestCall = 0;
    mockIpc(() => {
      manifestCall += 1;
      return manifestCall === 1 ? active.promise : [node({ ...wobble, transform: translate(6) })];
    });
    const activeStep = renderState.setStageTime(5);
    const latestStep = renderState.setStageTime(6);

    active.resolve([node({ ...wobble, transform: translate(9) })]);
    await Promise.all([activeStep, latestStep]);
    // The coalesced drain runs detached: flush it before reading the result.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wrapper!.matrix.elements[12]).toBe(6);
    expect(renderState.time).toBe(6);
  });

  it("keeps the last load's fallback colors when refreshing animated content", async () => {
    const shape = node({
      path: "/Scene/Shape",
      name: "Shape",
      type_name: "Mesh",
      has_geometry: true,
    });
    mockIpc(() => [shape]);
    await renderState.loadRenderScene(0, {
      "/Textures/Bark.png": { fallback_color: "#00ff00" },
    });
    await renderState.setStageTime(5);
    mockedInvoke.mockClear();

    mockIpc(() => [shape]);
    const group = await renderState.refreshAnimated();

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    const material = findMesh(group!).material as THREE.MeshPhysicalMaterial;
    expect(material.color.getHex()).toBe(new THREE.Color("#00ff00").getHex());
  });

  it("refreshes animated content at the current stage time", async () => {
    await loadScene(() => []);
    await renderState.setStageTime(5);
    mockedInvoke.mockClear();

    mockIpc(() => []);
    const group = await renderState.refreshAnimated();

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    expect(group).toBeTruthy();
    expect(renderState.time).toBe(5);
  });

  it("uses each step's own time for the pose and finishes with the latest queued data", async () => {
    const wobble = node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
    });
    const group = await loadScene(() => [wobble]);

    const slow = deferred<ArrayBuffer>();
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_animated_pose")
        return args.time === 5 ? slow.promise : poseFrame([wobble], packedBatch([packedGeometry(2)]));
      if (cmd === "get_material_data") return { name: "Mat", surface: null };
      throw new Error(`unexpected command: ${cmd}`);
    });

    const slowStep = renderState.setStageTime(5);
    const latestStep = renderState.setStageTime(6);
    slow.resolve(poseFrame([wobble], packedBatch([packedGeometry(9)])));
    await Promise.all([slowStep, latestStep]);
    // The coalesced drain runs detached (a sustained driver must never
    // extend the caller's chain): flush it before reading the result.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mesh = findMesh(group);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(2);
    const geometryTimes = mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === "get_animated_pose")
      .map(([, args]) => (args as any).time);
    expect(geometryTimes).toEqual([5, 6]);
    expect(renderState.time).toBe(6);
  });
});

describe("playback pose invoke", () => {
  const deforming = (name: string, transform = IDENTITY) =>
    node({
      path: `/Scene/${name}`,
      name,
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
      transform,
    });

  const meshAt = (group: THREE.Group, path: string): THREE.Mesh => {
    let mesh: THREE.Mesh | null = null;
    group.children
      .find((child) => child.name === path)!
      .traverse((object) => {
        if (!mesh && (object as THREE.Mesh).isMesh) mesh = object as THREE.Mesh;
      });
    return mesh!;
  };

  it("steps a pose with ONE invoke and applies the manifest and the geometry slots", async () => {
    // The bike paid two serial round trips per pose (manifest, then geometry
    // batch); the merged response must both move the prims and swap their
    // geometry, with slot i belonging to path i.
    const prims = [deforming("A"), deforming("B"), deforming("C")];
    const group = await loadScene(() => prims);
    const moved = prims.map((prim, i) => ({ ...prim, transform: translate(i + 5) }));
    const batch = packedBatch([packedGeometry(2), packedGeometry(3), packedGeometry(4)]);
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose") return poseFrame(moved, batch);
      throw new Error(`unexpected command: ${cmd}`);
    });

    await renderState.setStageTime(5);

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    ["A", "B", "C"].forEach((name, i) => {
      const wrapper = group.children.find((child) => child.name === `/Scene/${name}`)!;
      expect(wrapper.matrix.elements[12]).toBe(i + 5);
      expect(meshAt(group, `/Scene/${name}`).geometry.getAttribute("position").getY(2)).toBe(i + 2);
    });
  });

  it("drops a pose that went stale before it applied", async () => {
    const wobble = deforming("Wobble");
    const group = await loadScene(() => [wobble]);
    const mesh = findMesh(group);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(1);

    const pose = deferred<ArrayBuffer>();
    let poseCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_animated_pose") {
        poseCalls += 1;
        return pose.promise;
      }
      if (cmd === "get_scene_manifest") return [deforming("Fresh", translate(3))];
      if (cmd === "get_geometry_batch") return packedBatchGeometry(1, args.paths.length);
      if (cmd === "get_time_codes") return [];
      throw new Error(`unexpected command: ${cmd}`);
    });

    const step = renderState.setStageTime(5);
    for (let i = 0; i < 20 && poseCalls === 0; i++) await Promise.resolve();
    expect(poseCalls).toBe(1);

    // A reload supersedes the in-flight step while its pose is pending.
    const reloaded = await renderState.loadRenderScene();
    pose.resolve(poseFrame([deforming("Wobble", translate(9))], packedBatch([packedGeometry(4)])));
    await step;

    expect(reloaded).toBeTruthy();
    // Neither the stale geometry nor the stale transform reached the scene.
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(1);
    expect(group.children[0]!.matrix.elements[12]).toBe(0);
  });
});

describe("renderState.refreshAfterEdit", () => {
  it("treats the root path as a full-rebuild marker", async () => {
    await loadScene(() => [
      node({ path: "/Scene/Shape", name: "Shape", type_name: "Mesh", has_geometry: true }),
    ]);
    mockedInvoke.mockClear();

    expect(await renderState.refreshAfterEdit(["/"])).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("requests a shadow redraw when an edit patches the scene in place", async () => {
    const shape = node({
      path: "/Scene/Shape",
      name: "Shape",
      type_name: "Mesh",
      has_geometry: true,
      transform: translate(1),
    });
    await loadScene(() => [shape]);
    consumeShadowUpdate();
    frameDiag.reset();

    mockIpc(() => [node({ ...shape, transform: translate(5) })]);
    await renderState.refreshAfterEdit(["/Scene/Shape"]);

    expect(consumeShadowUpdate()).toBe(true);
    // The edit is what dropped the look-ahead, not a wrap or a scrub.
    expect(frameDiag.snapshot().invalidateEdit).toBe(1);
    expect(frameDiag.snapshot().invalidateWrap).toBe(0);
  });

  it("does not request a shadow redraw when an edit changes nothing visible", async () => {
    const shape = node({ path: "/Scene/Shape", name: "Shape", transform: translate(1) });
    await loadScene(() => [shape]);
    consumeShadowUpdate();

    // Same transform, same visibility, no geometry: no caster moved.
    mockIpc(() => [node({ ...shape })]);
    await renderState.refreshAfterEdit(["/Scene/Shape"]);

    expect(consumeShadowUpdate()).toBe(false);
  });

  it("patches an edited prim in place through the batched geometry fetch", async () => {
    const shape = node({
      path: "/Scene/Shape",
      name: "Shape",
      type_name: "Mesh",
      has_geometry: true,
      transform: translate(1),
    });
    const group = await loadScene(() => [shape]);
    const mesh = findMesh(group);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(1);

    mockIpc(() => [node({ ...shape, transform: translate(5) })]);
    const rebuild = await renderState.refreshAfterEdit(["/Scene/Shape"]);

    // In-place: no rebuild, the transform moved, and the geometry came
    // from the BATCH command (a 1-element batch for a single path).
    expect(rebuild).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledWith("get_geometry_batch", {
      stageId: stageState.activeStageId,
      paths: ["/Scene/Shape"],
      time: 0,
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_geometry_data", expect.anything());
    const wrapper = group.children.find((child) => child.name === "/Scene/Shape");
    expect(wrapper!.matrix.elements[12]).toBe(5);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(1);
  });

  it("patches an edited prim's geometry in place when the layout matches", async () => {
    const shape = node({
      path: "/Scene/Shape",
      name: "Shape",
      type_name: "Mesh",
      has_geometry: true,
    });
    const group = await loadScene(() => [shape]);
    const mesh = findMesh(group);
    const geometry = mesh.geometry;
    const index = geometry.getIndex()!;

    // Edit-refresh flows through updateNodes too: a layout-compatible
    // payload rewrites the live geometry instead of recreating it.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_scene_manifest" || cmd === "get_animated_manifest") return [shape];
      if (cmd === "get_time_codes") return [];
      if (cmd === "get_geometry_batch") return packedBatchGeometry(6);
      if (cmd === "get_material_data") return { name: "Mat", surface: null };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const rebuild = await renderState.refreshAfterEdit(["/Scene/Shape"]);

    expect(rebuild).toBe(false);
    expect(mesh.geometry).toBe(geometry);
    expect(geometry.getAttribute("position").getY(2)).toBe(6);
    expect(geometry.getIndex()).toBe(index);
  });

  it("requests a rebuild for material and shader edits outside the render manifest", async () => {
    const shape = node({ path: "/Scene/Shape", name: "Shape", type_name: "Mesh", has_geometry: true });
    await loadScene(() => [shape]);
    mockIpc(() => [shape]);

    expect(await renderState.refreshAfterEdit(["/Scene/Looks/Material/Shader"])).toBe(true);
  });

  it("reports a needed rebuild when an affected prim gains a child", async () => {
    const holder = node({ path: "/Scene/Holder", name: "Holder", type_name: "Xform" });
    await loadScene(() => [holder]);

    mockIpc(() => [
      node({
        path: "/Scene/Holder",
        name: "Holder",
        type_name: "Xform",
        children: [node({ path: "/Scene/Holder/New", name: "New", type_name: "Mesh", has_geometry: true })],
      }),
    ]);
    const rebuild = await renderState.refreshAfterEdit(["/Scene/Holder"]);
    expect(rebuild).toBe(true);
  });

  it("resolves a refresh coalesced behind an in-flight one with the drained verdict", async () => {
    // A new-op gizmo commit authors two attributes: the second
    // usd-stage-changed coalesces behind the first refresh. A
    // transform-only second event must not vanish the whole scene.
    const shape = node({ path: "/Scene/Shape", name: "Shape", type_name: "Mesh", has_geometry: true });
    await loadScene(() => [shape]);
    const active = deferred<RenderNode[]>();
    let calls = 0;
    mockIpc(() => {
      calls += 1;
      return calls === 1 ? active.promise : [shape];
    });

    const first = renderState.refreshAfterEdit(["/Scene/Shape"]);
    const coalesced = renderState.refreshAfterEdit(["/Scene/Shape"]);
    active.resolve([shape]);

    expect(await coalesced, "coalesced caller reports the drained verdict").toBe(false);
    expect(await first, "the in-flight refresh itself needs no rebuild").toBe(false);
    expect(calls).toBe(2);
  });

  it("resolves a refresh coalesced behind an active step with the drained verdict", async () => {
    const shape = node({ path: "/Scene/Shape", name: "Shape", type_name: "Mesh", has_geometry: true });
    await loadScene(() => [shape]);
    const active = deferred<RenderNode[]>();
    let calls = 0;
    mockIpc(() => {
      calls += 1;
      return calls === 1 ? active.promise : [shape];
    });

    const step = renderState.setStageTime(5);
    const rebuild = renderState.refreshAfterEdit(["/Scene/Shape"]);
    active.resolve([shape]);
    await step;

    // The queued refresh ran behind the active step (same slot, same
    // generation guards) — two manifest fetches total, and its verdict
    // reaches the caller the step coalesced away.
    expect(await rebuild).toBe(false);
    expect(calls).toBe(2);
  });
});

// --- F6: texture dedup ------------------------------------------------

function texturedMaterial(name: string): MaterialInfo {
  return {
    name,
    surface: {
      diffuse_color: null,
      roughness: null,
      metallic: null,
      opacity: null,
      normal: null,
      textures: [{ input: "diffuseColor", file_path: "/Textures/texgen_7.png", st_primvar: "st" }],
    },
  };
}

function meshNode(path: string, material: string | null = null): RenderNode {
  return node({ path, name: path.slice(1), type_name: "Mesh", has_geometry: true, material });
}

// Textures attach on a promise chain after the scene build returns; one
// macrotask flushes it.
const flushTextures = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("texture dedup", () => {
  it("decodes a file shared by two materials once", async () => {
    // The bike references 92 texture inputs across 10 files: the same image
    // must not be decoded and uploaded once per material.
    const loadSpy = vi
      .spyOn(THREE.TextureLoader.prototype, "load")
      .mockImplementation((_url, onLoad?: (texture: THREE.Texture<HTMLImageElement>) => void) => {
        const texture = new THREE.Texture<HTMLImageElement>();
        onLoad?.(texture);
        return texture;
      });
    try {
      const prims = [meshNode("/Scene/A", "/Scene/Looks/A"), meshNode("/Scene/B", "/Scene/Looks/B")];
      mockedInvoke.mockImplementation((async (cmd: string, args: any) => {
        if (cmd === "get_scene_manifest") return prims;
        if (cmd === "get_geometry_batch") return packedBatchGeometry(1, args.paths.length);
        if (cmd === "get_material_data") return texturedMaterial(args.path);
        if (cmd === "get_time_codes") return [];
        throw new Error(`unexpected command: ${cmd}`);
      }) as any);

      const group = await renderState.loadRenderScene();
      await flushTextures();
      const maps: THREE.MeshPhysicalMaterial[] = [];
      group!.traverse((object) => {
        if ((object as THREE.Mesh).isMesh)
          maps.push((object as THREE.Mesh).material as THREE.MeshPhysicalMaterial);
      });

      expect(loadSpy).toHaveBeenCalledOnce();
      expect(maps).toHaveLength(2);
      // Distinct texture objects (per-slot transforms stay independent) over
      // one shared, decoded image.
      expect(maps[0]!.map).not.toBe(maps[1]!.map);
      expect(maps[0]!.map!.source).toBe(maps[1]!.map!.source);

      // Scene disposal must not leave the memo behind: the next build loads
      // the file again instead of serving a texture from the closed scene.
      disposeScene(group!);
      const rebuilt = await renderState.loadRenderScene();
      await flushTextures();
      expect(rebuilt).toBeTruthy();
      expect(loadSpy).toHaveBeenCalledTimes(2);
    } finally {
      loadSpy.mockRestore();
    }
  });
});

describe("advanceStageTime", () => {
  it("advances time codes at time_codes_per_second per real second", () => {
    // Spec §8 pin: seconds -> time-code conversion lives ONLY in this
    // playback helper (and the exporter's frame stepping).
    expect(advanceStageTime(0, 0.5, 24, 0, 24)).toBe(12);
    expect(advanceStageTime(0, 1, 30, 0, 100)).toBe(30);
  });

  it("keeps continuous times when no authored codes exist", () => {
    // Mesh-cache fix: a stage without time samples (or whose codes have
    // not arrived yet) plays continuous fractional times as before.
    expect(advanceStageTime(23.5, 0.5, 24, 0, 24, [])).toBe(11.5);
    expect(advanceStageTime(2, 0.1, 24, 2, 6)).toBeCloseTo(4.4, 10);
  });

  it("snaps to the nearest authored code and keeps the wrap", () => {
    // The Rust MeshCache keys by exact f64 bits, so every playback step
    // snaps to the nearest authored code to hit it.
    expect(advanceStageTime(0, 0.5, 24, 0, 24, [0, 12, 24])).toBe(12);
    // 23.5 + 12 wraps to 11.5, which snaps FORWARD to 12.
    expect(advanceStageTime(23.5, 0.5, 24, 0, 24, [0, 12, 24])).toBe(12);
    // 2 + 2.4 = 4.4 snaps to 5 on a non-zero-start stage.
    expect(advanceStageTime(2, 0.1, 24, 2, 6, [2, 5])).toBe(5);
  });

  it("clamps a snapped code outside the stage range back into it", () => {
    // Codes authored beyond end_time_code must not drag the playhead out:
    // 18 + 4.8 = 22.8 is nearest to the out-of-range 36, clamped to 24.
    expect(advanceStageTime(18, 0.2, 24, 0, 24, [0, 36])).toBe(24);
  });

  it("holds a degenerate range at the start time", () => {
    expect(advanceStageTime(3, 1, 24, 5, 5)).toBe(5);
  });
});

describe("snapToPlayableTime", () => {
  // A sparse-keyed clip: 0..3 densely, then a 37-code hole, then 40..42. The
  // bike stage has exactly this shape (holes of 37 and 44 codes).
  const sparse = [0, 1, 2, 3, 40, 41, 42];

  it("snaps to the code while the playhead is inside a dense run", () => {
    expect(snapToPlayableTime(2.3, sparse, 0, 42)).toBe(2);
    expect(snapToPlayableTime(41.2, sparse, 0, 42)).toBe(41);
  });

  it("keeps the playhead's own time inside a code hole", () => {
    // Nearest snapping would present code 3's pose for the first 18 codes of
    // the hole (~600 ms at 30 tcps): a planted freeze, then a jump.
    expect(snapToPlayableTime(10, sparse, 0, 42)).toBe(10);
    expect(snapToPlayableTime(3.2, sparse, 0, 42)).toBe(3.2);
  });

  it("still snaps across a one-frame gap in the keys", () => {
    // Two codes apart is sub-frame sampling, not a hole: the pose stands for
    // ~1 code, which is what a dense run does too.
    expect(snapToPlayableTime(4.2, [0, 1, 2, 3, 5, 6], 0, 6)).toBe(5);
  });

  it("treats a gap of exactly the hold limit as dense", () => {
    // The limit is the largest gap a pose may stand for: the boundary belongs
    // to the dense side, so `>` mutated to `>=` re-parks the playhead on the
    // bike's 3-code gaps.
    expect(snapToPlayableTime(1.6, [0, 3], 0, 3)).toBe(3);
    expect(snapToPlayableTime(2.6, [0, 3], 0, 6)).toBe(3);
  });

  it("treats keys that miss the stage start or end as a hole there", () => {
    // index 0 / last used to read as gap 0, so a stage whose keys do not
    // reach start_time_code / end_time_code parked at the first / last code
    // for the whole head / tail: the interior bug, at the loop seam.
    const codes = [10, 11, 12];
    expect(snapToPlayableTime(1, codes, 0, 42)).toBe(1);
    expect(snapToPlayableTime(41, codes, 0, 42)).toBe(41);

    // Keys that do reach the seam keep snapping as before.
    expect(snapToPlayableTime(0.4, codes, 10, 42)).toBe(10);
    expect(snapToPlayableTime(12.4, codes, 0, 12)).toBe(12);
  });

  it("passes the time through unchanged without codes", () => {
    expect(snapToPlayableTime(4.4, [], 0, 24)).toBe(4.4);
  });

  it("snaps a single-code list when the stage is that code", () => {
    expect(snapToPlayableTime(0.4, [5], 5, 5)).toBe(5);
  });
});

describe("snapToTimeCodes", () => {
  it("snaps a scrub time to the nearest authored code", () => {
    expect(snapToTimeCodes(4.4, [2, 5, 9])).toBe(5);
    expect(snapToTimeCodes(8.9, [2, 5, 9])).toBe(9);
  });

  it("passes the time through unchanged without codes", () => {
    expect(snapToTimeCodes(4.4, [])).toBe(4.4);
  });
});

// Review fix (playhead units): the UI works in 0..(end-start) offsets;
// these helpers are the boundary to absolute USD time codes.
describe("playhead offset conversion", () => {
  it("maps a full-length UI crop [0, duration] to the absolute range [start, end]", () => {
    // ExportModal dispatches crop/timestamp values in offsets; +page
    // converts them at the setStageTime boundary. A full-length export
    // crop with start_time_code = 10 must step stage times 10..24, not
    // 0..14 (an mp4 crop [0, 14] would otherwise export times 0..14).
    const start = 10;
    const end = 24;
    const duration = end - start;
    expect(toAbsoluteTime(0, start)).toBe(start);
    expect(toAbsoluteTime(duration, start)).toBe(end);
  });

  it("round-trips an absolute stage time through the offset convention", () => {
    expect(toPlayheadOffset(17, 10)).toBe(7);
    expect(toAbsoluteTime(toPlayheadOffset(17, 10), 10)).toBe(17);
    // A zero-start stage is unaffected by the convention.
    expect(toAbsoluteTime(5, 0)).toBe(5);
  });
});

// --- Round 4 Task 2: pose batch prefetch --------------------------------

describe("renderState pose prefetch", () => {
  const codes = Array.from({ length: 20 }, (_, i) => i);

  function wobbleAt(x: number): RenderNode {
    return node({
      path: "/Scene/Wobble",
      name: "Wobble",
      type_name: "Mesh",
      has_geometry: true,
      animated: true,
      geometry_animated: true,
      transform: translate(x),
    });
  }

  async function loadedScene() {
    const group = await loadScene(() => [wobbleAt(1)]);
    // The code list is cached by a detached fetch: let it land, then author it.
    await Promise.resolve();
    renderState.timeCodes = codes;
    return group;
  }

  beforeEach(() => {
    invalidatePoseBuffer();
    frameDiag.reset();
  });

  it("seeds the look-ahead window as soon as the load's codes land", async () => {
    mockIpc(() => [wobbleAt(1)]);
    const inner = mockedInvoke.getMockImplementation()!;
    mockedInvoke.mockImplementation((async (cmd: string, args: any) =>
      cmd === "get_time_codes" ? codes : inner(cmd, args)) as any);

    await renderState.loadRenderScene();

    // The claim runs while the stage is still idle: the codes fetch is
    // detached, so this waits for it rather than for the load.
    await vi.waitFor(() => expect(poseCoverage(0)).toBe(POSE_PREFETCH));
    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose_batch", {
      stageId: stageState.activeStageId,
      times: codes.slice(1, 1 + POSE_PREFETCH),
    });

    // The point of the seed: the first step of playback is a buffer hit.
    mockedInvoke.mockClear();
    await renderState.setStageTime(1);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("applies a prefetched pose with no invoke and no dispatch sample", async () => {
    const group = await loadedScene();
    let poseX = 3;
    mockIpc(() => [wobbleAt(poseX)]);
    mockedInvoke.mockClear();

    await prefetchPoses(1);

    // One dispatch sample for the whole batch: the invoke's own wall time.
    expect(frameDiag.snapshot().dispatchN).toBe(1);

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose_batch", {
      stageId: stageState.activeStageId,
      times: codes.slice(2, 2 + 12),
    });

    poseX = 7; // a live fetch would carry this pose: the buffer's must win
    mockedInvoke.mockClear();
    frameDiag.reset();
    await renderState.setStageTime(5);

    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(3);
    expect(mockedInvoke).not.toHaveBeenCalled();
    const diag = frameDiag.snapshot();
    expect(diag.applyN).toBe(1);
    // Consuming a buffered pose dispatches nothing: its dispatch is the batch's.
    expect(diag.dispatchN).toBe(0);
  });

  it("steps the single-pose path for a code the batch did not cover", async () => {
    const group = await loadedScene();
    mockIpc(() => [wobbleAt(4)]);
    await prefetchPoses(1);
    mockedInvoke.mockClear();

    await renderState.setStageTime(19); // outside the looked-ahead window

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 19,
    });
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(4);
  });

  it("single-fetches when a buffered frame fails to decode at takePose", async () => {
    // C5's deferred decode: the batch settles without decoding, so a frame
    // the decode rejects surfaces at takePose. It must land in the same
    // fallback a failed batch lands in — one single fetch, no scene error.
    const group = await loadedScene();
    const good = () => poseFrame([wobbleAt(2)], packedBatchGeometry(1, 1));
    const batch = poseBatch([
      good(),
      good(),
      good(),
      frameWithBadVisibility(), // slot 3: code 5 of the claimed window 2..13
      ...Array.from({ length: 8 }, () => good()),
    ]);
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") return batch;
      if (cmd === "get_animated_pose") return poseFrame([wobbleAt(7)], packedBatchGeometry(1, 1));
      throw new Error(`unexpected command: ${cmd}`);
    });
    await prefetchPoses(1);
    expect(poseCoverage(1)).toBe(12);
    mockedInvoke.mockClear();

    await renderState.setStageTime(5, true);

    expect(renderState.error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    expect(frameDiag.snapshot().singleFallbackTotal).toBe(1);
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(7);
  });

  it("drops the look-ahead on a stage load", async () => {
    await loadedScene();
    mockIpc(() => [wobbleAt(3)]);
    await prefetchPoses(1);
    expect(poseCoverage(1)).toBe(12);

    mockIpc(() => [wobbleAt(2)]);
    await renderState.loadRenderScene();
    await Promise.resolve();

    expect(poseCoverage(1)).toBe(0);
    mockedInvoke.mockClear();
    await renderState.setStageTime(5);
    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
  });

  it("drops the look-ahead on an edit refresh", async () => {
    await loadedScene();
    mockIpc(() => [wobbleAt(3)]);
    await prefetchPoses(1);
    expect(poseCoverage(1)).toBe(12);

    await renderState.refreshAfterEdit(["/Scene/Wobble"]);

    expect(poseCoverage(1)).toBe(0);
    mockedInvoke.mockClear();
    await renderState.setStageTime(5);
    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
  });

  it("drops a batch that lands after a load (never mis-slots it)", async () => {
    await loadedScene();
    const pending = deferred<ArrayBuffer>();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") return pending.promise;
      throw new Error(`unexpected command: ${cmd}`);
    });

    const batch = prefetchPoses(1);
    mockIpc(() => [wobbleAt(2)]);
    await renderState.loadRenderScene();
    pending.resolve(
      poseBatch(codes.slice(2, 14).map(() => poseFrame([wobbleAt(9)], packedBatchGeometry(1, 1)))),
    );
    await batch;

    expect(poseCoverage(1)).toBe(0);
    expect(renderState.error).toBeNull();
  });

  it("holds only on an in-flight batch (the epoch guard is the sole hold branch)", async () => {
    const group = await loadedScene();
    const pending = deferred<ArrayBuffer>();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") return pending.promise;
      throw new Error(`unexpected command: ${cmd}`);
    });
    renderState.time = 0;
    frameDiag.reset();
    const batch = prefetchPoses(1); // in flight, nothing buffered yet
    mockedInvoke.mockClear();

    await renderState.setStageTime(5, true);

    // No invoke: a single fetch would queue in FRONT of the batch on the
    // serial dev transport. Nothing applied either — the last pose stands.
    expect(mockedInvoke).not.toHaveBeenCalled();
    // The hold is reported, so the playback driver can tell this lag apart
    // from an external write it must adopt.
    expect(renderState.heldTime).toBe(5);
    const diag = frameDiag.snapshot();
    expect(diag.heldTotal).toBe(1); // the hold is counted, not inferred
    expect(diag.applyN).toBe(0);
    expect(diag.dispatchN).toBe(0);
    expect(renderState.error).toBeNull();
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(1); // the load pose

    // The batch lands; the driver's next request consumes from the buffer.
    pending.resolve(
      poseBatch(codes.slice(2, 14).map(() => poseFrame([wobbleAt(9)], packedBatchGeometry(1, 1)))),
    );
    await batch;
    mockedInvoke.mockClear();
    await renderState.setStageTime(6, true);

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(wrapper.matrix.elements[12]).toBe(9);
    // Applied this time: no stale hold marker survives the write.
    expect(renderState.heldTime).toBeNull();
  });

  it("holds without writing the playhead (no time, no onTimeChange)", async () => {
    const group = await loadedScene();
    const pending = deferred<ArrayBuffer>();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") return pending.promise;
      throw new Error(`unexpected command: ${cmd}`);
    });
    renderState.time = 1;
    const listener = vi.fn();
    (renderState as any).onTimeChange = listener;
    const batch = prefetchPoses(1); // in flight: code 5 is a miss

    await renderState.setStageTime(5, true);

    // A written held time is what the playback driver's resync adopts,
    // rewinding its continuous playhead onto the code it was waiting for.
    expect(renderState.time).toBe(1);
    expect(renderState.heldTime).toBe(5);
    expect(listener).not.toHaveBeenCalled();

    // The batch lands and the held code applies: the same-time dedupe must not
    // eat it now that this.time stayed behind.
    pending.resolve(
      poseBatch(codes.slice(2, 14).map(() => poseFrame([wobbleAt(9)], packedBatchGeometry(1, 1)))),
    );
    await batch;
    mockedInvoke.mockClear();
    await renderState.setStageTime(5, true);

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(renderState.time).toBe(5);
    expect(renderState.heldTime).toBeNull();
    expect(listener).toHaveBeenCalledWith(5);
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(9);
    (renderState as any).onTimeChange = null;
  });

  it("single-fetches a playback miss once the batch path is dead", async () => {
    const group = await loadedScene();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") throw "batch blew up";
      throw new Error(`unexpected command: ${cmd}`);
    });
    await prefetchPoses(1);

    mockIpc(() => [wobbleAt(4)]);
    mockedInvoke.mockClear();
    await renderState.setStageTime(5, true);

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(4);
  });

  it("counts a playback miss that had to fetch singly, and not a paused scrub", async () => {
    await loadedScene();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") throw "batch blew up";
      throw new Error(`unexpected command: ${cmd}`);
    });
    await prefetchPoses(1); // the batch path is dead: no hold is left to take
    mockIpc(() => [wobbleAt(4)]);
    frameDiag.reset();

    await renderState.setStageTime(5, true);
    // The playback step wanted a hold and fetched instead: that is the
    // fallback a freeze is read against.
    expect(frameDiag.snapshot().singleFallbackTotal).toBe(1);

    await renderState.setStageTime(6); // a paused scrub fetches on purpose
    expect(frameDiag.snapshot().singleFallbackTotal).toBe(1);
  });

  it("drains a queued playback step with its hold policy, not a single fetch", async () => {
    const group = await loadedScene();
    mockIpc(() => [wobbleAt(3)]);
    await prefetchPoses(1); // 2..13 buffered

    const posePending = deferred<ArrayBuffer>();
    const batchPending = deferred<ArrayBuffer>();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") return batchPending.promise;
      if (cmd === "get_animated_pose") return posePending.promise;
      throw new Error(`unexpected command: ${cmd}`);
    });

    const step = renderState.setStageTime(17); // outside the window: in flight
    const batch = prefetchPoses(10); // 14..19 on the wire
    // Queued behind the active step: the drain replays it with the playback
    // driver's policy (holdOnMiss), which is the whole point of QueuedStep.
    const queued = renderState.setStageTime(18, true);
    mockedInvoke.mockClear();

    posePending.resolve(poseFrame([wobbleAt(4)], packedBatchGeometry(1, 1)));
    await step;
    await queued;

    // The drain must not single-fetch code 18: it would queue in front of the
    // batch that is about to deliver it.
    expect(mockedInvoke).not.toHaveBeenCalled();
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(4); // step 17 applied, 18 held

    batchPending.resolve(
      poseBatch(codes.slice(14, 20).map(() => poseFrame([wobbleAt(9)], packedBatchGeometry(1, 1)))),
    );
    await batch;
  });

  it("counts an in-hole step as a hole frame, not as a single fallback", async () => {
    await loadedScene();
    renderState.timeCodes = [0, 1, 2, 3, 40, 41, 42];
    mockIpc(() => [wobbleAt(4)]);
    frameDiag.reset();

    await renderState.setStageTime(4.5, true); // unauthored: a hole frame
    await renderState.setStageTime(40, true); // authored, no batch: a fallback

    const diag = frameDiag.snapshot();
    // A hole frame is intentional, not starvation: counting it as a fallback
    // would bury the freeze signal the counter exists for.
    expect(diag.holeFrameTotal).toBe(1);
    expect(diag.singleFallbackTotal).toBe(1);
  });

  it("still single-fetches a paused scrub: nothing would retry a hold", async () => {
    const group = await loadedScene();
    const pending = deferred<ArrayBuffer>();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") return pending.promise;
      if (cmd === "get_animated_pose") return poseFrame([wobbleAt(7)], packedBatchGeometry(1, 1));
      throw new Error(`unexpected command: ${cmd}`);
    });
    void prefetchPoses(1); // a batch IS in flight: the hold condition holds
    mockedInvoke.mockClear();

    await renderState.setStageTime(5); // paused scrub: no hold flag

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(7);
  });

  it("falls back to per-pose stepping when the batch fails", async () => {
    const group = await loadedScene();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_animated_pose_batch") throw "batch blew up";
      throw new Error(`unexpected command: ${cmd}`);
    });

    await prefetchPoses(1);

    expect(poseCoverage(1)).toBe(0);
    mockIpc(() => [wobbleAt(4)]);
    mockedInvoke.mockClear();
    await renderState.setStageTime(5);

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_pose", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble")!;
    expect(wrapper.matrix.elements[12]).toBe(4);
  });
});

// A one-node frame whose visibility byte is neither 0 nor 1: the split can
// bound it (the layout is intact), the decode rejects it.
function frameWithBadVisibility(): ArrayBuffer {
  const frame = poseFrame([node({ path: "/Bad", name: "Bad" })], packedBatch([]));
  const view = new DataView(frame);
  let at = 4 + 4 + view.getUint32(4, true); // past the single path entry
  at = (at + 3) & ~3; // section padding
  at += 4; // material count (0 entries)
  at += 4; // node count (1 record follows)
  view.setUint8(at + 11, 2); // node record: visibility byte
  return frame;
}
