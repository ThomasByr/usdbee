// The production dispatch contract: what an unwired palette gets before a
// viewport or a stage exists, and the two commands a UI click guards but the
// MCP bridge does not.

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
    stageInfo: { up_axis: "Y" } as { up_axis: string } | null,
    fetchPrimDetails: vi.fn(async () => null),
    refreshAfterEdit: vi.fn(async () => {}),
    selectPrim: vi.fn(async () => true),
    deselectPrim: vi.fn(),
  };
  return { stageState };
});
vi.mock("$lib/render/renderState.svelte", async (importOriginal) => {
  // The mock owns the playhead, like the real module: setStageTime writes it.
  const state: { time: number | null; setStageTime: ReturnType<typeof vi.fn> } = {
    time: 5,
    setStageTime: vi.fn(async (time: number) => {
      state.time = time;
    }),
  };
  return { ...(await importOriginal<typeof import("$lib/render/renderState.svelte")>()), renderState: state };
});
vi.mock("$lib/state/tabsState.svelte", () => ({
  tabsState: {
    openTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    closeConfirmed: vi.fn(async () => {}),
  },
}));
vi.mock("$lib/state/loadOrchestrator.svelte", () => ({
  loadOrchestrator: { modalError: null as string | null },
}));

import { getCurrentWindow } from "@tauri-apps/api/window";
import { saveWindowState } from "@tauri-apps/plugin-window-state";
import * as THREE from "three";
import { stageState } from "$lib/stage/stageState.svelte";
import { renderState } from "$lib/render/renderState.svelte";
import { tabsState } from "$lib/state/tabsState.svelte";
import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
import { dispatchCommand, fetchManifest, type BridgeViewer } from "./dispatch";
import type { CameraInfo } from "$lib/stage/types";

const stage = stageState as unknown as {
  activeStageId: number;
  stageInfo: { up_axis: string } | null;
};
const tabs = tabsState as unknown as {
  closeTab: ReturnType<typeof vi.fn>;
  closeConfirmed: ReturnType<typeof vi.fn>;
};
const orchestrator = loadOrchestrator as unknown as { modalError: string | null };

function viewer(): BridgeViewer {
  return {
    isPlayingAnim: true,
    renderer: {},
    scene: {},
    camera: new THREE.PerspectiveCamera(75, 1, 0.1, 1000),
    controls: { target: new THREE.Vector3(), update: vi.fn() },
    fov: 75,
    pinnedCamera: null,
    pinnedCameraPath: null,
    savedView: null,
    activeCameraIndex: -1,
    usdCameras: [],
    stageCameras: [],
    sceneCenter: new THREE.Vector3(),
    sceneSize: 10,
  } as unknown as BridgeViewer;
}

beforeEach(() => {
  stage.activeStageId = 1;
  stage.stageInfo = { up_axis: "Y" };
  tabs.closeTab.mockReset();
  tabs.closeConfirmed.mockReset();
  orchestrator.modalError = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("without a viewport", () => {
  it.each(["play", "pause", "screenshot", "select_node", "set_camera", "release_camera", "box_report"])(
    "rejects %s with the viewport message",
    async (cmd) => {
      await expect(dispatchCommand(null, cmd, {})).rejects.toThrow("no viewport available");
    },
  );

  it("still answers status, reporting playback off", async () => {
    expect(await dispatchCommand(null, "status", {})).toEqual({
      stage_loaded: true,
      stage_id: 1,
      playing: false,
      time: 5,
    });
  });
});

describe("without a stage", () => {
  it.each(["inspect_scene", "search_objects", "transform_object"])(
    "rejects %s with the stage message",
    async (cmd) => {
      stage.activeStageId = 0;
      await expect(dispatchCommand(viewer(), cmd, {})).rejects.toThrow("no stage loaded");
    },
  );

  it("checks the viewport before the stage", async () => {
    stage.activeStageId = 0;
    await expect(dispatchCommand(null, "select_node", { path: "/World/Cube" })).rejects.toThrow(
      "no viewport available",
    );
  });

  it("fails the manifest read the same way", async () => {
    stage.activeStageId = 0;
    await expect(fetchManifest()).rejects.toThrow("no stage loaded");
  });
});

describe("unload_scene", () => {
  it("is a no-op without a stage when unguarded", async () => {
    stage.activeStageId = 0;
    expect(await dispatchCommand(viewer(), "unload_scene", {})).toEqual({ ok: true });
    expect(tabs.closeConfirmed).not.toHaveBeenCalled();
  });

  it("is a no-op without a stage when guarded", async () => {
    stage.activeStageId = 0;
    expect(await dispatchCommand(viewer(), "unload_scene", {}, { guarded: true })).toEqual({ ok: true });
    expect(tabs.closeTab).not.toHaveBeenCalled();
  });

  it("closes the tab through the dirty guard when guarded", async () => {
    expect(await dispatchCommand(viewer(), "unload_scene", {}, { guarded: true })).toEqual({ ok: true });
    expect(tabs.closeTab).toHaveBeenCalledWith(1);
    expect(tabs.closeConfirmed).not.toHaveBeenCalled();
  });

  it("does not report a still-open stage when guarded, the modal owns the close", async () => {
    // Active id stays 1: the guarded close may be waiting on the confirm modal.
    expect(await dispatchCommand(viewer(), "unload_scene", {}, { guarded: true })).toEqual({ ok: true });
  });

  it("closes directly and confirms the outcome when unguarded", async () => {
    tabs.closeConfirmed.mockImplementation(async () => {
      stage.activeStageId = 0;
    });
    expect(await dispatchCommand(viewer(), "unload_scene", {})).toEqual({ ok: true });
    expect(tabs.closeConfirmed).toHaveBeenCalledWith(1);
    expect(tabs.closeTab).not.toHaveBeenCalled();
  });

  it("surfaces a failed guarded close through the modal", async () => {
    tabs.closeTab.mockImplementation(async () => {
      orchestrator.modalError = "Failed to close stage:\n\nnope";
    });
    await expect(dispatchCommand(viewer(), "unload_scene", {}, { guarded: true })).rejects.toThrow(
      "Failed to close stage",
    );
  });
});

describe("close_app", () => {
  it("requests a window close when guarded, so the app's own guard runs", async () => {
    const close = vi.fn(async () => {});
    const destroy = vi.fn(async () => {});
    vi.mocked(getCurrentWindow).mockReturnValue({ close, destroy } as never);

    expect(await dispatchCommand(viewer(), "close_app", {}, { guarded: true })).toEqual({ ok: true });
    expect(close).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(saveWindowState).not.toHaveBeenCalled();
  });

  it("saves the window state and destroys it when unguarded", async () => {
    const close = vi.fn(async () => {});
    const destroy = vi.fn(async () => {});
    vi.mocked(getCurrentWindow).mockReturnValue({ close, destroy } as never);

    expect(await dispatchCommand(viewer(), "close_app", {})).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroy).toHaveBeenCalled();
    expect(saveWindowState).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("look_through_camera", () => {
  // Row-major, row-vector: translation in the last row, -Z the look axis.
  const WIDE: CameraInfo = {
    path: "/World/Cam_wide",
    name: "Cam_wide",
    projection: "perspective",
    focal_length: 24,
    horizontal_aperture: 36,
    vertical_aperture: 24,
    clipping_range: [1, 1000],
    world_transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 2, -5, 1],
  };
  const TELE: CameraInfo = { ...WIDE, path: "/World/Cam_tele", name: "Cam_tele", focal_length: 200 };

  it("lists the stage's cameras when no path is given", async () => {
    const view = viewer();
    view.stageCameras = [WIDE, TELE];
    expect(await dispatchCommand(view, "look_through_camera", {})).toEqual({
      cameras: [
        { path: "/World/Cam_wide", name: "Cam_wide", projection: "perspective" },
        { path: "/World/Cam_tele", name: "Cam_tele", projection: "perspective" },
      ],
    });
  });

  it("frames the viewer from the camera's transform and lens, and pins the view", async () => {
    const view = viewer();
    view.stageCameras = [WIDE];
    // 10 units from the controls target: the framing keeps that distance.
    view.camera.position.set(0, 0, 10);

    const result = await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" });

    expect(view.camera.position.toArray()).toEqual([10, 2, -5]);
    expect(view.controls.target.toArray()).toEqual([10, 2, -15]);
    expect(view.fov).toBeCloseTo(53.13, 2);
    expect((view.camera as THREE.PerspectiveCamera).fov).toBeCloseTo(53.13, 2);
    expect(view.pinnedCamera?.position.toArray()).toEqual([10, 2, -5]);
    expect(view.pinnedCamera?.target.toArray()).toEqual([10, 2, -15]);
    expect(result).toMatchObject({ ok: true, path: "/World/Cam_wide", projection: "perspective" });
  });

  it("takes the fov from the camera's own aperture and focal length", async () => {
    const view = viewer();
    view.stageCameras = [TELE];
    view.camera.position.set(0, 0, 10);

    await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_tele" });

    expect(view.fov).toBeCloseTo(6.87, 2);
  });

  it("stands the pose upright and shifts it to the re-centred stage, as the lights do", async () => {
    const view = viewer();
    view.stageCameras = [WIDE];
    view.camera.position.set(0, 0, 10);
    view.sceneCenter = new THREE.Vector3(0, 0, 3);
    stage.stageInfo = { up_axis: "Z" };

    await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" });

    // Z-up: (10, 2, -5) stands upright to (10, -5, -2), then re-centres.
    expect(view.camera.position.toArray().map((v) => Number(v.toFixed(3)))).toEqual([10, -5, -5]);
    // The spin applies to the look axis too: -Z becomes -Y, 10 units out.
    expect(view.controls.target.toArray().map((v) => Number(v.toFixed(3)))).toEqual([10, -15, -5]);
  });

  it("falls back to the scene size when the framing distance is zero", async () => {
    const view = viewer();
    view.stageCameras = [WIDE];
    view.sceneSize = 4;
    // The viewer's camera starts on its own target: no distance to keep.
    expect(view.camera.position.toArray()).toEqual(view.controls.target.toArray());

    await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" });

    expect(view.controls.target.toArray()).toEqual([10, 2, -9]);
  });

  it("takes the authored clipping range onto the viewer camera", async () => {
    const view = viewer();
    view.stageCameras = [{ ...WIDE, clipping_range: [2, 500] }];
    view.camera.position.set(0, 0, 10);

    await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" });

    expect((view.camera as THREE.PerspectiveCamera).near).toBe(2);
    expect((view.camera as THREE.PerspectiveCamera).far).toBe(500);
  });

  it("keeps the viewer's own clipping when the camera authors none", async () => {
    const view = viewer();
    view.stageCameras = [{ ...WIDE, clipping_range: null }];
    view.camera.position.set(0, 0, 10);

    await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" });

    expect((view.camera as THREE.PerspectiveCamera).near).toBe(0.1);
    expect((view.camera as THREE.PerspectiveCamera).far).toBe(1000);
  });

  it.each([[[0, 500]], [[-1, 500]], [[100, 1]], [[500, 500]]])(
    "ignores a clipping range that cannot bound a view (%j)",
    async (range) => {
      const view = viewer();
      view.stageCameras = [{ ...WIDE, clipping_range: range as [number, number] }];
      view.camera.position.set(0, 0, 10);

      await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" });

      // A zero, negative or inverted range would crash the projection: the
      // viewer's own near/far survive it.
      expect((view.camera as THREE.PerspectiveCamera).near).toBe(0.1);
      expect((view.camera as THREE.PerspectiveCamera).far).toBe(1000);
    },
  );

  it("frames an orthographic camera without touching the fov", async () => {
    const view = viewer();
    view.stageCameras = [{ ...WIDE, projection: "orthographic" }];
    view.camera.position.set(0, 0, 10);

    const result = await dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" });

    expect(view.camera.position.toArray()).toEqual([10, 2, -5]);
    expect(view.fov).toBe(75);
    expect(result).toMatchObject({ ok: true, projection: "orthographic", framed_only: true });
  });

  it("reports an unknown path as a command error the palette can show", async () => {
    const view = viewer();
    view.stageCameras = [WIDE];
    await expect(dispatchCommand(view, "look_through_camera", { path: "/World/Nope" })).rejects.toThrow(
      "no stage camera at /World/Nope",
    );
  });

  it("says the cameras are not loaded yet when the list is still empty", async () => {
    const view = viewer();
    view.stageCameras = [];
    await expect(dispatchCommand(view, "look_through_camera", { path: "/World/Cam_wide" })).rejects.toThrow(
      "no stage cameras loaded yet",
    );
  });
});

describe("release_camera", () => {
  const CAM: CameraInfo = {
    path: "/World/Cam_wide",
    name: "Cam_wide",
    projection: "perspective",
    focal_length: 24,
    horizontal_aperture: 36,
    vertical_aperture: 24,
    clipping_range: [2, 500],
    world_transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 2, -5, 1],
  };

  // The framing the viewer had before the pick: pose, target and lens.
  function freeView() {
    const view = viewer();
    view.camera.position.set(0, 0, 10);
    view.controls.target.set(0, 1, 0);
    return view;
  }

  it("restores the view the look-through replaced", async () => {
    const view = freeView();
    view.stageCameras = [CAM];
    await dispatchCommand(view, "look_through_camera", { path: CAM.path });

    expect(await dispatchCommand(view, "release_camera", {})).toEqual({ ok: true, released: true, fov: 75 });

    const camera = view.camera as THREE.PerspectiveCamera;
    expect(camera.position.toArray()).toEqual([0, 0, 10]);
    expect(view.controls.target.toArray()).toEqual([0, 1, 0]);
    expect(view.fov).toBe(75);
    expect(camera.fov).toBe(75);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(1000);
    expect(view.pinnedCamera).toBeNull();
    expect(view.pinnedCameraPath).toBeNull();
    expect(view.savedView).toBeNull();
  });

  it("keeps the view from before the FIRST pick across a second one", async () => {
    const view = freeView();
    const tele: CameraInfo = { ...CAM, path: "/World/Cam_tele", name: "Cam_tele", focal_length: 200 };
    view.stageCameras = [CAM, tele];
    await dispatchCommand(view, "look_through_camera", { path: CAM.path });
    await dispatchCommand(view, "look_through_camera", { path: tele.path });
    expect(view.fov).toBeCloseTo(6.87, 2);

    await dispatchCommand(view, "release_camera", {});

    // Not the first camera's fov or pose: the state before the first pick.
    expect(view.camera.position.toArray()).toEqual([0, 0, 10]);
    expect(view.controls.target.toArray()).toEqual([0, 1, 0]);
    expect(view.fov).toBe(75);
  });

  it("is not an error when nothing is pinned", async () => {
    const view = freeView();
    expect(await dispatchCommand(view, "release_camera", {})).toEqual({ ok: true, released: false, fov: 75 });
    expect(view.pinnedCamera).toBeNull();
    expect(view.camera.position.toArray()).toEqual([0, 0, 10]);
  });

  it("leaves the camera pose alone once an orbit cleared the saved view", async () => {
    const view = freeView();
    view.stageCameras = [CAM];
    await dispatchCommand(view, "look_through_camera", { path: CAM.path });
    const pose = view.camera.position.toArray();
    // What the controls' start listener does when the user takes the view back.
    view.savedView = null;

    expect(await dispatchCommand(view, "release_camera", {})).toMatchObject({ released: false });
    expect(view.camera.position.toArray()).toEqual(pose);
    expect(view.fov).toBeCloseTo(53.13, 2);
  });
});

describe("frame stepping", () => {
  beforeEach(() => {
    stageState.stageInfo = { start_time_code: 0, end_time_code: 100 } as never;
    renderState.time = 10;
  });

  it("steps forward and back by one frame, pausing playback", async () => {
    const view = viewer();
    view.isPlayingAnim = true;

    expect(await dispatchCommand(view, "next_frame", {})).toEqual({ ok: true, time: 11 });
    expect(view.isPlayingAnim).toBe(false);
    expect(await dispatchCommand(view, "previous_frame", {})).toEqual({ ok: true, time: 10 });
  });

  it("steps by a signed frame count and clamps to the stage range", async () => {
    expect(await dispatchCommand(viewer(), "step_frame", { frames: 10 })).toEqual({ ok: true, time: 20 });
    expect(await dispatchCommand(viewer(), "step_frame", { frames: -100 })).toEqual({ ok: true, time: 0 });
  });

  it("rejects a step with no stage or no frame count", async () => {
    stageState.stageInfo = null;
    await expect(dispatchCommand(viewer(), "step_frame", { frames: 1 })).rejects.toThrow("no stage loaded");
    stageState.stageInfo = { start_time_code: 0, end_time_code: 100 } as never;
    await expect(dispatchCommand(viewer(), "step_frame", {})).rejects.toThrow("step_frame needs frames");
  });
});

describe("dev-only command", () => {
  it("does not answer ping, which belongs to the bridge transport", async () => {
    await expect(dispatchCommand(viewer(), "ping", {})).rejects.toThrow("unknown command: ping");
  });

  it("rejects a command outside the set", async () => {
    await expect(dispatchCommand(viewer(), "typod", {})).rejects.toThrow("unknown command: typod");
  });
});
