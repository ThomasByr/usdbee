// renderState tests (Phase 2, Task 4): the stale-response lesson from
// stageState (Phase 1) — a manifest response from a superseded load must
// never reach the viewport.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import { invoke } from "@tauri-apps/api/core";
import { advanceStageTime, renderState } from "./renderState.svelte";
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
function packedGeometry(): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + 9 * 4 + 3 * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 3, true);
  view.setUint32(12, 3, true);
  view.setUint32(16, 0, true);
  new Float32Array(buffer, 20, 9).set([-1, 0, 0, 1, 0, 0, 0, 1, 0]);
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
