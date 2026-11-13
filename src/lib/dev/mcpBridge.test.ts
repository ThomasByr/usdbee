// Dev MCP bridge: the WS contract (request/response envelope, command set)
// and the hard dev gate. The bridge only calls existing seams, so every
// command test pins WHICH seam it routes through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-window-state", () => ({
  saveWindowState: vi.fn(async () => {}),
  StateFlags: { ALL: 0 },
}));
vi.mock("$lib/stage/stageState.svelte", () => {
  const stageState = {
    activeStageId: 1,
    status: "ready",
    error: null as string | null,
    stageInfo: { root_layer: "/tmp/a.usda" },
    fetchPrimDetails: vi.fn(async () => null),
    refreshAfterEdit: vi.fn(async () => {}),
    selectPrim: vi.fn(async () => true),
    deselectPrim: vi.fn(),
    setAttributeValues: vi.fn(async () => null),
  };
  return { stageState };
});
vi.mock("$lib/render/renderState.svelte", () => ({
  renderState: {
    time: 5 as number | null,
    hasAnimated: false,
    setStageTime: vi.fn(async () => {}),
  },
}));
vi.mock("$lib/state/tabsState.svelte", () => ({
  tabsState: { openTab: vi.fn(async () => {}), closeConfirmed: vi.fn(async () => {}) },
}));
vi.mock("$lib/state/loadOrchestrator.svelte", () => ({
  loadOrchestrator: { modalError: null as string | null },
}));
// The transform must route through the gizmo-commit authoring entry, never
// through a raw attribute write the bridge owns.
vi.mock("$lib/render/gizmoCommit.svelte", () => ({ authorLocalTransform: vi.fn(async () => null) }));

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as THREE from "three";
import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
import { renderState } from "$lib/render/renderState.svelte";
import { stageState } from "$lib/stage/stageState.svelte";
import { tabsState } from "$lib/state/tabsState.svelte";
import { authorLocalTransform } from "$lib/render/gizmoCommit.svelte";
import * as frameDiag from "$lib/perf/frameDiag";
import type { PrimDetails, RenderNode } from "$lib/stage/types";
import {
  dispatchCommand,
  handleMessage,
  reconnectDelay,
  startMcpBridge,
  type BridgeViewer,
} from "./mcpBridge.svelte";

const mockedInvoke = vi.mocked(invoke);
const mockedAuthor = vi.mocked(authorLocalTransform);
const stage = stageState as unknown as {
  activeStageId: number;
  status: string;
  error: string | null;
  stageInfo: { root_layer: string } | null;
  fetchPrimDetails: ReturnType<typeof vi.fn>;
  refreshAfterEdit: ReturnType<typeof vi.fn>;
  selectPrim: ReturnType<typeof vi.fn>;
  deselectPrim: ReturnType<typeof vi.fn>;
  setAttributeValues: ReturnType<typeof vi.fn>;
};
const tabs = tabsState as unknown as {
  openTab: ReturnType<typeof vi.fn>;
  closeConfirmed: ReturnType<typeof vi.fn>;
};
const state = renderState as unknown as {
  time: number | null;
  setStageTime: ReturnType<typeof vi.fn>;
};
const orchestrator = loadOrchestrator as unknown as { modalError: string | null };

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function node(over: Partial<RenderNode>): RenderNode {
  return {
    path: "/World",
    name: "World",
    type_name: "Xform",
    has_geometry: false,
    animated: false,
    geometry_animated: false,
    material: null,
    instances: [],
    transform: IDENTITY,
    visible: true,
    children: [],
    ...over,
  };
}

// Three levels: /World -> {Cube (geometry, animated), Group -> Deep}
function manifest(): RenderNode[] {
  return [
    node({
      children: [
        node({
          path: "/World/Cube",
          name: "Cube",
          type_name: "Mesh",
          has_geometry: true,
          animated: true,
          geometry_animated: true,
        }),
        node({
          path: "/World/Group",
          name: "Group",
          children: [node({ path: "/World/Group/Deep", name: "Deep", type_name: "Sphere" })],
        }),
      ],
    }),
  ];
}

function details(over: Partial<PrimDetails> = {}): PrimDetails {
  return {
    path: "/World/Cube",
    type_name: "Mesh",
    kind: "component",
    is_active: true,
    is_instance: false,
    is_abstract: false,
    instance_of: null,
    attributes: [],
    metadata: [],
    variant_sets: [],
    composition_arcs: [],
    local_transform: IDENTITY,
    world_transform: IDENTITY,
    ...over,
  } as PrimDetails;
}

function viewer(): BridgeViewer {
  return {
    isPlayingAnim: true,
    renderer: {
      render: vi.fn(),
      shadowMap: { needsUpdate: false },
      domElement: { toDataURL: vi.fn(() => "data:image/png;base64,QUJD") },
    },
    scene: {},
    camera: new THREE.PerspectiveCamera(75, 1, 0.1, 1000),
    controls: { target: new THREE.Vector3(), update: vi.fn() },
    fov: 75,
    pinnedCamera: null,
    activeCameraIndex: -1,
    usdCameras: [],
  } as unknown as BridgeViewer;
}

async function call(view: BridgeViewer, cmd: string, args: Record<string, unknown> = {}) {
  return dispatchCommand(view, cmd, args);
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedAuthor.mockReset();
  mockedAuthor.mockResolvedValue(null);
  stage.activeStageId = 1;
  stage.status = "ready";
  stage.error = null;
  stage.stageInfo = { root_layer: "/tmp/a.usda" };
  stage.fetchPrimDetails.mockReset();
  stage.fetchPrimDetails.mockResolvedValue(details());
  stage.refreshAfterEdit.mockReset();
  stage.refreshAfterEdit.mockResolvedValue(undefined);
  stage.setAttributeValues.mockReset();
  tabs.openTab.mockReset();
  tabs.closeConfirmed.mockReset();
  state.time = 5;
  orchestrator.modalError = null;
  frameDiag.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dev gate", () => {
  it("is inert when the build is not a dev build", () => {
    const sockets: string[] = [];
    vi.stubEnv("DEV", false);
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string) {
          sockets.push(url);
        }
      },
    );

    expect(startMcpBridge(viewer())).toBeNull();
    expect(sockets).toEqual([]);
  });
});

describe("ws client", () => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) {
      FakeSocket.instances.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  it("dials the loopback bridge port and answers one request per envelope", async () => {
    const view = viewer();
    const stop = startMcpBridge(view);
    expect(stop).toBeTypeOf("function");
    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe("ws://127.0.0.1:9330");

    socket.onopen?.();
    socket.readyState = FakeSocket.OPEN;
    socket.onmessage?.({ data: JSON.stringify({ id: 7, cmd: "status", args: {} }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(socket.sent[0])).toEqual({
      id: 7,
      ok: true,
      result: { stage_loaded: true, stage_id: 1, playing: true, time: 5 },
    });
    stop?.();
    expect(socket.closed).toBe(true);
  });

  it("drops an unparseable frame instead of answering it", async () => {
    const stop = startMcpBridge(viewer());
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onmessage?.({ data: "not json" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent).toEqual([]);
    stop?.();
  });

  it("backs off quietly and caps at 30 s", () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(1)).toBe(2000);
    expect(reconnectDelay(4)).toBe(16000);
    expect(reconnectDelay(10)).toBe(30000);
  });
});

describe("envelope", () => {
  it("carries the request id on success", async () => {
    mockedInvoke.mockResolvedValueOnce(manifest());
    const reply = await handleMessage(viewer(), JSON.stringify({ id: 3, cmd: "inspect_scene", args: {} }));
    expect(JSON.parse(reply!)).toMatchObject({ id: 3, ok: true });
  });

  it("carries the request id and the message on failure", async () => {
    const reply = await handleMessage(viewer(), JSON.stringify({ id: 4, cmd: "nope", args: {} }));
    expect(JSON.parse(reply!)).toEqual({ id: 4, ok: false, error: "unknown command: nope" });
  });

  it("surfaces a handler exception as a contract error", async () => {
    stage.fetchPrimDetails.mockRejectedValueOnce(new Error("backend down"));
    const reply = await handleMessage(
      viewer(),
      JSON.stringify({ id: 5, cmd: "transform_object", args: { path: "/World/Cube", position: [1, 2, 3] } }),
    );
    expect(JSON.parse(reply!)).toEqual({ id: 5, ok: false, error: "backend down" });
  });
});

describe("status", () => {
  it("reports the open stage, the playhead and the playback flag", async () => {
    const result = await call(viewer(), "status");
    expect(result).toEqual({ stage_loaded: true, stage_id: 1, playing: true, time: 5 });
  });

  it("reports no stage before a load", async () => {
    stage.activeStageId = 0;
    state.time = null;
    const result = await call(viewer(), "status");
    expect(result).toEqual({ stage_loaded: false, stage_id: 0, playing: true, time: null });
  });
});

describe("load_scene", () => {
  it("opens through the app's tab open path", async () => {
    expect(await call(viewer(), "load_scene", { path: "/tmp/b.usd" })).toEqual({ ok: true });
    expect(tabs.openTab).toHaveBeenCalledWith("/tmp/b.usd");
  });

  it("surfaces a load failure instead of reporting ok", async () => {
    tabs.openTab.mockImplementation(async () => {
      orchestrator.modalError = "Failed to open USD:\n\nbroken";
    });
    await expect(call(viewer(), "load_scene", { path: "/tmp/b.usd" })).rejects.toThrow("Failed to open USD");
  });

  it("surfaces a repeated failure with the same message", async () => {
    tabs.openTab.mockImplementation(async () => {
      orchestrator.modalError = "Failed to open USD:\n\nbroken";
    });
    await expect(call(viewer(), "load_scene", { path: "/tmp/b.usd" })).rejects.toThrow("Failed to open USD");
    await expect(call(viewer(), "load_scene", { path: "/tmp/b.usd" })).rejects.toThrow("Failed to open USD");
  });

  it("requires a path", async () => {
    await expect(call(viewer(), "load_scene", {})).rejects.toThrow("path");
    expect(tabs.openTab).not.toHaveBeenCalled();
  });
});

describe("unload_scene", () => {
  it("closes the active stage", async () => {
    tabs.closeConfirmed.mockImplementation(async () => {
      stage.activeStageId = 0;
    });
    expect(await call(viewer(), "unload_scene")).toEqual({ ok: true });
    expect(tabs.closeConfirmed).toHaveBeenCalledWith(1);
  });

  it("surfaces a failed close instead of reporting ok", async () => {
    tabs.closeConfirmed.mockImplementation(async () => {
      orchestrator.modalError = "Failed to close stage:\n\nnope";
    });
    await expect(call(viewer(), "unload_scene")).rejects.toThrow("Failed to close stage");
  });

  it("surfaces a close that leaves the stage open", async () => {
    await expect(call(viewer(), "unload_scene")).rejects.toThrow(/still open/);
  });

  it("is a no-op without a stage", async () => {
    stage.activeStageId = 0;
    expect(await call(viewer(), "unload_scene")).toEqual({ ok: true });
    expect(tabs.closeConfirmed).not.toHaveBeenCalled();
  });
});

describe("inspect_scene", () => {
  it("counts the whole tree and caps the listed depths", async () => {
    mockedInvoke.mockResolvedValueOnce(manifest());
    const result = (await call(viewer(), "inspect_scene", {})) as {
      prim_count: number;
      geometry_count: number;
      animated_count: number;
      nodes: unknown[];
    };
    expect(result.prim_count).toBe(4);
    expect(result.geometry_count).toBe(1);
    expect(result.animated_count).toBe(1);
    // Default depth cap 3: every node of this 3-level tree is listed.
    expect(result.nodes).toEqual([
      { path: "/World", type: "Xform", has_geometry: false, geometry_animated: false, children_count: 2 },
      { path: "/World/Cube", type: "Mesh", has_geometry: true, geometry_animated: true, children_count: 0 },
      {
        path: "/World/Group",
        type: "Xform",
        has_geometry: false,
        geometry_animated: false,
        children_count: 1,
      },
      {
        path: "/World/Group/Deep",
        type: "Sphere",
        has_geometry: false,
        geometry_animated: false,
        children_count: 0,
      },
    ]);
    expect(mockedInvoke).toHaveBeenCalledWith("get_scene_manifest", { stageId: 1, time: 5 });
  });

  it("honours max_depth", async () => {
    mockedInvoke.mockResolvedValueOnce(manifest());
    const result = (await call(viewer(), "inspect_scene", { max_depth: 1 })) as { nodes: { path: string }[] };
    expect(result.nodes.map((n) => n.path)).toEqual(["/World", "/World/Cube", "/World/Group"]);
  });

  it("fails readably without a stage", async () => {
    stage.activeStageId = 0;
    await expect(call(viewer(), "inspect_scene", {})).rejects.toThrow("no stage loaded");
  });
});

describe("search_objects", () => {
  it("matches a substring on path or name, capped", async () => {
    mockedInvoke.mockResolvedValueOnce(manifest());
    expect(await call(viewer(), "search_objects", { query: "cube" })).toEqual({
      matches: [{ path: "/World/Cube", type: "Mesh" }],
    });

    mockedInvoke.mockResolvedValueOnce(manifest());
    const limited = (await call(viewer(), "search_objects", { query: "world", limit: 1 })) as {
      matches: unknown[];
    };
    expect(limited.matches).toHaveLength(1);
  });
});

describe("select_node", () => {
  function sceneViewer() {
    const view = viewer();
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const prim = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    prim.name = "/World/Cube";
    prim.position.set(10, 0, 0);
    group.add(prim);
    Object.assign(view, { scene, loadedGroup: group, selectedNode: null, selectionHelper: null });
    return { view, scene, prim };
  }

  it("binds the prim's render node like a hierarchy click", async () => {
    const { view, scene, prim } = sceneViewer();

    expect(await call(view, "select_node", { path: "/World/Cube" })).toEqual({
      ok: true,
      path: "/World/Cube",
    });
    expect(view.selectedNode).toBe(prim);
    expect(view.selectionHelper!.box.min.x).toBeCloseTo(9, 6);
    expect(scene.children).toContain(view.selectionHelper);
    expect(stage.selectPrim).toHaveBeenCalledWith("/World/Cube");
  });

  it("replaces the previous box instead of stacking helpers", async () => {
    const { view, scene } = sceneViewer();
    await call(view, "select_node", { path: "/World/Cube" });
    const first = view.selectionHelper;
    await call(view, "select_node", { path: "/World/Cube" });

    expect(view.selectionHelper).not.toBe(first);
    expect(scene.children.filter((c) => c === first)).toHaveLength(0);
    expect(scene.children).toContain(view.selectionHelper);
  });

  it("fails readably for a missing prim", async () => {
    const { view } = sceneViewer();
    await expect(call(view, "select_node", { path: "/World/Nope" })).rejects.toThrow(
      "no render node for /World/Nope",
    );
    expect(stage.selectPrim).not.toHaveBeenCalled();
  });

  it("clears the selection on an empty path", async () => {
    const { view, scene } = sceneViewer();
    await call(view, "select_node", { path: "/World/Cube" });

    expect(await call(view, "select_node", { path: "" })).toEqual({ ok: true, path: null });
    expect(view.selectedNode).toBeNull();
    expect(view.selectionHelper).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(stage.deselectPrim).toHaveBeenCalled();
  });
});

describe("transform_object", () => {
  it("routes a position through the gizmo-commit authoring entry", async () => {
    await call(viewer(), "transform_object", { path: "/World/Cube", position: [1, 2, 3] });

    expect(mockedAuthor).toHaveBeenCalledTimes(1);
    const [authored, mode, matrix] = mockedAuthor.mock.calls[0] as [PrimDetails, string, number[]];
    expect(authored.path).toBe("/World/Cube");
    expect(mode).toBe("translate");
    expect(matrix).toEqual(new THREE.Matrix4().makeTranslation(1, 2, 3).toArray());
    // Never a raw attribute write from the bridge.
    expect(stage.setAttributeValues).not.toHaveBeenCalled();
    expect(stage.refreshAfterEdit).toHaveBeenCalled();
  });

  it("authors rotation in degrees and scale, refetching between channels", async () => {
    await call(viewer(), "transform_object", {
      path: "/World/Cube",
      position: [1, 0, 0],
      rotation: [0, 0, 90],
      scale: [2, 2, 2],
    });

    expect(mockedAuthor).toHaveBeenCalledTimes(3);
    expect(mockedAuthor.mock.calls.map((c) => c[1])).toEqual(["translate", "rotate", "scale"]);
    expect(mockedAuthor.mock.calls[1][2].map((v) => Math.round(v * 1e6) / 1e6)).toEqual(
      new THREE.Matrix4()
        .makeRotationZ(Math.PI / 2)
        .toArray()
        .map((v) => Math.round(v * 1e6) / 1e6),
    );
    expect(mockedAuthor.mock.calls[2][2]).toEqual(new THREE.Matrix4().makeScale(2, 2, 2).toArray());
    expect(stage.fetchPrimDetails).toHaveBeenCalledTimes(3);
  });

  it("surfaces the authoring refusal", async () => {
    mockedAuthor.mockResolvedValueOnce("transform stack is singular; cannot author a gizmo edit");
    await expect(
      call(viewer(), "transform_object", { path: "/World/Cube", position: [1, 0, 0] }),
    ).rejects.toThrow("singular");
    expect(stage.refreshAfterEdit).not.toHaveBeenCalled();
  });

  it("requires a path and at least one channel", async () => {
    await expect(call(viewer(), "transform_object", { position: [1, 2, 3] })).rejects.toThrow("path");
    await expect(call(viewer(), "transform_object", { path: "/World/Cube" })).rejects.toThrow(
      "position, rotation or scale",
    );
  });

  it("fails readably for a missing prim", async () => {
    stage.fetchPrimDetails.mockResolvedValueOnce(null);
    await expect(
      call(viewer(), "transform_object", { path: "/World/Gone", position: [1, 0, 0] }),
    ).rejects.toThrow("no prim at /World/Gone");
  });
});

describe("playback", () => {
  it("toggles the viewport's own playback flag", async () => {
    const view = viewer();
    await call(view, "pause");
    expect(view.isPlayingAnim).toBe(false);
    await call(view, "play");
    expect(view.isPlayingAnim).toBe(true);
  });

  it("steps the playhead through renderState", async () => {
    expect(await call(viewer(), "set_time", { time: 12 })).toEqual({ ok: true });
    expect(state.setStageTime).toHaveBeenCalledWith(12);
    await expect(call(viewer(), "set_time", {})).rejects.toThrow("time");
  });
});

describe("performance", () => {
  it("returns the frameDiag snapshot verbatim", async () => {
    frameDiag.setRate(24);
    const result = (await call(viewer(), "get_performance")) as { tcps: number; rafN: number };
    expect(result.tcps).toBe(24);
    expect(result.rafN).toBe(0);
    expect(Object.keys(result)).toContain("poseMax");
  });

  it("resets the rings", async () => {
    frameDiag.setRate(24);
    frameDiag.onRaf(16);
    frameDiag.onRaf(32);
    expect(frameDiag.snapshot().rafN).toBe(1);
    expect(await call(viewer(), "reset_performance")).toEqual({ ok: true });
    const after = frameDiag.snapshot();
    expect(after.rafN).toBe(0);
    // The rate is a stage property, not a measurement: reset keeps it.
    expect(after.tcps).toBe(24);
  });
});

describe("set_camera", () => {
  it("requires at least one channel", async () => {
    await expect(call(viewer(), "set_camera", {})).rejects.toThrow(
      "set_camera needs position, target or fov",
    );
  });

  it("moves the camera and pins copies of the view", async () => {
    const view = viewer();
    expect(await call(view, "set_camera", { position: [1, 2, 3], target: [4, 5, 6] })).toEqual({
      ok: true,
      pinned: true,
    });

    expect(view.camera.position.toArray()).toEqual([1, 2, 3]);
    expect(view.controls.target.toArray()).toEqual([4, 5, 6]);
    expect(view.controls.update).toHaveBeenCalled();
    expect(view.pinnedCamera!.position.toArray()).toEqual([1, 2, 3]);
    expect(view.pinnedCamera!.target.toArray()).toEqual([4, 5, 6]);

    // The pin is a copy: moving the live camera later must not move it.
    expect(view.pinnedCamera!.position).not.toBe(view.camera.position);
    view.camera.position.set(9, 9, 9);
    expect(view.pinnedCamera!.position.toArray()).toEqual([1, 2, 3]);
  });

  it("keeps the position when only the target is given", async () => {
    const view = viewer();
    view.camera.position.set(7, 8, 9);

    expect(await call(view, "set_camera", { target: [1, 1, 1] })).toEqual({ ok: true, pinned: true });

    expect(view.camera.position.toArray()).toEqual([7, 8, 9]);
    expect(view.controls.target.toArray()).toEqual([1, 1, 1]);
    expect(view.pinnedCamera!.position.toArray()).toEqual([7, 8, 9]);
    expect(view.pinnedCamera!.target.toArray()).toEqual([1, 1, 1]);
  });

  it("sets the field of view without pinning a position", async () => {
    const view = viewer();

    expect(await call(view, "set_camera", { fov: 35 })).toEqual({ ok: true, pinned: false });

    expect(view.fov).toBe(35);
    expect((view.camera as THREE.PerspectiveCamera).fov).toBe(35);
    expect(view.pinnedCamera).toBeNull();
  });
});

describe("screenshot", () => {
  it("renders through the export path, then reads the canvas", async () => {
    const view = viewer();
    const order: string[] = [];
    (view.renderer.render as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push("render"),
    );
    (view.renderer.domElement.toDataURL as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("read");
      return "data:image/png;base64,QUJD";
    });

    expect(await call(view, "screenshot")).toEqual({ png_base64: "QUJD" });
    expect(order).toEqual(["render", "read"]);
  });

  it("uses the active USD camera when one is selected", async () => {
    const view = viewer();
    view.activeCameraIndex = 0;
    view.usdCameras = [{ isCamera: "usd" } as never];
    await call(view, "screenshot");
    expect(view.renderer.render).toHaveBeenCalledWith(view.scene, view.usdCameras[0]);
  });
});

describe("close_app", () => {
  it("answers ok, then closes the window", async () => {
    const destroy = vi.fn(async () => {});
    vi.mocked(getCurrentWindow).mockReturnValue({ destroy } as never);

    expect(await call(viewer(), "close_app")).toEqual({ ok: true });
    expect(destroy).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroy).toHaveBeenCalled();
  });
});
