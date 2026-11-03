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

interface OpenSnapshot {
  rootFile: string | null;
  requestedPath: string | null;
  dependencies: DependencyMap | null;
}

interface ActiveOpen {
  snapshot: OpenSnapshot | null;
  completion: Promise<void>;
  resolve: () => void;
}

const OPEN_IN_FLIGHT_MESSAGE = "A USD file is already opening. Wait for it to finish before opening another.";
let activeOpen: ActiveOpen | null = null;
let sceneHooks: LoadHooks | null = null;

function startOpen(): ActiveOpen {
  let resolve!: () => void;
  const completion = new Promise<void>((done) => {
    resolve = done;
  });
  activeOpen = { snapshot: null, completion, resolve };
  return activeOpen;
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
  // The path the user asked to open (usd-load-start's payload — the
  // PRE-extraction path for usdz); recent files records this one.
  requestedPath: null as string | null,
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
    if (activeOpen) {
      this.openErrorModal(OPEN_IN_FLIGHT_MESSAGE);
      return;
    }
    try {
      await invoke("trigger_open_usd_dialog");
    } catch (e) {
      this.openErrorModal("Failed to open USD:\n\n" + (typeof e === "string" ? e : String(e)));
    }
  },

  // Path opens reserve the single open slot before invoking the backend,
  // so two synchronous callers cannot both get through. The promise resolves
  // only after the tab has adopted the stage (or the failure was restored).
  beginPathOpen(): Promise<void> | null {
    if (activeOpen) {
      this.openErrorModal(OPEN_IN_FLIGHT_MESSAGE);
      return null;
    }
    return startOpen().completion;
  },

  finishOpen(): void {
    const operation = activeOpen;
    activeOpen = null;
    operation?.resolve();
  },

  async failOpen(message: string): Promise<void> {
    const operation = activeOpen;
    this.loadingProgress = null;
    this.openErrorModal(message);
    try {
      if (operation?.snapshot) {
        this.rootFile = operation.snapshot.rootFile;
        this.requestedPath = operation.snapshot.requestedPath;
        this.dependencies = operation.snapshot.dependencies;
        await sceneHooks?.loadScene();
      }
    } finally {
      if (activeOpen === operation) {
        activeOpen = null;
        operation?.resolve();
      }
    }
  },

  // Subscribe to the Rust load events; the page calls this in onMount and
  // unlistens everything on destroy.
  async init(hooks: LoadHooks): Promise<() => void> {
    sceneHooks = hooks;
    const unlistens = await Promise.all([
      listen<string>("usd-load-error", (event) => {
        void this.failOpen(loadErrorMessage(event.payload));
      }),
      listen<string>("usd-load-start", (event) => {
        const operation = activeOpen ?? startOpen();
        operation.snapshot ??= {
          rootFile: this.rootFile,
          requestedPath: this.requestedPath,
          dependencies: this.dependencies,
        };
        this.rootFile = event.payload;
        this.requestedPath = event.payload;
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
    // rootFile/requestedPath stay on the user-facing path from load-start;
    // payload.root_file is the resolved layer (an extracted path for usdz).
    this.dependencies = payload.dependencies;
    await hooks.loadScene();
  },
});

// Reactive when called inside a template/rune context: it re-runs as the
// store's manifest or filter text change.
export function filteredDependencies(): [string, DependencyInfo][] {
  return filterDependencies(loadOrchestrator.dependencies, loadOrchestrator.filterText);
}
