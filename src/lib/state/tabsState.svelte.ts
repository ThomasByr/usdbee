import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { stageState } from "../stage/stageState.svelte";
import { editState } from "./editState.svelte";
import { layerTextState } from "./layerTextState.svelte";
import { loadOrchestrator, OPEN_IN_FLIGHT_MESSAGE, type DependencyMap } from "./loadOrchestrator.svelte";
import { recentFiles } from "./recentFiles.svelte";
import { confirmCloseNeeded } from "./closeGuard";
import type { StageInfo, StageSummary } from "../stage/types";

// Stage tabs (Task 11): one tab per open backend stage. The ACTIVE tab owns
// the viewport, the selection and the edit target/dirty/undo state; all of
// it is refetched on switch, except the camera view, which is cached per tab
// for the session. Open-flow metadata the frontend cannot re-query
// (StageInfo, the dependency scan) is snapshotted on the tab record at open
// time.

let activationGeneration = 0;

export interface TabRecord extends StageSummary {
  stage_info: StageInfo;
  // The path the user opened (the pre-extraction path for usdz dialog opens).
  root_file: string;
  dependencies: DependencyMap | null;
}

// The tab's display name: the file name of its root identifier.
export function tabDisplayName(tab: Pick<TabRecord, "root_identifier">): string {
  const parts = tab.root_identifier.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? tab.root_identifier;
}

// A tab's viewport view. Session only, plain numbers so this module keeps no
// three.js dependency.
export interface TabCameraView {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export const tabsState = $state({
  stages: [] as TabRecord[],
  activeId: 0,
  // Previously active tab ids, newest first (cap 10); the palette's
  // "last tab" command reads it.
  recentIds: [] as number[],
  // The tab awaiting the close-confirm modal; null when none asks.
  pendingCloseId: null as number | null,
  pendingCloseDirty: 0,

  // Viewport-owned scene steps, wired through init (same pattern as the
  // loadOrchestrator hooks): a full scene compose for the active stage and
  // the empty-view reset.
  loadScene: (async () => {}) as () => Promise<void>,
  resetScene: (() => {}) as () => void,
  // Per-tab viewport view: captured when a tab is left, applied after the
  // rebuild when a tab is entered. The hooks are wired by the Viewport.
  cameras: new Map<number, TabCameraView>(),
  readCamera: (() => null) as () => TabCameraView | null,
  applyCamera: ((_view: TabCameraView | null) => {}) as (view: TabCameraView | null) => void,

  forgetCamera(id: number): void {
    this.cameras.delete(id);
  },

  forgetActiveCamera(): void {
    this.cameras.delete(this.activeId);
  },

  find(id: number): TabRecord | undefined {
    return this.stages.find((tab) => tab.stage_id === id);
  },

  // Re-sync the dirty-count/root snapshots from list_stages; drops tabs
  // whose stage vanished backend-side.
  async refreshSummaries(): Promise<void> {
    try {
      const summaries = await invoke<StageSummary[]>("list_stages");
      this.stages = this.stages.filter((tab) => summaries.some((s) => s.stage_id === tab.stage_id));
      for (const tab of this.stages) {
        const summary = summaries.find((s) => s.stage_id === tab.stage_id);
        if (summary) {
          tab.root_identifier = summary.root_identifier;
          tab.dirty_count = summary.dirty_count;
        }
      }
    } catch {
      // list_stages unavailable: keep the last snapshots.
    }
  },

  // Subscribe to backend events; the Viewport wires the scene hooks in
  // onMount and unlistens on destroy.
  async init(hooks: {
    loadScene: () => Promise<void>;
    resetScene: () => void;
    readCamera?: () => TabCameraView | null;
    applyCamera?: (view: TabCameraView | null) => void;
  }): Promise<() => void> {
    this.loadScene = hooks.loadScene;
    this.resetScene = hooks.resetScene;
    if (hooks.readCamera) this.readCamera = hooks.readCamera;
    if (hooks.applyCamera) this.applyCamera = hooks.applyCamera;
    const unlistens = await Promise.all([
      listen("usd-stage-changed", (event) => {
        // Any stage's edit can move its dirty count (the tab dot). The
        // ACTIVE stage's tree/details/scene refreshes stay with their own
        // activeStageId-filtered listeners — an inactive stage's event
        // must not touch the active view.
        void this.refreshSummaries();
      }),
      listen<StageInfo>("usd-stage-opened", (event) => {
        void this.adoptOpened(event.payload);
      }),
    ]);
    return () => unlistens.forEach((unlisten) => unlisten());
  },

  // A backend open completed (the dialog flow). The open's root file and
  // dependency scan already sit on loadOrchestrator (usd-load-start /
  // usd-scene-loaded); the stage itself was adopted by loadOrchestrator's
  // own listener. Register the tab, activate it, and compose its scene.
  // The extra loadScene supersedes whatever the usd-scene-loaded step
  // started: an open always ends with the viewport showing its stage.
  async adoptOpened(info: StageInfo): Promise<void> {
    if (!loadOrchestrator.acceptsStageOpened(info)) return;
    // The user-facing path (pre-extraction for usdz) is what recent files,
    // containing-folder reveal and the tab record all keep — pinned on
    // THIS open's load-start, so a mid-open tab switch cannot reroute it.
    const rootFile = loadOrchestrator.openRequestedPath() ?? info.root_layer;
    recentFiles.add(rootFile);
    this.register(info, rootFile, loadOrchestrator.dependencies);
    try {
      await this.setActive(info.stage_id);
    } finally {
      loadOrchestrator.finishOpen();
    }
  },

  register(info: StageInfo, rootFile: string, dependencies: DependencyMap | null): void {
    if (this.find(info.stage_id)) return;
    this.stages.push({
      stage_id: info.stage_id,
      root_identifier: info.root_layer,
      dirty_count: 0,
      stage_info: info,
      root_file: rootFile,
      dependencies,
    });
  },

  // Path-based open (drag-drop, recent files): the backend command runs
  // the SAME orchestration as the dialog flow — usdz extraction, the
  // dependency scan, the usd-load-* progress events — so the tab
  // registers through the shared usd-stage-opened listener like every
  // other open, and big files show progress. The command's Err carries
  // the readable failure message.
  async openTab(path: string): Promise<void> {
    const completion = loadOrchestrator.beginPathOpen();
    if (!completion) return;
    try {
      await invoke<StageInfo>("open_usd_file_path", { path });
      await completion;
    } catch (e) {
      const message = typeof e === "string" ? e : String(e);
      if (message === OPEN_IN_FLIGHT_MESSAGE) {
        // A backend gate refusal is not a failure: nothing loaded, nothing
        // to restore — surface the refusal and release the slot.
        loadOrchestrator.refuseOpen();
      } else {
        await loadOrchestrator.failOpen("Failed to open USD:\n\n" + message);
      }
    }
  },

  // Activate a tab: per-tab state is refetched fresh — tree/details through
  // stageState, edit target/dirty/undo through editState, the viewport
  // through a full scene rebuild.
  async setActive(id: number): Promise<void> {
    const tab = this.find(id);
    if (!tab || id === this.activeId) return;
    if (this.activeId !== 0) {
      this.recentIds = [this.activeId, ...this.recentIds.filter((recent) => recent !== this.activeId)].slice(
        0,
        10,
      );
      const view = this.readCamera();
      if (view) this.cameras.set(this.activeId, view);
    }
    const generation = ++activationGeneration;
    this.activeId = id;
    loadOrchestrator.rootFile = tab.root_file;
    loadOrchestrator.dependencies = tab.dependencies;
    await stageState.adoptOpenedStage(tab.stage_info);
    if (generation !== activationGeneration || id !== this.activeId) return;
    void editState.refresh();
    await this.loadScene();
    if (generation !== activationGeneration || id !== this.activeId) return;
    this.applyCamera(this.cameras.get(id) ?? null);
  },

  // Palette tab commands: jump back to the last active tab, cycle through
  // the tabs, reorder the active tab. History ids of closed tabs are
  // pruned here, so nothing has to be kept in sync on close.
  async activateRecent(): Promise<void> {
    this.recentIds = this.recentIds.filter((id) => this.find(id));
    const id = this.recentIds[0];
    if (id === undefined) return;
    await this.setActive(id);
  },

  async cycleTab(delta: 1 | -1): Promise<void> {
    const count = this.stages.length;
    const index = this.stages.findIndex((tab) => tab.stage_id === this.activeId);
    if (count < 2 || index === -1) return;
    await this.setActive(this.stages[(index + delta + count) % count].stage_id);
  },

  // moveTab clamps the target slot, so the ends are a no-op.
  swapTab(delta: 1 | -1): void {
    const index = this.stages.findIndex((tab) => tab.stage_id === this.activeId);
    if (index === -1) return;
    this.moveTab(this.activeId, index + delta);
  },

  // The tab close x: a stage with dirty layers — or the active stage with
  // an unapplied text draft — confirms before close_stage drops its
  // in-memory edits.
  async closeTab(id: number): Promise<void> {
    await this.refreshSummaries();
    const tab = this.find(id);
    if (!tab) return;
    const draftDirty = id === this.activeId && layerTextState.draftDirty;
    if (!confirmCloseNeeded(tab.dirty_count, draftDirty)) {
      await this.closeConfirmed(id);
      return;
    }
    this.pendingCloseDirty = tab.dirty_count + (draftDirty ? 1 : 0);
    this.pendingCloseId = id;
  },

  // Tab drag-release: the array order IS the tab order, so a move is one splice.
  // toIndex is the target slot in the pre-removal indexing.
  moveTab(id: number, toIndex: number): void {
    const from = this.stages.findIndex((tab) => tab.stage_id === id);
    if (from === -1 || toIndex === from || toIndex < 0) return;
    const [tab] = this.stages.splice(from, 1);
    this.stages.splice(Math.min(toIndex, this.stages.length), 0, tab);
  },

  // The confirm modal's buttons.
  async closeConfirmed(id: number): Promise<void> {
    this.pendingCloseId = null;
    try {
      await invoke("close_stage", { stageId: id });
    } catch (e) {
      loadOrchestrator.openErrorModal("Failed to close stage:\n\n" + (typeof e === "string" ? e : String(e)));
      return;
    }
    const index = this.stages.findIndex((tab) => tab.stage_id === id);
    if (index === -1) return;
    this.stages.splice(index, 1);
    if (id !== this.activeId) return;
    // Activate the removed tab's neighbor (the next one, else the
    // previous); no tabs left means the empty no-stage view.
    const next = this.stages[index] ?? this.stages[index - 1];
    if (next) {
      await this.setActive(next.stage_id);
    } else {
      ++activationGeneration;
      this.activeId = 0;
      stageState.clear();
      loadOrchestrator.rootFile = null;
      loadOrchestrator.dependencies = null;
      this.resetScene();
      void editState.refresh();
    }
  },

  cancelClose(): void {
    this.pendingCloseId = null;
  },
});
