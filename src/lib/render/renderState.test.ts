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
import { advanceStageTime, renderState, toAbsoluteTime, toPlayheadOffset } from "./renderState.svelte";
import type { RenderNode } from "../stage/types";
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
});

describe("renderState", () => {
  it("loads an empty manifest into a ready state", async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    const group = await renderState.loadRenderScene();

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { stageId: stageState.activeStageId, time: 0 });
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
    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { stageId: stageState.activeStageId, time: 10 });
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
// supplies the answer for get_scene_manifest.
function mockIpc(manifest: () => RenderNode[] | Promise<RenderNode[]>) {
  const dispatcher = async (cmd: string) => {
    if (cmd === "get_scene_manifest") return manifest();
    if (cmd === "get_geometry_data") return packedGeometry();
    if (cmd === "get_geometry_batch") return packedBatchGeometry();
    if (cmd === "get_material_data") return { name: "Mat", surface: null };
    throw new Error(`unexpected command: ${cmd}`);
  };
  mockedInvoke.mockImplementation(dispatcher as any);
}

// One ok slot carrying the default triangle frame (geometryDecoder layout:
// batch magic, version, count, then status/length/padded bytes per slot).
function packedBatchGeometry(): ArrayBuffer {
  const frame = new Uint8Array(packedGeometry());
  const buffer = new ArrayBuffer(12 + 8 + ((frame.byteLength + 3) & ~3));
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534247, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, frame.byteLength, true);
  new Uint8Array(buffer, 20, frame.byteLength).set(frame);
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

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { stageId: stageState.activeStageId, time: 5 });
    const geometryCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_data");
    expect(geometryCalls).toHaveLength(1);
    expect(geometryCalls[0][1]).toEqual({ stageId: stageState.activeStageId, path: "/Scene/Wobble", time: 5 });
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

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { stageId: stageState.activeStageId, time: 5 });
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_data")).toHaveLength(0);
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

  it("coalesces rapid time steps to one active and one latest manifest fetch", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble" });
    await loadScene(() => [wobble]);
    const active = deferred<RenderNode[]>();
    const requested: number[] = [];
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_scene_manifest") {
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

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { stageId: stageState.activeStageId, time: 5 });
    const material = findMesh(group!).material as THREE.MeshPhysicalMaterial;
    expect(material.color.getHex()).toBe(new THREE.Color("#00ff00").getHex());
  });

  it("refreshes animated content at the current stage time", async () => {
    await loadScene(() => []);
    await renderState.setStageTime(5);
    mockedInvoke.mockClear();

    mockIpc(() => []);
    const group = await renderState.refreshAnimated();

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { stageId: stageState.activeStageId, time: 5 });
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
      if (cmd === "get_scene_manifest") return [wobble];
      if (cmd === "get_geometry_data") return args.time === 5 ? slow.promise : packedGeometry(2);
      if (cmd === "get_material_data") return { name: "Mat", surface: null };
      throw new Error(`unexpected command: ${cmd}`);
    });

    const slowStep = renderState.setStageTime(5);
    const latestStep = renderState.setStageTime(6);
    slow.resolve(packedGeometry(9));
    await Promise.all([slowStep, latestStep]);

    const mesh = findMesh(group);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(2);
    const geometryTimes = mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === "get_geometry_data")
      .map(([, args]) => (args as any).time);
    expect(geometryTimes).toEqual([5, 6]);
    expect(renderState.time).toBe(6);
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

describe("advanceStageTime", () => {
  it("advances time codes at time_codes_per_second per real second", () => {
    // Spec §8 pin: seconds -> time-code conversion lives ONLY in this
    // playback helper (and the exporter's frame stepping).
    expect(advanceStageTime(0, 0.5, 24, 0, 24)).toBe(12);
    expect(advanceStageTime(0, 1, 30, 0, 100)).toBe(30);
  });

  it("wraps around the stage range and tolerates a non-zero start", () => {
    expect(advanceStageTime(23.5, 0.5, 24, 0, 24)).toBe(11.5);
    expect(advanceStageTime(2, 0.1, 24, 2, 6)).toBeCloseTo(4.4, 10);
  });

  it("holds a degenerate range at the start time", () => {
    expect(advanceStageTime(3, 1, 24, 5, 5)).toBe(5);
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
