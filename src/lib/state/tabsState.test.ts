// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tabsState, tabDisplayName } from "./tabsState.svelte";
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
  tabsState.pendingCloseId = null;
  tabsState.pendingCloseDirty = 0;
  tabsState.loadScene = vi.fn().mockResolvedValue(undefined);
  tabsState.resetScene = vi.fn();
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
  it("refetches tree, edit state and scene for the switched-to stage", async () => {
    await openTab("/scene/a.usda");
    await openTab("/scene/b.usda");
    mockedInvoke.mockClear();
    (tabsState.loadScene as ReturnType<typeof vi.fn>).mockClear();

    await tabsState.setActive(1);

    expect(mockedInvoke).toHaveBeenCalledWith("get_stage_tree", { stageId: 1 });
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
    const staleTree = deferred<unknown[]>();
    mockedInvoke.mockImplementation((cmd, args) => {
      if (cmd === "get_stage_tree" && (args as Record<string, unknown> | undefined)?.stageId === 1) {
        return staleTree.promise;
      }
      return Promise.resolve(commands(cmd, (args ?? {}) as Record<string, unknown>));
    });

    const staleActivation = tabsState.setActive(1);
    await vi.waitFor(() => expect(stageState.activeStageId).toBe(1));
    await tabsState.setActive(2);
    staleTree.resolve([]);
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
    // The neighbor becomes the active tab with a fresh refetch.
    expect(tabsState.activeId).toBe(1);
    expect(mockedInvoke).toHaveBeenCalledWith("get_stage_tree", { stageId: 1 });
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
