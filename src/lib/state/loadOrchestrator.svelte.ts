import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { editState } from "./editState.svelte";
import { stageState } from "../stage/stageState.svelte";
import type { StageInfo } from "../stage/types";

// Loading orchestration (Phase 4 Extraction 1): the root file, the load
// progress, the dependency manifest and the shared error-modal state move
// here from the page. The store subscribes to the Rust load events and
// hands the viewport-bound steps (scene reset, render-scene composition)
// back to the page through hooks — those stay with the renderer.

export interface DependencyInfo {
  path: string;
  resolved: boolean;
  size_bytes: number | null;
  fallback_color?: string | null;
  error_msg?: string | null;
}

export type DependencyMap = Record<string, DependencyInfo>;

export interface LoadProgress {
  stage: string;
  percent: number;
}

// The page supplies the viewport-bound steps; both are declared at the
// call site (removeLoadedGroup / loadRustScene) and only run once the
// viewer is initialized — loadRustScene bails when viewer.scene is unset.
export interface LoadHooks {
  resetScene: () => void;
  loadScene: () => Promise<void>;
}

export function loadErrorMessage(payload: string): string {
  return "Failed to extract or load USD: " + payload;
}

// DependenciesTab filter: case-insensitive substring match on the manifest
// key, empty list while no manifest is loaded.
export function filterDependencies(
  dependencies: DependencyMap | null,
  filterText: string,
): [string, DependencyInfo][] {
  return dependencies
    ? Object.entries(dependencies).filter(([path, _]) =>
        path.toLowerCase().includes(filterText.toLowerCase()),
      )
    : [];
}

export const loadOrchestrator = $state({
  rootFile: null as string | null,
  loadingProgress: null as LoadProgress | null,
  dependencies: null as DependencyMap | null,
  filterText: "",
  // Shared error modal: load failures own it by default, rendering/export
  // errors open it through openErrorModal without overwriting a stage modal.
  modalError: null as string | null,

  openErrorModal: (msg: string) => {
    loadOrchestrator.modalError = msg;
  },

  closeErrorModal: () => {
    loadOrchestrator.modalError = null;
  },

  // Ask the backend to show the file-open dialog; the chosen path comes
  // back through the usd-load-start / usd-scene-loaded event stream.
  async openUsdFile(): Promise<void> {
    await invoke("trigger_open_usd_dialog");
  },

  // Subscribe to the Rust load events; the page calls this in onMount and
  // unlistens everything on destroy.
  async init(hooks: LoadHooks): Promise<() => void> {
    const unlistens = await Promise.all([
      listen<string>("usd-load-error", (event) => {
        this.loadingProgress = null;
        this.openErrorModal(loadErrorMessage(event.payload));
      }),
      listen<string>("usd-load-start", (event) => {
        this.rootFile = event.payload;
        this.loadingProgress = { stage: "Starting...", percent: 0 };
        this.dependencies = null;

        hooks.resetScene();
      }),
      listen<LoadProgress>("usd-load-progress", (event) => {
        this.loadingProgress = event.payload;
      }),
      listen<StageInfo>("usd-stage-opened", (event) => {
        stageState.adoptOpenedStage(event.payload);
        // Re-query the edit target + dirty layers: the previous stage's
        // dirty set must not survive into the new open.
        void editState.refresh();
      }),
      listen<{ root_file: string; dependencies: DependencyMap }>("usd-scene-loaded", (event) => {
        void this.handleSceneLoaded(event.payload, hooks);
      }),
    ]);
    return () => {
      unlistens.forEach((unlisten) => unlisten());
    };
  },

  // The viewport scene load: compose the scene from the Rust manifest
  // (no zip, no Three.js USD parsing).
  async handleSceneLoaded(
    payload: { root_file: string; dependencies: DependencyMap },
    hooks: LoadHooks,
  ): Promise<void> {
    this.loadingProgress = null;
    this.rootFile = payload.root_file;
    this.dependencies = payload.dependencies;
    await hooks.loadScene();
  },
});

// Reactive when called inside a template/rune context: it re-runs as the
// store's manifest or filter text change.
export function filteredDependencies(): [string, DependencyInfo][] {
  return filterDependencies(loadOrchestrator.dependencies, loadOrchestrator.filterText);
}
