import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { stageState } from "../stage/stageState.svelte";
import { editState } from "./editState.svelte";
import { layerTextState } from "./layerTextState.svelte";
import { loadOrchestrator, type DependencyMap } from "./loadOrchestrator.svelte";
import { confirmCloseNeeded } from "./closeGuard";
import type { StageInfo, StageSummary } from "../stage/types";

// Stage tabs (Task 11): one tab per open backend stage. The ACTIVE tab owns
// the viewport, the selection and the edit target/dirty/undo state; all of
// it is refetched on switch (v1 keeps no cross-tab caches). Open-flow
// metadata the frontend cannot re-query (StageInfo, the dependency scan)
// is snapshotted on the tab record at open time.

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

export const tabsState = $state({
  stages: [] as TabRecord[],
  activeId: 0,
  // The tab awaiting the close-confirm modal; null when none asks.
  pendingCloseId: null as number | null,
  pendingCloseDirty: 0,

  // Viewport-owned scene steps, wired through init (same pattern as the
  // loadOrchestrator hooks): a full scene compose for the active stage and
  // the empty-view reset.
  loadScene: (async () => {}) as () => Promise<void>,
  resetScene: (() => {}) as () => void,

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
  async init(hooks: { loadScene: () => Promise<void>; resetScene: () => void }): Promise<() => void> {
    this.loadScene = hooks.loadScene;
    this.resetScene = hooks.resetScene;
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
    this.register(info, loadOrchestrator.rootFile ?? info.root_layer, loadOrchestrator.dependencies);
    await this.setActive(info.stage_id);
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

  // Path-based open (drag-drop, recent files): a NEW backend stage per
  // call through open_usd_path. No dialog orchestration runs here — no
  // usdz extraction, no dependency scan — so errors surface through the
  // shared error modal and the scene composes without fallback colors.
  async openTab(path: string): Promise<void> {
    loadOrchestrator.loadingProgress = { stage: "Opening stage...", percent: 0 };
    let info: StageInfo;
    try {
      info = await invoke<StageInfo>("open_usd_path", { path });
    } catch (e) {
      loadOrchestrator.loadingProgress = null;
      loadOrchestrator.openErrorModal("Failed to open USD:\n\n" + (typeof e === "string" ? e : String(e)));
      return;
    }
    loadOrchestrator.rootFile = path;
    loadOrchestrator.dependencies = null;
    await stageState.adoptOpenedStage(info);
    this.register(info, path, null);
    this.activeId = info.stage_id;
    void editState.refresh();
    await this.loadScene();
    loadOrchestrator.loadingProgress = null;
  },

  // Activate a tab: per-tab state is refetched fresh — tree/details through
  // stageState, edit target/dirty/undo through editState, the viewport
  // through a full scene rebuild.
  async setActive(id: number): Promise<void> {
    const tab = this.find(id);
    if (!tab || id === this.activeId) return;
    this.activeId = id;
    loadOrchestrator.rootFile = tab.root_file;
    loadOrchestrator.dependencies = tab.dependencies;
    await stageState.adoptOpenedStage(tab.stage_info);
    void editState.refresh();
    await this.loadScene();
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
