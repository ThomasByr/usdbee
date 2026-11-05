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
import { advanceStageTime, renderState, snapToTimeCodes, toAbsoluteTime, toPlayheadOffset } from "./renderState.svelte";
import { disposeScene, GEOMETRY_BATCH_SIZE } from "./sceneBuilder";
import type { MaterialInfo, RenderNode } from "../stage/types";
import { stageState } from "../stage/stageState.svelte";

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
// supplies the answer for get_scene_manifest AND get_animated_manifest
// (the playback step fetches the same scene through the delta command).
function mockIpc(manifest: () => RenderNode[] | Promise<RenderNode[]>) {
  const dispatcher = async (cmd: string, args: any) => {
    if (cmd === "get_scene_manifest" || cmd === "get_animated_manifest") return manifest();
    if (cmd === "get_time_codes") return [];
    if (cmd === "get_geometry_data") return packedGeometry();
    if (cmd === "get_geometry_batch") return packedBatchGeometry(1, args.paths.length);
    if (cmd === "get_material_data") return { name: "Mat", surface: null };
    if (cmd === "get_material_batch") return packedBatchMaterials(args.paths.length);
    throw new Error(`unexpected command: ${cmd}`);
  };
  mockedInvoke.mockImplementation(dispatcher as any);
}

// `count` ok slots carrying the default triangle frame (geometryDecoder
// layout: batch magic, version, count, then status/length/padded bytes).
function packedBatchGeometry(y = 1, count = 1): ArrayBuffer {
  return packedBatch(Array.from({ length: count }, () => packedGeometry(y)));
}

// Material batch slots share the frame but carry MaterialInfo JSON bytes.
function packedBatchMaterials(count = 1): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify({ name: "Mat", surface: null }));
  const slot = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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
      node({ path: `/Scene/M${i}`, name: `M${i}`, type_name: "Mesh", has_geometry: true });
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

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_manifest", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    const geometryCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_batch");
    expect(geometryCalls).toHaveLength(1);
    expect(geometryCalls[0][1]).toEqual({
      stageId: stageState.activeStageId,
      paths: ["/Scene/Wobble"],
      time: 5,
    });
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

    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_manifest", {
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
      if (cmd === "get_animated_manifest") return [wobble];
      if (cmd === "get_geometry_batch") return packedBatch([packedGeometry(4)]);
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
      if (cmd === "get_animated_manifest") return [wobble];
      if (cmd === "get_geometry_batch") return packedBatch([packedGeometryCounts(4, 6)]);
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
    const stillGeometryCalls = () =>
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_batch").length;

    mockIpc(() => [node({ ...wobble, transform: translate(7) })]);
    await renderState.setStageTime(5);

    const wobbleWrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wobbleWrapper!.matrix.elements[12]).toBe(7);
    expect(stillWrapper.matrix.elements[12]).toBe(2);
    expect(stillWrapper.visible).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("get_animated_manifest", {
      stageId: stageState.activeStageId,
      time: 5,
    });
    expect(stillGeometryCalls()).toBe(1); // only Wobble's refetch
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

    const deltaCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_manifest");
    expect(deltaCalls).toHaveLength(0);
    expect(renderState.time).toBe(3);
    expect(group).toBeTruthy();
  });

  it("coalesces rapid time steps to one active and one latest manifest fetch", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble" });
    await loadScene(() => [wobble]);
    const active = deferred<RenderNode[]>();
    const requested: number[] = [];
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_animated_manifest") {
        requested.push(args.time);
        return requested.length === 1 ? active.promise : [node({ ...wobble, transform: translate(9) })];
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
    active.resolve([node({ ...wobble, transform: translate(5) })]);
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

  it("uses each step's own time for geometry and finishes with the latest queued data", async () => {
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
      if (cmd === "get_animated_manifest") return [wobble];
      if (cmd === "get_geometry_batch") return args.time === 5 ? slow.promise : packedBatch([packedGeometry(2)]);
      if (cmd === "get_material_data") return { name: "Mat", surface: null };
      throw new Error(`unexpected command: ${cmd}`);
    });

    const slowStep = renderState.setStageTime(5);
    const latestStep = renderState.setStageTime(6);
    slow.resolve(packedBatch([packedGeometry(9)]));
    await Promise.all([slowStep, latestStep]);
    // The coalesced drain runs detached (a sustained driver must never
    // extend the caller's chain): flush it before reading the result.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mesh = findMesh(group);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(2);
    const geometryTimes = mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === "get_geometry_batch")
      .map(([, args]) => (args as any).time);
    expect(geometryTimes).toEqual([5, 6]);
    expect(renderState.time).toBe(6);
  });
});

describe("playback geometry prefetch", () => {
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

  it("prefetches every animated prim in one batch per pose", async () => {
    // F5: the bike paid 14 sequential per-path invokes per pose. The pose
    // must cost ONE batched geometry round trip for all deforming prims.
    const prims = [deforming("A"), deforming("B"), deforming("C")];
    await loadScene(() => prims);
    mockIpc(() => prims);

    await renderState.setStageTime(5);

    const batches = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_batch");
    expect(batches).toHaveLength(1);
    expect(batches[0][1]).toEqual({
      stageId: stageState.activeStageId,
      paths: ["/Scene/A", "/Scene/B", "/Scene/C"],
      time: 5,
    });
    // The warm path never falls back to a per-prim fetch.
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_data")).toHaveLength(0);
  });

  it("dedupes repeated paths and slices the prefetch at the batch size", async () => {
    // A shared prototype subtree can repeat a path in the delta; bound the
    // prefetch by GEOMETRY_BATCH_SIZE slices like the load-time prefill.
    const prims = Array.from({ length: GEOMETRY_BATCH_SIZE + 1 }, (_, i) => deforming(`P${i}`));
    await loadScene(() => prims);
    const delta = [...prims, prims[0]!];
    mockIpc(() => delta);

    await renderState.setStageTime(5);

    const sizes = mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === "get_geometry_batch")
      .map(([, args]) => (args as any).paths.length);
    expect(sizes).toEqual([GEOMETRY_BATCH_SIZE, 1]);
  });

  it("drops a prefetch that went stale before it applied", async () => {
    const wobble = deforming("Wobble");
    const group = await loadScene(() => [wobble]);
    const mesh = findMesh(group);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(1);

    const batch = deferred<ArrayBuffer>();
    let batchCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_animated_manifest") return [deforming("Wobble", translate(9))];
      if (cmd === "get_geometry_batch") {
        batchCalls += 1;
        // Only the in-flight pose prefetch stalls; the superseding load's
        // own prefill must not (it would deadlock the load).
        return batchCalls === 1 ? batch.promise : packedBatchGeometry(1, args.paths.length);
      }
      if (cmd === "get_scene_manifest") return [deforming("Fresh", translate(3))];
      if (cmd === "get_time_codes") return [];
      throw new Error(`unexpected command: ${cmd}`);
    });

    const step = renderState.setStageTime(5);
    for (let i = 0; i < 20 && batchCalls === 0; i++) await Promise.resolve();
    expect(batchCalls).toBe(1);

    // A reload supersedes the in-flight step while its prefetch is pending.
    const reloaded = await renderState.loadRenderScene();
    batch.resolve(packedBatch([packedGeometry(4)]));
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

  it("coalesces behind an active step and conservatively reports a rebuild", async () => {
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
    expect(await rebuild).toBe(true);
    active.resolve([shape]);
    await step;
    await Promise.resolve();

    // The queued refresh ran behind the active step (same slot, same
    // generation guards) — two manifest fetches total.
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

function meshNode(path: string): RenderNode {
  return node({ path, name: path.slice(1), type_name: "Mesh", has_geometry: true });
}

describe("texture dedup", () => {
  it("decodes a file shared by two materials once", async () => {
    // The bike references 92 texture inputs across 10 files: the same image
    // must not be decoded and uploaded once per material.
    const loadSpy = vi
      .spyOn(THREE.TextureLoader.prototype, "load")
      .mockImplementation(() => new THREE.Texture());
    try {
      const prims = [meshNode("/Scene/A"), meshNode("/Scene/B")];
      mockedInvoke.mockImplementation((async (cmd: string, args: any) => {
        if (cmd === "get_scene_manifest") return prims;
        if (cmd === "get_geometry_batch") return packedBatchGeometry(1, args.paths.length);
        if (cmd === "get_material_data") return texturedMaterial(args.path);
        if (cmd === "get_time_codes") return [];
        throw new Error(`unexpected command: ${cmd}`);
      }) as any);

      const group = await renderState.loadRenderScene();
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
