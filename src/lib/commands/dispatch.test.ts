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
    fetchPrimDetails: vi.fn(async () => null),
    refreshAfterEdit: vi.fn(async () => {}),
    selectPrim: vi.fn(async () => true),
    deselectPrim: vi.fn(),
  };
  return { stageState };
});
vi.mock("$lib/render/renderState.svelte", () => ({
  renderState: { time: 5 as number | null, setStageTime: vi.fn(async () => {}) },
}));
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
import { tabsState } from "$lib/state/tabsState.svelte";
import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
import { dispatchCommand, fetchManifest, type BridgeViewer } from "./dispatch";

const stage = stageState as unknown as { activeStageId: number };
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
    activeCameraIndex: -1,
    usdCameras: [],
  } as unknown as BridgeViewer;
}

beforeEach(() => {
  stage.activeStageId = 1;
  tabs.closeTab.mockReset();
  tabs.closeConfirmed.mockReset();
  orchestrator.modalError = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("without a viewport", () => {
  it.each(["play", "pause", "screenshot", "select_node", "set_camera", "box_report"])(
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

describe("dev-only command", () => {
  it("does not answer ping, which belongs to the bridge transport", async () => {
    await expect(dispatchCommand(viewer(), "ping", {})).rejects.toThrow("unknown command: ping");
  });

  it("rejects a command outside the set", async () => {
    await expect(dispatchCommand(viewer(), "typod", {})).rejects.toThrow("unknown command: typod");
  });
});
