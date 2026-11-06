import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { StageInfo } from "../stage/types";
import { stageState } from "../stage/stageState.svelte";
import {
  filterDependencies,
  loadErrorMessage,
  loadOrchestrator,
  type DependencyInfo,
} from "./loadOrchestrator.svelte";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

const stageInfo: StageInfo = {
  stage_id: 3,
  root_layer: "/scene/bike.usda",
  time_codes_per_second: 24,
  start_time_code: 0,
  end_time_code: 0,
  composition_errors: [],
  up_axis: "Y",
};

const deps: Record<string, DependencyInfo> = {
  "/assets/CarbonFrameBike/geo/body.usd": {
    path: "/assets/CarbonFrameBike/geo/body.usd",
    resolved: true,
    size_bytes: 1024,
  },
  "/assets/CarbonFrameBike/tex/PAINT_0.png": {
    path: "/assets/CarbonFrameBike/tex/PAINT_0.png",
    resolved: false,
    size_bytes: null,
  },
};

const noHooks = { resetScene: () => {}, loadScene: async () => {} };

beforeEach(() => {
  loadOrchestrator.finishOpen();
  mockedInvoke.mockReset();
  mockedListen.mockReset();
  loadOrchestrator.rootFile = null;
  loadOrchestrator.loadingProgress = null;
  loadOrchestrator.dependencies = null;
  loadOrchestrator.filterText = "";
  loadOrchestrator.modalError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filterDependencies", () => {
  it("returns an empty list when no dependencies are loaded", () => {
    expect(filterDependencies(null, "body")).toEqual([]);
  });

  it("keeps every entry when the filter is empty", () => {
    const entries = filterDependencies(deps, "");
    expect(entries).toHaveLength(2);
    expect(entries.map(([path]) => path)).toEqual(Object.keys(deps));
  });

  it("filters case-insensitively on the dependency path", () => {
    const entries = filterDependencies(deps, "paint");
    expect(entries).toEqual([
      ["/assets/CarbonFrameBike/tex/PAINT_0.png", deps["/assets/CarbonFrameBike/tex/PAINT_0.png"]],
    ]);
  });
});

describe("loadErrorMessage", () => {
  it("maps a load error payload to the modal message", () => {
    expect(loadErrorMessage("boom.usdz")).toBe("Failed to extract or load USD: boom.usdz");
  });
});

describe("openUsdFile", () => {
  it("invokes the backend open dialog command", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await loadOrchestrator.openUsdFile();
    expect(mockedInvoke).toHaveBeenCalledWith("trigger_open_usd_dialog");
  });
});

describe("init event subscriptions", () => {
  const handlerFor: Record<string, (event: { payload: unknown }) => void> = {};
  const unlisten = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(handlerFor)) delete handlerFor[key];
    mockedListen.mockImplementation(async (name, callback) => {
      handlerFor[name as string] = callback as (event: { payload: unknown }) => void;
      return unlisten;
    });
  });

  it("subscribes to the six load events and unlistens them all", async () => {
    const dispose = await loadOrchestrator.init(noHooks);

    for (const name of [
      "usd-load-error",
      "usd-load-start",
      "usd-load-progress",
      "usd-stage-opened",
      "usd-scene-loaded",
      "usd-load-refused",
    ]) {
      expect(mockedListen).toHaveBeenCalledWith(name, expect.any(Function));
    }
    expect(dispose).toBeTypeOf("function");
    dispose();
    expect(unlisten).toHaveBeenCalledTimes(6);
  });

  it("usd-load-refused surfaces the backend refusal without failing the open", async () => {
    await loadOrchestrator.init(noHooks);

    handlerFor["usd-load-refused"]({
      payload: "A USD file is already opening. Wait for it to finish before opening another.",
    });

    expect(loadOrchestrator.modalError).toContain("already opening");
    expect(loadOrchestrator.loadingProgress).toBeNull();
  });

  it("usd-load-start sets the root file, starts progress and resets the scene", async () => {
    const resetScene = vi.fn();
    await loadOrchestrator.init({ resetScene, loadScene: async () => {} });
    loadOrchestrator.dependencies = { ...deps };

    handlerFor["usd-load-start"]({ payload: "/scene/bike.usda" });

    expect(resetScene).toHaveBeenCalledTimes(1);
    expect(loadOrchestrator.rootFile).toBe("/scene/bike.usda");
    expect(loadOrchestrator.loadingProgress).toEqual({ stage: "Starting...", percent: 0 });
    expect(loadOrchestrator.dependencies).toBeNull();
  });

  it("restores the active tab and reloads its scene when a dialog open fails", async () => {
    const loadScene = vi.fn().mockResolvedValue(undefined);
    await loadOrchestrator.init({ resetScene: () => {}, loadScene });
    loadOrchestrator.rootFile = "/scene/current.usda";
    loadOrchestrator.dependencies = { ...deps };

    handlerFor["usd-load-start"]({ payload: "/scene/broken.usdz" });
    expect(loadOrchestrator.rootFile).toBe("/scene/broken.usdz");
    expect(loadOrchestrator.dependencies).toBeNull();

    handlerFor["usd-load-error"]({ payload: "bad archive" });
    await vi.waitFor(() => expect(loadScene).toHaveBeenCalledTimes(1));

    expect(loadOrchestrator.rootFile).toBe("/scene/current.usda");
    expect(loadOrchestrator.dependencies).toEqual(deps);
    expect(loadOrchestrator.loadingProgress).toBeNull();
  });

  it("does not restore a failed open over a different active stage", async () => {
    const loadScene = vi.fn().mockResolvedValue(undefined);
    await loadOrchestrator.init({ resetScene: () => {}, loadScene });
    stageState.activeStageId = 1;
    loadOrchestrator.rootFile = "/scene/a.usda";
    loadOrchestrator.dependencies = { ...deps };

    handlerFor["usd-load-start"]({ payload: "/scene/broken.usdz" });
    stageState.activeStageId = 2;
    loadOrchestrator.rootFile = "/scene/b.usda";
    loadOrchestrator.dependencies = {};
    handlerFor["usd-load-error"]({ payload: "bad archive" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadOrchestrator.rootFile).toBe("/scene/b.usda");
    expect(loadOrchestrator.dependencies).toEqual({});
    expect(loadScene).not.toHaveBeenCalled();
  });

  it("does not reload an empty scene after the first open fails", async () => {
    const loadScene = vi.fn().mockResolvedValue(undefined);
    await loadOrchestrator.init({ resetScene: () => {}, loadScene });
    stageState.activeStageId = 0;

    handlerFor["usd-load-start"]({ payload: "/scene/broken.usdz" });
    handlerFor["usd-load-error"]({ payload: "bad archive" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadOrchestrator.rootFile).toBeNull();
    expect(loadScene).not.toHaveBeenCalled();
  });

  it("usd-load-progress mirrors the backend payload", async () => {
    await loadOrchestrator.init(noHooks);

    handlerFor["usd-load-progress"]({ payload: { stage: "Extracting...", percent: 30 } });

    expect(loadOrchestrator.loadingProgress).toEqual({ stage: "Extracting...", percent: 30 });
  });

  it("usd-load-error clears progress and opens the error modal", async () => {
    await loadOrchestrator.init(noHooks);
    loadOrchestrator.loadingProgress = { stage: "Starting...", percent: 0 };

    handlerFor["usd-load-error"]({ payload: "cache miss" });

    expect(loadOrchestrator.loadingProgress).toBeNull();
    expect(loadOrchestrator.modalError).toBe("Failed to extract or load USD: cache miss");
  });

  it("usd-scene-loaded adopts the payload without composing the scene (adoption owns the compose)", async () => {
    const loadScene = vi.fn().mockResolvedValue(undefined);
    await loadOrchestrator.init({ resetScene: () => {}, loadScene });

    handlerFor["usd-load-start"]({ payload: "/scene/bike.usda" });
    handlerFor["usd-scene-loaded"]({
      payload: { root_file: "/scene/bike.usda", dependencies: deps },
    });

    expect(loadScene).not.toHaveBeenCalled();
    expect(loadOrchestrator.loadingProgress).toBeNull();
    expect(loadOrchestrator.rootFile).toBe("/scene/bike.usda");
    expect(loadOrchestrator.dependencies).toEqual(deps);
  });

  it("usd-stage-opened leaves adoption and the edit refresh to the tab store", async () => {
    await loadOrchestrator.init(noHooks);

    handlerFor["usd-stage-opened"]({ payload: stageInfo });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Adoption (and the lazy prim tree) is tabsState.adoptOpened's job:
    // adopting here too reset and refetched the active stage twice per
    // open. The edit-state refresh rides on tabsState.setActive too — a
    // refresh here would query the PREVIOUS stage id.
    expect(stageState.stageInfo?.stage_id).not.toBe(stageInfo.stage_id);
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_stage_tree", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_edit_target", expect.anything());
  });

  it("drops a gate refusal arriving on the load-error channel without failing the open", async () => {
    await loadOrchestrator.init(noHooks);
    handlerFor["usd-load-start"]({ payload: "/scene/archive.usdz" });

    handlerFor["usd-load-error"]({
      payload: "A USD file is already opening. Wait for it to finish before opening another.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The refusal is not a failure of THIS open: no restore, no modal, the
    // requested path stays pinned on the open.
    expect(loadOrchestrator.modalError).toBeNull();
    expect(loadOrchestrator.rootFile).toBe("/scene/archive.usdz");
    expect(loadOrchestrator.loadingProgress).toEqual({ stage: "Starting...", percent: 0 });

    // The first open's stream still adopts with its own requested path.
    mockedInvoke.mockResolvedValue([]);
    handlerFor["usd-scene-loaded"]({
      payload: { root_file: "/tmp/usdbee/extracted/root.usda", dependencies: deps },
    });
    handlerFor["usd-stage-opened"]({
      payload: { ...stageInfo, root_layer: "/tmp/usdbee/extracted/root.usda" },
    });
    // The first open's stream still completes with its own root: the
    // stage-opened is accepted, never closed as an orphan.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedInvoke).not.toHaveBeenCalledWith("close_stage", expect.anything());
  });

  it("closes a refused stream's orphan stage after the first open finishes", async () => {
    await loadOrchestrator.init(noHooks);
    mockedInvoke.mockResolvedValue([]);

    handlerFor["usd-load-start"]({ payload: "/scene/a.usda" });
    // A second dialog open is refused while the first is in flight.
    handlerFor["usd-load-start"]({ payload: "/scene/b.usda" });
    expect(loadOrchestrator.modalError).toContain("already opening");

    // The first open completes and frees the slot.
    handlerFor["usd-scene-loaded"]({ payload: { root_file: "/scene/a.usda", dependencies: deps } });
    handlerFor["usd-stage-opened"]({ payload: { ...stageInfo, root_layer: "/scene/a.usda" } });
    loadOrchestrator.finishOpen();

    // The refused stream completes backend-side AFTER the first finished:
    // it must adopt nothing and its stage must be closed, not orphaned.
    handlerFor["usd-scene-loaded"]({
      payload: {
        root_file: "/scene/b.usda",
        dependencies: { "/b.dep": { path: "/b.dep", resolved: true, size_bytes: 1 } },
      },
    });
    handlerFor["usd-stage-opened"]({ payload: { ...stageInfo, stage_id: 9, root_layer: "/scene/b.usda" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("close_stage", { stageId: 9 });
    expect(loadOrchestrator.dependencies).toEqual(deps);
    expect(loadOrchestrator.loadingProgress).toBeNull();
  });

  it("keeps the failure modal when a second load-start arrives during the failure restore", async () => {
    let resolveRestore!: () => void;
    const restore = new Promise<void>((resolve) => {
      resolveRestore = resolve;
    });
    const loadScene = vi.fn(() => restore);
    await loadOrchestrator.init({ resetScene: () => {}, loadScene });
    loadOrchestrator.rootFile = "/scene/current.usda";
    loadOrchestrator.dependencies = { ...deps };

    handlerFor["usd-load-start"]({ payload: "/scene/broken.usda" });
    handlerFor["usd-load-error"]({ payload: "bad layer" });

    // A second open starts while the restore is still in flight: the
    // refusal must not overwrite the actual failure message.
    handlerFor["usd-load-start"]({ payload: "/scene/other.usda" });

    expect(loadOrchestrator.modalError).toBe("Failed to extract or load USD: bad layer");
    expect(loadOrchestrator.rootFile).toBe("/scene/current.usda");

    resolveRestore();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadOrchestrator.modalError).toBe("Failed to extract or load USD: bad layer");

    // The refused second stream adopts nothing once the restore finished.
    mockedInvoke.mockResolvedValue(undefined);
    handlerFor["usd-scene-loaded"]({ payload: { root_file: "/scene/other.usda", dependencies: {} } });
    handlerFor["usd-stage-opened"]({
      payload: { ...stageInfo, stage_id: 8, root_layer: "/scene/other.usda" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("close_stage", { stageId: 8 });
    expect(loadOrchestrator.dependencies).toEqual(deps);
    expect(loadOrchestrator.rootFile).toBe("/scene/current.usda");
  });
});
