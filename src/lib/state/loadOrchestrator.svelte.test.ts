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
  loadOrchestrator.requestedPath = null;
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

  it("subscribes to the five load events and unlistens them all", async () => {
    const dispose = await loadOrchestrator.init(noHooks);

    for (const name of [
      "usd-load-error",
      "usd-load-start",
      "usd-load-progress",
      "usd-stage-opened",
      "usd-scene-loaded",
    ]) {
      expect(mockedListen).toHaveBeenCalledWith(name, expect.any(Function));
    }
    expect(dispose).toBeTypeOf("function");
    dispose();
    expect(unlisten).toHaveBeenCalledTimes(5);
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
    loadOrchestrator.requestedPath = "/scene/current.usda";
    loadOrchestrator.dependencies = { ...deps };

    handlerFor["usd-load-start"]({ payload: "/scene/broken.usdz" });
    expect(loadOrchestrator.rootFile).toBe("/scene/broken.usdz");
    expect(loadOrchestrator.dependencies).toBeNull();

    handlerFor["usd-load-error"]({ payload: "bad archive" });
    await vi.waitFor(() => expect(loadScene).toHaveBeenCalledTimes(1));

    expect(loadOrchestrator.rootFile).toBe("/scene/current.usda");
    expect(loadOrchestrator.requestedPath).toBe("/scene/current.usda");
    expect(loadOrchestrator.dependencies).toEqual(deps);
    expect(loadOrchestrator.loadingProgress).toBeNull();
  });

  it("does not restore a failed open over a different active stage", async () => {
    const loadScene = vi.fn().mockResolvedValue(undefined);
    await loadOrchestrator.init({ resetScene: () => {}, loadScene });
    stageState.activeStageId = 1;
    loadOrchestrator.rootFile = "/scene/a.usda";
    loadOrchestrator.requestedPath = "/scene/a.usda";
    loadOrchestrator.dependencies = { ...deps };

    handlerFor["usd-load-start"]({ payload: "/scene/broken.usdz" });
    stageState.activeStageId = 2;
    loadOrchestrator.rootFile = "/scene/b.usda";
    loadOrchestrator.requestedPath = "/scene/b.usda";
    loadOrchestrator.dependencies = {};
    handlerFor["usd-load-error"]({ payload: "bad archive" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadOrchestrator.rootFile).toBe("/scene/b.usda");
    expect(loadOrchestrator.requestedPath).toBe("/scene/b.usda");
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

  it("usd-scene-loaded adopts the payload and composes the render scene", async () => {
    const loadScene = vi.fn().mockResolvedValue(undefined);
    await loadOrchestrator.init({ resetScene: () => {}, loadScene });

    handlerFor["usd-load-start"]({ payload: "/scene/bike.usda" });
    handlerFor["usd-scene-loaded"]({
      payload: { root_file: "/scene/bike.usda", dependencies: deps },
    });
    await vi.waitFor(() => expect(loadScene).toHaveBeenCalledTimes(1));

    expect(loadOrchestrator.loadingProgress).toBeNull();
    expect(loadOrchestrator.rootFile).toBe("/scene/bike.usda");
    expect(loadOrchestrator.dependencies).toEqual(deps);
  });

  it("usd-stage-opened adopts the stage info and refreshes the edit state", async () => {
    await loadOrchestrator.init(noHooks);
    mockedInvoke.mockResolvedValueOnce([]);

    handlerFor["usd-stage-opened"]({ payload: stageInfo });
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("get_stage_tree", { stageId: 3 }));

    expect(stageState.stageInfo).toEqual(stageInfo);
    expect(stageState.status).toBe("ready");
  });
});
