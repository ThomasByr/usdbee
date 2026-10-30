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
  renderState,
  toAbsoluteTime,
  toPlayheadOffset,
} from "./renderState.svelte";
import type { RenderNode } from "../stage/types";

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

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { time: null });
    expect(group).toBeTruthy();
    expect(group!.children).toHaveLength(0);
    expect(renderState.status).toBe("ready");
    expect(renderState.error).toBeNull();
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
    material: null,
    instances: [],
    transform: IDENTITY,
    visible: true,
    children: [],
    ...overrides,
  };
}

// Dispatches the three IPC commands sceneBuilder drives; `manifest`
// supplies the answer for get_scene_manifest.
function mockIpc(manifest: () => RenderNode[] | Promise<RenderNode[]>) {
  const dispatcher = async (cmd: string) => {
    if (cmd === "get_scene_manifest") return manifest();
    if (cmd === "get_geometry_data") return packedGeometry();
    if (cmd === "get_material_data") return { name: "Mat", surface: null };
    throw new Error(`unexpected command: ${cmd}`);
  };
  mockedInvoke.mockImplementation(dispatcher as any);
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
  it("refetches geometry only for animated nodes and applies transforms in place", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", type_name: "Mesh", has_geometry: true, animated: true });
    const still = node({ path: "/Scene/Still", name: "Still", type_name: "Mesh", has_geometry: true });
    const group = await loadScene(() => [wobble, still]);

    await renderState.setStageTime(5);

    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { time: 5 });
    const geometryCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_geometry_data");
    expect(geometryCalls).toHaveLength(1);
    expect(geometryCalls[0][1]).toEqual({ path: "/Scene/Wobble", time: 5 });
    expect(renderState.time).toBe(5);

    // The time-step updates the ALREADY-integrated group: the same
    // object stays in the scene, no full rebuild.
    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wrapper).toBeTruthy();
    const stillWrapper = group.children.find((child) => child.name === "/Scene/Still");
    expect(stillWrapper).toBeTruthy();
  });

  it("applies new transforms from the time manifest in place", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", type_name: "Mesh", has_geometry: true, animated: true });
    const group = await loadScene(() => [wobble]);

    mockIpc(() => [node({ ...wobble, transform: translate(3) })]);
    await renderState.setStageTime(8);

    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wrapper!.position.x).toBe(3);
  });

  it("rejects a stale time response after a newer time step", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", type_name: "Mesh", has_geometry: true, animated: true });
    const group = await loadScene(() => [wobble]);

    const stale = deferred<RenderNode[]>();
    let manifestCall = 0;
    mockIpc(() => {
      manifestCall += 1;
      // First manifest fetch (t=5) hangs; the later one (t=6) resolves.
      return manifestCall === 1 ? stale.promise : [node({ ...wobble, transform: translate(6) })];
    });
    const staleStep = renderState.setStageTime(5);
    await renderState.setStageTime(6);

    const wrapper = group.children.find((child) => child.name === "/Scene/Wobble");
    expect(wrapper!.position.x).toBe(6);

    // The stale t=5 manifest lands after the t=6 step already applied: the
    // generation guard must discard it, not overwrite the newer time.
    stale.resolve([node({ ...wobble, transform: translate(9) })]);
    await staleStep;
    expect(wrapper!.position.x).toBe(6);
    expect(renderState.time).toBe(6);
  });

  it("keeps the newer step's geometry when an older step's slow fetch lands late", async () => {
    const wobble = node({ path: "/Scene/Wobble", name: "Wobble", type_name: "Mesh", has_geometry: true, animated: true });
    const group = await loadScene(() => [wobble]);

    // t=5's per-node geometry fetch hangs; t=6's resolves immediately.
    const slow = deferred<ArrayBuffer>();
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_scene_manifest") return [wobble];
      if (cmd === "get_geometry_data")
        return args.time === 5 ? slow.promise : packedGeometry(2);
      if (cmd === "get_material_data") return { name: "Mat", surface: null };
      throw new Error(`unexpected command: ${cmd}`);
    });

    const slowStep = renderState.setStageTime(5);
    await renderState.setStageTime(6);
    const mesh = findMesh(group);
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(2);

    // The t=5 geometry resolves after the t=6 step finished applying: the
    // per-node staleness check must abort before it overwrites the screen.
    slow.resolve(packedGeometry(9));
    await slowStep;
    expect(mesh.geometry.getAttribute("position").getY(2)).toBe(2);
    expect(renderState.time).toBe(6);
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
