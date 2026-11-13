// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tabsState, tabDisplayName, type TabCameraView } from "./tabsState.svelte";
import { stageState } from "../stage/stageState.svelte";
import { editState } from "./editState.svelte";
import { layerTextState } from "./layerTextState.svelte";
import { loadOrchestrator } from "./loadOrchestrator.svelte";
import { recentFiles } from "./recentFiles.svelte";
import type { StageInfo, StageSummary } from "../stage/types";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

const handlers: Record<string, ((event: { payload: unknown }) => void)[]> = {};

let nextStageId = 0;
// The mock backend's per-stage dirty counts (list_stages source).
const dirtyOverrides = new Map<number, number>();
const badPaths = new Set<string>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stageInfoFor(id: number, path: string): StageInfo {
  return {
    stage_id: id,
    root_layer: path,
    time_codes_per_second: 24,
    start_time_code: 0,
    end_time_code: 0,
    composition_errors: [],
    up_axis: "Y",
  };
}

function commands(cmd: string, args?: Record<string, unknown>): unknown {
  const stageId = (args?.stageId ?? 0) as number;
  if (cmd !== "open_usd_file_path" && cmd !== "list_stages" && stageId === 0) {
    throw new Error("no stage open");
  }
  switch (cmd) {
    case "open_usd_file_path": {
      const path = (args?.path ?? "") as string;
      if (badPaths.has(path)) {
        for (const h of handlers["usd-load-start"] ?? []) h({ payload: path });
        throw new Error("cannot open: " + path);
      }
      nextStageId += 1;
      const info = stageInfoFor(nextStageId, path);
      // The command emits the same event stream as the dialog flow.
      const fire = (name: string, payload: unknown) => {
        for (const h of handlers[name] ?? []) h({ payload });
      };
      fire("usd-load-start", path);
      fire("usd-load-progress", { stage: "Opening File", percent: 10 });
      fire("usd-scene-loaded", { root_file: path, dependencies: {} });
      fire("usd-stage-opened", info);
      return info;
    }
    case "get_stage_tree":
      return [];
    case "list_stages":
      return tabsState.stages.map((tab): StageSummary => ({
        stage_id: tab.stage_id,
        root_identifier: tab.root_identifier,
        dirty_count: dirtyOverrides.get(tab.stage_id) ?? 0,
      }));
    case "get_edit_target":
      return { layer_identifier: "/session.usda", is_session: true, is_usdz_stage: false };
    case "list_dirty_layers":
      return [];
    case "get_undo_state":
      return { can_undo: false, can_redo: false };
    case "close_stage":
      return undefined;
    default:
      throw new Error("unexpected command: " + cmd);
  }
}

// Fan an event out to every registered listener, like the real backend.
function fireEvent(name: string, payload: unknown): void {
  for (const h of handlers[name] ?? []) h({ payload });
}

async function openTab(path: string): Promise<void> {
  await tabsState.openTab(path);
  // The event-driven open flow settles asynchronously; wait for the tab
  // to be registered and activated before asserting.
  await vi.waitFor(() => {
    const tab = tabsState.stages.find((t) => t.root_file === path);
    expect(tab).toBeDefined();
    expect(tabsState.activeId).toBe(tab!.stage_id);
  });
  // adoptOpened fires editState.refresh detached; let it settle before asserts.
  await vi.waitFor(() => {
    expect(mockedInvoke).toHaveBeenCalledWith("get_undo_state", { stageId: tabsState.activeId });
  });
}

beforeEach(async () => {
  mockedInvoke
    .mockReset()
    .mockImplementation((cmd, args) =>
      Promise.resolve(commands(cmd, (args ?? {}) as Record<string, unknown>)),
    );
  mockedListen.mockReset().mockImplementation(async (name, callback) => {
    const key = name as string;
    (handlers[key] ??= []).push(callback as (event: { payload: unknown }) => void);
    return () => {};
  });
  for (const key of Object.keys(handlers)) delete handlers[key];
  nextStageId = 0;
  dirtyOverrides.clear();
  badPaths.clear();

  tabsState.stages = [];
  tabsState.activeId = 0;
  tabsState.recentIds = [];
  tabsState.pendingCloseId = null;
  tabsState.pendingCloseDirty = 0;
  tabsState.loadScene = vi.fn().mockResolvedValue(undefined);
  tabsState.resetScene = vi.fn();
  tabsState.cameras.clear();
  tabsState.readCamera = () => null;
  tabsState.applyCamera = () => {};
  // The path-open flow is event-driven like the dialog flow; both stores'
  // listeners must be wired for openTab.
  await tabsState.init({ loadScene: tabsState.loadScene, resetScene: tabsState.resetScene });
  await loadOrchestrator.init({ loadScene: tabsState.loadScene, resetScene: tabsState.resetScene });

  stageState.activeStageId = 0;
  stageState.stageInfo = null;
  stageState.tree = [];
  stageState.selectedPath = null;
  stageState.details = null;
  stageState.status = "idle";
  stageState.error = null;

  editState.editTarget = null;
  editState.dirtyLayers = [];
  editState.canUndo = false;
  editState.canRedo = false;

  layerTextState.draftDirty = false;
  loadOrchestrator.rootFile = null;
  loadOrchestrator.dependencies = null;
  loadOrchestrator.loadingProgress = null;
  loadOrchestrator.modalError = null;

  localStorage.clear();
  recentFiles.clear();
});

describe("tabDisplayName", () => {
  it("shows the root identifier's file name", () => {
    expect(tabDisplayName({ root_identifier: "/scene/bike.usda" })).toBe("bike.usda");
  });

  it("survives windows separators and trailing slashes", () => {
    expect(tabDisplayName({ root_identifier: "C:\\assets\\model.usd" })).toBe("model.usd");
    expect(tabDisplayName({ root_identifier: "/scene/dir/" })).toBe("dir");
  });
});

describe("openTab", () => {
  it("opens a new backend stage through the path orchestration command", async () => {
    await openTab("/scene/a.usda");

    expect(mockedInvoke).toHaveBeenCalledWith("open_usd_file_path", { path: "/scene/a.usda" });
    expect(tabsState.stages).toHaveLength(1);
    expect(tabsState.stages[0].stage_id).toBe(1);
    expect(tabsState.stages[0].root_file).toBe("/scene/a.usda");
    expect(tabsState.activeId).toBe(1);
    expect(stageState.activeStageId).toBe(1);
    expect(stageState.stageInfo?.stage_id).toBe(1);
    expect(loadOrchestrator.rootFile).toBe("/scene/a.usda");
    expect(tabsState.loadScene).toHaveBeenCalled();
  });

  it("refuses a second open while the first is unresolved", async () => {
    const pending = deferred<StageInfo>();
    mockedInvoke.mockImplementationOnce(() => pending.promise);

    const first = tabsState.openTab("/scene/slow.usda");
    await tabsState.openTab("/scene/fast.usda");

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "open_usd_file_path")).toHaveLength(1);
    expect(loadOrchestrator.modalError).toContain("already opening");
    expect(recentFiles.entries).toEqual([]);

    const info = stageInfoFor(1, "/scene/slow.usda");
    fireEvent("usd-load-start", "/scene/slow.usda");
    fireEvent("usd-scene-loaded", { root_file: "/scene/slow.usda", dependencies: {} });
    fireEvent("usd-stage-opened", info);
    pending.resolve(info);
    await first;

    expect(tabsState.stages.map((tab) => tab.root_file)).toEqual(["/scene/slow.usda"]);
    expect(tabsState.activeId).toBe(1);
    expect(loadOrchestrator.dependencies).toEqual({});
    expect(recentFiles.entries.map((entry) => entry.path)).toEqual(["/scene/slow.usda"]);
  });

  it("keeps the requested usdz path instead of the extracted layer path", async () => {
    const info = stageInfoFor(7, "/tmp/usdbee/extracted/root.usda");
    fireEvent("usd-load-start", "/scene/archive.usdz");
    fireEvent("usd-scene-loaded", {
      root_file: "/tmp/usdbee/extracted/root.usda",
      dependencies: {},
    });
    fireEvent("usd-stage-opened", info);

    await vi.waitFor(() => expect(tabsState.activeId).toBe(7));

    expect(tabsState.stages[0].root_file).toBe("/scene/archive.usdz");
    expect(loadOrchestrator.rootFile).toBe("/scene/archive.usdz");
    expect(recentFiles.entries[0].path).toBe("/scene/archive.usdz");
  });

  it("refuses a dialog-initiated load-start while a path open is in flight", async () => {
    const pending = deferred<StageInfo>();
    mockedInvoke.mockImplementationOnce(() => pending.promise);
    const first = tabsState.openTab("/scene/slow.usda");
    fireEvent("usd-load-start", "/scene/slow.usda");

    // A dialog-initiated second open (no JS reservation) arrives mid-flight.
    fireEvent("usd-load-start", "/scene/dialog.usda");

    expect(loadOrchestrator.modalError).toContain("already opening");
    expect(loadOrchestrator.rootFile).toBe("/scene/slow.usda");
    expect(loadOrchestrator.loadingProgress).toEqual({ stage: "Starting...", percent: 0 });
    expect(tabsState.resetScene).toHaveBeenCalledTimes(1);

    // The refused open's whole event stream is ignored.
    fireEvent("usd-load-progress", { stage: "Opening File", percent: 60 });
    expect(loadOrchestrator.loadingProgress).toEqual({ stage: "Starting...", percent: 0 });
    fireEvent("usd-scene-loaded", {
      root_file: "/scene/dialog.usda",
      dependencies: { "/dialog.dep": { path: "/dialog.dep", resolved: true, size_bytes: 1 } },
    });
    expect(loadOrchestrator.dependencies).toBeNull();
    fireEvent("usd-stage-opened", stageInfoFor(9, "/scene/dialog.usda"));
    fireEvent("usd-load-error", "dialog stream failed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tabsState.stages).toHaveLength(0);
    expect(stageState.stageInfo).toBeNull();
    expect(loadOrchestrator.modalError).toContain("already opening");
    expect(recentFiles.entries).toEqual([]);

    // The first open completes with its own root, deps and recent entry.
    const info = stageInfoFor(1, "/scene/slow.usda");
    fireEvent("usd-scene-loaded", { root_file: "/scene/slow.usda", dependencies: {} });
    fireEvent("usd-stage-opened", info);
    pending.resolve(info);
    await first;

    expect(tabsState.stages.map((tab) => tab.root_file)).toEqual(["/scene/slow.usda"]);
    expect(tabsState.activeId).toBe(1);
    expect(loadOrchestrator.dependencies).toEqual({});
    expect(recentFiles.entries.map((entry) => entry.path)).toEqual(["/scene/slow.usda"]);
  });

  it("a refused second stream adopts nothing after the first open finishes", async () => {
    const pending = deferred<StageInfo>();
    mockedInvoke.mockImplementationOnce(() => pending.promise);
    const first = tabsState.openTab("/scene/slow.usda");
    fireEvent("usd-load-start", "/scene/slow.usda");
    // A dialog-initiated second open is refused mid-flight.
    fireEvent("usd-load-start", "/scene/dialog.usda");
    expect(loadOrchestrator.modalError).toContain("already opening");

    // The first open completes and frees the slot.
    const info = stageInfoFor(1, "/scene/slow.usda");
    fireEvent("usd-scene-loaded", { root_file: "/scene/slow.usda", dependencies: {} });
    fireEvent("usd-stage-opened", info);
    pending.resolve(info);
    await first;
    expect(tabsState.activeId).toBe(1);

    // The refused stream finishes backend-side afterwards: no tab, no
    // recent entry, no activation, and its orphan stage is closed.
    fireEvent("usd-load-progress", { stage: "Opening File", percent: 60 });
    fireEvent("usd-scene-loaded", {
      root_file: "/scene/dialog.usda",
      dependencies: { "/dialog.dep": { path: "/dialog.dep", resolved: true, size_bytes: 1 } },
    });
    fireEvent("usd-stage-opened", stageInfoFor(9, "/scene/dialog.usda"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([1]);
    expect(tabsState.activeId).toBe(1);
    expect(stageState.stageInfo?.stage_id).toBe(1);
    expect(loadOrchestrator.rootFile).toBe("/scene/slow.usda");
    expect(loadOrchestrator.dependencies).toEqual({});
    expect(loadOrchestrator.loadingProgress).toBeNull();
    expect(recentFiles.entries.map((entry) => entry.path)).toEqual(["/scene/slow.usda"]);
    expect(mockedInvoke).toHaveBeenCalledWith("close_stage", { stageId: 9 });
  });

  it("a backend gate refusal of a path open releases the slot without failing the open", async () => {
    mockedInvoke.mockImplementationOnce(() =>
      Promise.reject("A USD file is already opening. Wait for it to finish before opening another."),
    );

    await tabsState.openTab("/scene/b.usda");

    expect(loadOrchestrator.modalError).toContain("already opening");
    expect(loadOrchestrator.modalError).not.toContain("Failed to open USD");
    expect(tabsState.stages).toHaveLength(0);
    expect(recentFiles.entries).toEqual([]);
    // No stage was minted for a gate refusal, so nothing needs closing.
    expect(mockedInvoke).not.toHaveBeenCalledWith("close_stage", expect.anything());

    // The refusal released the slot: the next open proceeds normally.
    await openTab("/scene/a.usda");
    expect(tabsState.stages.map((tab) => tab.root_file)).toEqual(["/scene/a.usda"]);
    expect(tabsState.activeId).toBe(1);
  });

  it("adopts the opening file's own path after a mid-open tab switch", async () => {
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");
    const pending = deferred<StageInfo>();
    mockedInvoke.mockImplementationOnce(() => pending.promise);
    const opening = tabsState.openTab("/scene/a.usda");
    fireEvent("usd-load-start", "/scene/a.usda");

    // Switching tabs mid-open rewrites the active view's shared state.
    await tabsState.setActive(1);
    expect(loadOrchestrator.rootFile).toBe("/scene/b.usda");

    const info = stageInfoFor(3, "/scene/a.usda");
    fireEvent("usd-scene-loaded", { root_file: "/scene/a.usda", dependencies: {} });
    fireEvent("usd-stage-opened", info);
    pending.resolve(info);
    await opening;

    expect(tabsState.stages.find((tab) => tab.stage_id === 3)?.root_file).toBe("/scene/a.usda");
    expect(recentFiles.entries.map((entry) => entry.path)).toEqual([
      "/scene/a.usda",
      "/scene/c.usda",
      "/scene/b.usda",
    ]);
    expect(loadOrchestrator.rootFile).toBe("/scene/a.usda");
  });

  it("opens a tab without the prim-tree walk, which the panel fetches once", async () => {
    // Opening used to fire get_stage_tree twice (the orchestrator's adopt
    // and the tab activation's); the tree is lazy now, so opening fires it
    // zero times and the first panel mount exactly once.
    await openTab("/scene/a.usda");
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_stage_tree", expect.anything());

    await stageState.ensureTree();
    await stageState.ensureTree();

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_stage_tree")).toHaveLength(1);
  });

  it("records the opened file in recent files", async () => {
    await openTab("/scene/a.usda");

    expect(recentFiles.entries[0]).toEqual({ path: "/scene/a.usda", name: "a.usda" });
    expect(recentFiles.entries).toHaveLength(1);
  });

  it("opens each path as its own tab", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");

    expect(tabsState.stages.map((tab) => tab.root_identifier)).toEqual(["/scene/a.usda", "/scene/b.usda"]);
    expect(tabsState.activeId).toBe(2);
  });

  it("keeps the current tab and surfaces the error when the open fails", async () => {
    await openTab("/scene/a.usda");
    badPaths.add("/bad.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    await tabsState.openTab("/bad.usda");

    expect(tabsState.stages).toHaveLength(1);
    expect(tabsState.activeId).toBe(1);
    expect(stageState.stageInfo?.stage_id).toBe(1);
    expect(loadOrchestrator.modalError).toContain("cannot open: /bad.usda");
    expect(loadOrchestrator.loadingProgress).toBeNull();
    expect(loadOrchestrator.rootFile).toBe("/scene/a.usda");
    expect(loadOrchestrator.dependencies).toEqual({});
    expect(tabsState.loadScene).toHaveBeenCalledTimes(1);
    expect(recentFiles.entries.map((e) => e.path)).not.toContain("/bad.usda");
  });
});

describe("setActive", () => {
  it("refetches edit state and scene for the switched-to stage, without the prim tree", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    mockedInvoke.mockClear();
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    await tabsState.setActive(1);

    // The tree stays lazy: only the panel component asks for it.
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_stage_tree", expect.anything());
    expect(mockedInvoke).toHaveBeenCalledWith("get_edit_target", { stageId: 1 });
    expect(tabsState.loadScene).toHaveBeenCalledTimes(1);
    expect(tabsState.activeId).toBe(1);
    expect(stageState.activeStageId).toBe(1);
    expect(stageState.stageInfo?.stage_id).toBe(1);
    expect(stageState.selectedPath).toBeNull();
  });

  it("does not load a scene for a stale activation", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    const staleActivation = tabsState.setActive(1);
    await tabsState.setActive(2);
    await staleActivation;

    expect(tabsState.activeId).toBe(2);
    expect(stageState.activeStageId).toBe(2);
    expect(tabsState.loadScene).toHaveBeenCalledTimes(1);
  });

  it("no-ops for the already active tab", async () => {
    await openTab("/scene/a.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    await tabsState.setActive(tabsState.activeId);

    expect(tabsState.loadScene).not.toHaveBeenCalled();
  });

  it("captures the camera on leave and restores it on return", async () => {
    const viewA: TabCameraView = { position: [1, 2, 3], target: [0, 0, 0], fov: 40 };
    const viewB: TabCameraView = { position: [4, 5, 6], target: [1, 1, 1], fov: 50 };
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    const applyCamera = vi.fn();
    tabsState.applyCamera = applyCamera;
    tabsState.readCamera = vi.fn(() => viewB);

    await tabsState.setActive(1); // leaves b, captures viewB for b
    expect(applyCamera).toHaveBeenLastCalledWith(null);

    tabsState.readCamera = vi.fn(() => viewA);
    await tabsState.setActive(2); // leaves a, captures viewA for a
    expect(applyCamera).toHaveBeenLastCalledWith(viewB);

    await tabsState.setActive(1);
    expect(applyCamera).toHaveBeenLastCalledWith(viewA);
  });

  it("keeps a stored view when the viewer cannot supply a camera", async () => {
    const viewA: TabCameraView = { position: [1, 2, 3], target: [0, 0, 0], fov: 40 };
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    const applyCamera = vi.fn();
    tabsState.applyCamera = applyCamera;
    tabsState.readCamera = vi.fn(() => viewA);

    await tabsState.setActive(1); // b stores viewA
    tabsState.readCamera = vi.fn(() => null);
    await tabsState.setActive(2);

    expect(applyCamera).toHaveBeenLastCalledWith(viewA);
  });

  it("applies only the winning activation's camera", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");
    tabsState.readCamera = vi.fn(() => null);
    const applyCamera = vi.fn();
    tabsState.applyCamera = applyCamera;
    let release!: () => void;
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const stale = tabsState.setActive(1);
    await vi.waitFor(() => expect(tabsState.loadScene).toHaveBeenCalledTimes(1));
    const winner = tabsState.setActive(2);
    release();
    await winner;
    await stale;

    expect(applyCamera).toHaveBeenCalledTimes(1);
    expect(applyCamera).toHaveBeenLastCalledWith(null);
  });
});

describe("closeTab", () => {
  it("closes a clean stage without asking", async () => {
    await openTab("/scene/a.usda");

    await tabsState.closeTab(1);

    expect(tabsState.pendingCloseId).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("close_stage", { stageId: 1 });
    expect(tabsState.stages).toHaveLength(0);
  });

  it("asks before closing a dirty stage, then closes on confirm", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    dirtyOverrides.set(2, 2);
    mockedInvoke.mockClear();

    await tabsState.closeTab(2);

    expect(mockedInvoke).not.toHaveBeenCalledWith("close_stage", expect.anything());
    expect(tabsState.pendingCloseId).toBe(2);
    expect(tabsState.pendingCloseDirty).toBe(2);

    await tabsState.closeConfirmed(2);

    expect(mockedInvoke).toHaveBeenCalledWith("close_stage", { stageId: 2 });
    expect(tabsState.pendingCloseId).toBeNull();
    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([1]);
    // The neighbor becomes the active tab with a fresh scene; its tree
    // stays lazy until the hierarchy panel asks for it.
    expect(tabsState.activeId).toBe(1);
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_stage_tree", expect.anything());
    expect(tabsState.loadScene).toHaveBeenCalled();
  });

  it("counts the active stage's unapplied text draft as unsaved work", async () => {
    await openTab("/scene/a.usda");
    layerTextState.draftDirty = true;
    mockedInvoke.mockClear();

    await tabsState.closeTab(1);

    expect(mockedInvoke).not.toHaveBeenCalledWith("close_stage", expect.anything());
    expect(tabsState.pendingCloseId).toBe(1);

    await tabsState.cancelClose();
    expect(tabsState.pendingCloseId).toBeNull();
  });

  it("leaves the active view alone when closing an inactive tab", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();
    mockedInvoke.mockClear();

    await tabsState.closeTab(1);

    expect(mockedInvoke).toHaveBeenCalledWith("close_stage", { stageId: 1 });
    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([2]);
    expect(tabsState.activeId).toBe(2);
    expect(stageState.activeStageId).toBe(2);
    expect(tabsState.loadScene).not.toHaveBeenCalled();
  });

  it("empties the app when the last tab closes", async () => {
    await openTab("/scene/a.usda");

    await tabsState.closeTab(1);

    expect(tabsState.activeId).toBe(0);
    expect(tabsState.stages).toHaveLength(0);
    expect(stageState.activeStageId).toBe(0);
    expect(stageState.stageInfo).toBeNull();
    expect(stageState.status).toBe("idle");
    expect(loadOrchestrator.rootFile).toBeNull();
    // The load-start event resets the scene (dialog-flow behavior) and the
    // last close resets it again.
    expect(tabsState.resetScene).toHaveBeenCalledTimes(2);
    expect(editState.dirtyLayers).toEqual([]);
  });
});

describe("moveTab", () => {
  it("moves a tab right and keeps the active id", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");
    await tabsState.setActive(2);

    tabsState.moveTab(1, 2);

    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([2, 3, 1]);
    expect(tabsState.activeId).toBe(2);
  });

  it("moves a tab left", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");

    tabsState.moveTab(3, 0);

    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([3, 1, 2]);
  });

  it("ignores unknown ids and same-slot moves", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");

    tabsState.moveTab(999, 0);
    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([1, 2, 3]);

    tabsState.moveTab(1, 0);
    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([1, 2, 3]);
  });
});

describe("tab history", () => {
  it("pushes the previously active tab to the front of the history", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");
    expect(tabsState.recentIds).toEqual([2, 1]);

    await tabsState.setActive(1);

    expect(tabsState.recentIds).toEqual([3, 2, 1]);
  });

  it("caps the history at ten entries", async () => {
    for (let i = 1; i <= 12; i += 1) await openTab(`/scene/${i}.usda`);

    expect(tabsState.recentIds).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });
});

describe("activateRecent", () => {
  it("reactivates the previously active tab", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    await tabsState.activateRecent();

    expect(tabsState.activeId).toBe(1);
    expect(stageState.stageInfo?.stage_id).toBe(1);
    expect(tabsState.loadScene).toHaveBeenCalledTimes(1);
  });

  it("skips ids of tabs that no longer exist", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");
    expect(tabsState.recentIds).toEqual([2, 1]);
    await tabsState.closeTab(2);

    await tabsState.activateRecent();

    expect(tabsState.activeId).toBe(1);
    expect(tabsState.recentIds).not.toContain(2);
  });

  it("no-ops when the history is empty", async () => {
    await openTab("/scene/a.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    await tabsState.activateRecent();

    expect(tabsState.activeId).toBe(1);
    expect(tabsState.loadScene).not.toHaveBeenCalled();
  });
});

describe("cycleTab", () => {
  it("wraps forward and backward through the tabs", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");

    await tabsState.cycleTab(1);
    expect(tabsState.activeId).toBe(1);

    await tabsState.cycleTab(-1);
    expect(tabsState.activeId).toBe(3);
  });

  it("no-ops with fewer than two tabs", async () => {
    await openTab("/scene/a.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    await tabsState.cycleTab(1);

    expect(tabsState.activeId).toBe(1);
    expect(tabsState.loadScene).not.toHaveBeenCalled();
  });
});

describe("swapTab", () => {
  it("moves the active tab one slot and clamps at the ends", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    await openTab("/scene/c.usda");
    await tabsState.setActive(1);

    tabsState.swapTab(-1);
    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([1, 2, 3]);

    tabsState.swapTab(1);
    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([2, 1, 3]);

    tabsState.swapTab(1);
    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([2, 3, 1]);

    tabsState.swapTab(1);
    expect(tabsState.stages.map((t) => t.stage_id)).toEqual([2, 3, 1]);
    expect(tabsState.activeId).toBe(1);
  });
});

describe("event subscriptions", () => {
  it("usd-stage-changed for an inactive stage refreshes the summaries only", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    dirtyOverrides.set(1, 3);
    mockedInvoke.mockClear();
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    fireEvent("usd-stage-changed", { stage_id: 1, paths: ["/World"] });
    await vi.waitFor(() => {
      expect(tabsState.stages.find((tab) => tab.stage_id === 1)?.dirty_count).toBe(3);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("list_stages");
    // The active tab's view does not refetch for another stage's event.
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_stage_tree", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_edit_target", expect.anything());
    expect(tabsState.loadScene).not.toHaveBeenCalled();
    expect(stageState.stageInfo?.stage_id).toBe(2);
  });

  it("usd-stage-opened registers the stage as a new active tab", async () => {
    await openTab("/scene/a.usda");
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    fireEvent("usd-stage-opened", stageInfoFor(7, "/scene/dialog.usda"));
    await vi.waitFor(() => {
      expect(tabsState.activeId).toBe(7);
      expect(tabsState.loadScene).toHaveBeenCalled();
    });

    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([1, 7]);
    expect(stageState.stageInfo?.stage_id).toBe(7);
    expect(tabsState.loadScene).toHaveBeenCalled();
  });
});
