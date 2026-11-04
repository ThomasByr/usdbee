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
  stageId: number;
  rootFile: string | null;
  dependencies: DependencyMap | null;
}

interface ActiveOpen {
  snapshot: OpenSnapshot | null;
  // The requested path from THIS open's load-start (the pre-extraction
  // path for usdz). Adoption consumes this per-operation record so a
  // mid-open tab switch cannot reroute it.
  requestedPath: string | null;
  // The root layer this open reported through usd-scene-loaded; used to
  // attribute late load events to their owning open.
  sceneRoot: string | null;
  // Whether this open's own usd-load-start already arrived.
  started: boolean;
  // Set once a second load-start is refused: that refused stream's
  // progress and load-error events are ignored (its scene-loaded and
  // stage-opened are dropped by root attribution).
  ignoringForeign: boolean;
  completion: Promise<void>;
  resolve: () => void;
}

export const OPEN_IN_FLIGHT_MESSAGE =
  "A USD file is already opening. Wait for it to finish before opening another.";
let activeOpen: ActiveOpen | null = null;
// A refused open's stream can outlive the active open (the backend keeps
// loading it): its identity is pinned here until its own terminal event,
// so its late events stay dropped and its orphan stage gets closed even
// after finishOpen/failOpen cleared the active open. The backend LoadGate
// guarantees at most one refused stream is mid-flight at a time.
let refusedOpen: { sceneRoot: string | null } | null = null;
// True while a failed open is still restoring the previous tab's scene:
// a refusal arriving now must not overwrite the real failure message.
let restoringAfterFailure = false;
let sceneHooks: LoadHooks | null = null;

function startOpen(): ActiveOpen {
  let resolve!: () => void;
  const completion = new Promise<void>((done) => {
    resolve = done;
  });
  activeOpen = {
    snapshot: null,
    requestedPath: null,
    sceneRoot: null,
    started: false,
    ignoringForeign: false,
    completion,
    resolve,
  };
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

  // The requested path pinned on the active open's load-start; tab
  // adoption consumes this per-operation value, never a shared global.
  openRequestedPath(): string | null {
    return activeOpen?.requestedPath ?? null;
  },

  // Event attribution: while an open is in flight, only events whose root
  // matches that open belong to it — a refused second open's scene-loaded
  // and stage-opened must not cross-wire the first open's state. A usdz
  // open's first scene-loaded is accepted on trust (its extracted root is
  // unknowable beforehand); the backend LoadGate keeps another stream
  // from racing that moment.
  acceptsSceneLoaded(rootFile: string): boolean {
    const operation = activeOpen;
    if (!operation) return refusedOpen === null;
    if (!operation.started) return true;
    return (
      rootFile === operation.sceneRoot ||
      rootFile === operation.requestedPath ||
      (operation.sceneRoot === null && operation.requestedPath?.toLowerCase().endsWith(".usdz") === true)
    );
  },

  acceptsStageOpened(info: StageInfo): boolean {
    const operation = activeOpen;
    if (operation?.started) return info.root_layer === operation.sceneRoot;
    // No open in flight: a pending refusal's late stage-opened must never
    // adopt — it is dropped and its orphan stage closed instead.
    return refusedOpen === null;
  },

  // Ask the backend to show the file-open dialog; the chosen path comes
  // back through the usd-load-start / usd-scene-loaded event stream.
  // Only checked, not reserved: a dialog cancellation is unobservable
  // from JS, so the universal guard lives in the usd-load-start listener
  // plus the backend's LoadGate.
  async openUsdFile(): Promise<void> {
    if (activeOpen) {
      if (!restoringAfterFailure) this.openErrorModal(OPEN_IN_FLIGHT_MESSAGE);
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
      if (!restoringAfterFailure) this.openErrorModal(OPEN_IN_FLIGHT_MESSAGE);
      return null;
    }
    return startOpen().completion;
  },

  // A backend gate refusal answering a path open: nothing was loaded, so
  // nothing is restored — release the slot and surface the readable
  // refusal, never the failure channel.
  refuseOpen(): void {
    this.openErrorModal(OPEN_IN_FLIGHT_MESSAGE);
    this.finishOpen();
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
    restoringAfterFailure = true;
    try {
      if (operation?.snapshot && operation.snapshot.stageId === stageState.activeStageId) {
        this.rootFile = operation.snapshot.rootFile;
        this.dependencies = operation.snapshot.dependencies;
        if (operation.snapshot.rootFile !== null) await sceneHooks?.loadScene();
      }
    } finally {
      restoringAfterFailure = false;
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
        // Belt-and-suspenders: the dialog wrapper already skips emitting a
        // gate refusal here; drop it anyway so it can never run the first
        // open's failure restoration.
        if (event.payload === OPEN_IN_FLIGHT_MESSAGE) return;
        if (activeOpen?.ignoringForeign) return;
        if (!activeOpen && refusedOpen) {
          // The refused stream failed backend-side; its refusal was
          // already surfaced, so drop its terminal error too.
          refusedOpen = null;
          return;
        }
        void this.failOpen(loadErrorMessage(event.payload));
      }),
      listen<string>("usd-load-start", (event) => {
        const operation = activeOpen ?? startOpen();
        if (operation.started) {
          // A second load-start (dialog/native-menu flow) while this open
          // is still in flight: refuse it, keep its identity past this
          // open's lifetime, and ignore the rest of its stream so the
          // first open completes untouched.
          refusedOpen = { sceneRoot: null };
          operation.ignoringForeign = true;
          if (!restoringAfterFailure) this.openErrorModal(OPEN_IN_FLIGHT_MESSAGE);
          return;
        }
        operation.started = true;
        operation.requestedPath = event.payload;
        operation.snapshot ??= {
          stageId: stageState.activeStageId,
          rootFile: this.rootFile,
          dependencies: this.dependencies,
        };
        this.rootFile = event.payload;
        this.loadingProgress = { stage: "Starting...", percent: 0 };
        this.dependencies = null;

        hooks.resetScene();
      }),
      listen<LoadProgress>("usd-load-progress", (event) => {
        if (activeOpen?.ignoringForeign) return;
        if (!activeOpen && refusedOpen) return;
        this.loadingProgress = event.payload;
      }),
      listen<StageInfo>("usd-stage-opened", (event) => {
        const info = event.payload;
        if (!this.acceptsStageOpened(info)) {
          // A refused open completed backend-side with no tab: close its
          // stage so it does not linger invisibly.
          refusedOpen = null;
          void invoke("close_stage", { stageId: info.stage_id }).catch(() => {});
          return;
        }
        stageState.adoptOpenedStage(info);
        // Re-query the edit target + dirty layers: the previous stage's
        // dirty set must not survive into the new open.
        void editState.refresh();
      }),
      listen<{ root_file: string; dependencies: DependencyMap }>("usd-scene-loaded", (event) => {
        const rootFile = event.payload.root_file;
        if (!this.acceptsSceneLoaded(rootFile)) {
          // A refused stream's scene-loaded: pin its root so its
          // stage-opened is dropped (and its orphan stage closed) even
          // after the active open finishes.
          if (refusedOpen) refusedOpen.sceneRoot ??= rootFile;
          return;
        }
        if (activeOpen) activeOpen.sceneRoot = rootFile;
        void this.handleSceneLoaded(event.payload);
      }),
      listen<string>("usd-load-refused", (event) => {
        // The backend refused to start a load while one was running
        // (native menu); surface it once, without touching the in-flight
        // open or a failure restore in progress.
        if (restoringAfterFailure) return;
        this.openErrorModal(event.payload);
      }),
    ]);
    return () => {
      unlistens.forEach((unlisten) => unlisten());
    };
  },

  // Scene-loaded only records the dependency scan: the viewport compose
  // happens on usd-stage-opened (tab adoption), which arrives right after
  // with the adopted stage id — composing here would race it with the
  // previous (or zero) id and fail with "no stage 0".
  async handleSceneLoaded(payload: { root_file: string; dependencies: DependencyMap }): Promise<void> {
    this.loadingProgress = null;
    // rootFile stays on the user-facing path from load-start;
    // payload.root_file is the resolved layer (an extracted path for usdz).
    this.dependencies = payload.dependencies;
  },
});

// Reactive when called inside a template/rune context: it re-runs as the
// store's manifest or filter text change.
export function filteredDependencies(): [string, DependencyInfo][] {
  return filterDependencies(loadOrchestrator.dependencies, loadOrchestrator.filterText);
}
