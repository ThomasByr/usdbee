<script lang="ts">
  import "../lib/styles/tokens.css";
  import "./page.css";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
  import { onMount, tick, untrack } from "svelte";
  import ErrorModal from "$lib/components/ErrorModal.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import FilesTab from "$lib/components/tabs/FilesTab.svelte";
  import HierarchyTab from "$lib/components/tabs/HierarchyTab.svelte";
  import RenderingTab from "$lib/components/tabs/RenderingTab.svelte";
  import LayerTextTab from "$lib/components/tabs/LayerTextTab.svelte";
  import SettingsTab from "$lib/components/tabs/SettingsTab.svelte";
  import ExportModal from "$lib/components/ExportModal.svelte";
  import Modal from "$lib/components/Modal.svelte";
  import SaveDialog from "$lib/components/SaveDialog.svelte";
  import { runExport } from "$lib/three/VideoExporter";
  import {
    viewerSettings,
    loadGraphicsPreferences,
    saveGraphicsPreferences,
  } from "$lib/state/viewerSettings.svelte";
  import {
    controlsState,
    loadControlPreferences,
    saveControlPreferences,
  } from "$lib/state/controlsState.svelte";
  import { stageState } from "$lib/stage/stageState.svelte";
  import { tabsState } from "$lib/state/tabsState.svelte";
  import { initDragDrop } from "$lib/dnd/dragDrop";
  import { editState } from "$lib/state/editState.svelte";
  import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import { initTheme } from "$lib/state/themeState.svelte";
  import { loadPlaybackState } from "$lib/state/playbackState.svelte";
  import { windowCloseConfirmNeeded } from "$lib/state/closeGuard";
  import type { StageSummary } from "$lib/stage/types";
  import { layerTextState } from "$lib/state/layerTextState.svelte";
  import { renderState, toAbsoluteTime } from "$lib/render/renderState.svelte";
  import type { GizmoMode } from "$lib/render/xformOps";
  import { stageModalContent } from "$lib/stage/modalErrors";
  import Viewport from "$lib/components/Viewport.svelte";
  import { clearCameraNotice } from "$lib/state/cameraNotice.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import AboutModal from "$lib/components/AboutModal.svelte";
  import { updateState, checkForUpdates, startupAutoCheck } from "$lib/state/updateState.svelte";
  import { paletteState } from "$lib/state/commandPaletteState.svelte";
  import { dispatchCommand } from "$lib/commands/dispatch";
  import { matchesBinding } from "$lib/utils/keys";
  import { RendererKit } from "$lib/three/RendererKit.svelte";

  // State
  let viewer = new RendererKit();
  let activeTab = $state<"files" | "scene" | "rendering" | "settings" | "layers">("files");

  // Rendering Controls
  let hasShownWindow = false;

  // Light Positioning State (bound into RenderingTab, fed to the Viewport)
  let lightAzimuth = $state<number>(45); // Degrees (-180 to 180)
  let lightElevation = $state<number>(45); // Degrees (0 to 90)

  // The viewport's empty state links here: switching tabs only mounts the
  // panel, so the scroll waits for the DOM update.
  async function openSettingsAtRecent(): Promise<void> {
    activeTab = "settings";
    await tick();
    document.getElementById("recent-files")?.scrollIntoView({ block: "start" });
  }

  // The rendering tab's camera picker runs the palette's own two commands.
  function pickRenderingCamera(path: string | null) {
    return dispatchCommand(
      viewer,
      path === null ? "release_camera" : "look_through_camera",
      path === null ? {} : { path },
      { guarded: true },
    );
  }

  // The active gizmo mode: the Viewport/Toolbar toggle it, the keyboard
  // shortcuts below write it. Owned here so the shortcuts stay page glue.
  let gizmoMode = $state<GizmoMode>("translate");

  // Sidebar resize state
  let sidebarWidth = $state<number>(320);
  let isResizing = $state<boolean>(false);
  let stageModal = $state<{ notices: string[]; errors: string[] } | null>(null);
  let stageModalDismissed = $state<boolean>(false);
  let showExportModal = $state<boolean>(false);
  let showAboutModal = $state<boolean>(false);
  // Which size the About dialog opens at: the compact one carries the version
  // and the update section only.
  let aboutFull = $state<boolean>(false);
  // The export modal previews frames by stepping the stage time, so the
  // playhead moves as soon as it opens. Snapshot on open, restore on close.
  let exportView = $state<{ progress: number; playing: boolean } | null>(null);
  let showSaveModal = $state<boolean>(false);
  // Task 5: the OS close request is intercepted while any layer carries
  // unsaved edits; the modal's confirm is the only path that destroys the
  // window.
  let showCloseConfirm = $state<boolean>(false);
  // Task 11: the guard aggregates every open stage; these hold the totals
  // the confirm modal shows.
  let closeConfirmDirty = $state<number>(0);
  let closeConfirmDraft = $state<boolean>(false);
  let isExporting = $state<boolean>(false);
  let exportProgress = $state<number>(0);
  let exportStage = $state<string>("Exporting...");

  // Keybindings State

  let omniverseUrl = $state<string>("http://localhost:34080");

  async function updateOmniverseUrl() {
    try {
      await invoke("set_omniverse_url", { url: omniverseUrl });
    } catch (e) {
      console.error("Failed to save Omniverse URL:", e);
    }
  }

  function closeStageModal() {
    stageModalDismissed = true;
  }

  // Review fix (playhead units): the UI layer — timeline slider, progress
  // display, ExportModal range inputs — works in 0..(end-start) offsets.
  // These two helpers are the ONLY boundary back to the absolute USD time
  // codes that setStageTime speaks, applied wherever the UI steps the
  // stage (slider, playback, preview, export frames).
  function startTimeCode(): number {
    return stageState.stageInfo?.start_time_code ?? 0;
  }

  // The open snapshot survives the modal's own preview steps: the close
  // handler is the only place that puts the playhead and the freeze back.
  function openExport() {
    if (showExportModal) return;
    exportView = { progress: viewer.animationProgress, playing: viewer.isPlayingAnim };
    viewer.frozenProgress = exportView.progress;
    showExportModal = true;
  }

  async function closeExport() {
    const view = exportView;
    // Clearing first makes a second call (export complete, then the modal's
    // own close) a no-op instead of a restore of a stale playhead.
    exportView = null;
    showExportModal = false;
    viewer.frozenProgress = null;
    if (!view) return;
    viewer.animationProgress = view.progress;
    viewer.isPlayingAnim = view.playing;
    // Same absolute-time step the modal's preview and the exporter use.
    await renderState.setStageTime(toAbsoluteTime(view.progress, startTimeCode()));
  }

  async function handleExport(detail: any) {
    console.log("handleExport called with", detail);

    isExporting = true;
    exportProgress = 0;
    exportStage = "Exporting...";

    try {
      await runExport(
        {
          renderer: viewer.renderer,
          scene: viewer.scene!,
          camera: viewer.camera,
          animationDuration: viewer.animationDuration,
          animationProgress: viewer.animationProgress,
          // Task 6: the exporter steps USD time codes — the rate is
          // time_codes_per_second and each frame re-fetches animated geometry
          // through setStageTime.
          playbackRate: stageState.stageInfo?.time_codes_per_second ?? 24,
          onBeforeFrame: (t: number) => renderState.setStageTime(toAbsoluteTime(t, startTimeCode())),
        },
        detail,
        {
          onProgress: (stage, percent) => {
            exportStage = stage;
            exportProgress = percent;
            if (
              stage.includes("Video") ||
              stage.includes("Frames") ||
              stage.includes("Encoding") ||
              stage.includes("Saving")
            ) {
              loadOrchestrator.loadingProgress = { stage, percent };
            }
          },
          onComplete: () => {
            isExporting = false;
            loadOrchestrator.loadingProgress = null;
          },
          onError: (msg) => {
            loadOrchestrator.openErrorModal(msg);
            isExporting = false;
            loadOrchestrator.loadingProgress = null;
          },
        },
      );
    } finally {
      // Success, error and throw all leave through the same restore.
      isExporting = false;
      void closeExport();
    }
  }

  // Stage messages own their modal state (stageModal/stageModalDismissed) so
  // they never read or overwrite modalError — rendering errors (usd-load-error,
  // Three.js catch, export, dependency errors) keep exclusive ownership of it.
  let prevStageModalKey: string | null = null;
  $effect(() => {
    const stageContent = stageModalContent({
      status: stageState.status,
      error: stageState.error,
      compositionErrors: stageState.stageInfo?.composition_errors ?? [],
      compositionNotices: stageState.stageInfo?.composition_notices ?? [],
    });
    const changed = JSON.stringify(stageContent) !== prevStageModalKey;
    prevStageModalKey = JSON.stringify(stageContent);
    stageModal = stageContent;
    if (changed && stageContent) stageModalDismissed = false;
  });

  $effect(() => {
    viewer.showExportModal = showExportModal;
  });

  // Pause catch-up for the suppressed per-step inspector refresh (see
  // onStageTimeChanged): one refresh when playback stops. untrack keeps
  // the effect keyed to the play/pause flag alone.
  $effect(() => {
    if (viewer.isPlayingAnim) return;
    untrack(() => stageState.onPlaybackPaused());
  });

  // The startup auto-check is silent and no dialog is open when it runs, so a
  // hit would otherwise stay invisible. Opening About is its only notice; a
  // silent failure leaves the status at "idle" and opens nothing.
  $effect(() => {
    if (updateState.status === "available") {
      aboutFull = false;
      showAboutModal = true;
    }
  });

  // A stage switch replaces the cameras, so a card naming the old one would
  // outlive its stage for the rest of the fade.
  $effect(() => {
    void stageState.activeStageId;
    clearCameraNotice();
  });

  onMount(() => {
    // Open the confirm-per-save dialog: only its confirm button ever writes
    // USD content to disk. The dialog refreshes the dirty-layer list on open.
    async function openSaveDialog() {
      if (!stageState.stageInfo) return;
      showSaveModal = true;
      await editState.refresh();
    }

    // Global keyboard shortcuts
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      // The palette owns the keyboard while it is open: the camera, gizmo and
      // file shortcuts must stay inert behind the overlay.
      if (paletteState.open) return;
      // A bare-key palette binding must not fire while a text field has focus;
      // Ctrl/Cmd combos stay live so mod+p opens the palette mid-typing.
      if (
        (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") &&
        !e.ctrlKey &&
        !e.metaKey
      )
        return;
      if (matchesBinding(e, controlsState.keybindings.commandPalette)) {
        e.preventDefault();
        paletteState.openPalette();
        return;
      }
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA")
        return;
      viewer.keysPressed.add(e.key.toLowerCase());
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void loadOrchestrator.openUsdFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void openSaveDialog();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        openExport();
      }
      // Task 5: undo/redo. Ctrl+Z undoes; Ctrl+Shift+Z / Ctrl+Y redoes.
      // The INPUT/TEXTAREA guard above keeps text-field edits intact.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void editState.undo();
      }
      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")
      ) {
        e.preventDefault();
        void editState.redo();
      }
      // Configurable gizmo mode shortcuts (Settings > Keyboard; defaults 1/2/3).
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const key = e.key.toLowerCase();
        const kb = controlsState.keybindings;
        if (key === kb.nextFrame || key === kb.previousFrame) {
          // Arrows would scroll the page; the dispatcher owns pause and clamping.
          e.preventDefault();
          void dispatchCommand(viewer, key === kb.nextFrame ? "next_frame" : "previous_frame", {}).catch(
            () => {},
          );
          return;
        }
        if (key === kb.playPause) viewer.isPlayingAnim = !viewer.isPlayingAnim;
        else if (key === kb.gizmoTranslate) gizmoMode = "translate";
        else if (key === kb.gizmoRotate) gizmoMode = "rotate";
        else if (key === kb.gizmoScale) gizmoMode = "scale";
        // The dispatcher raises the notice; a second call here would show it twice.
        else if (key === kb.cycleCamera) void dispatchCommand(viewer, "cycle_camera", {}).catch(() => {});
      }
    };
    const handleGlobalKeyup = (e: KeyboardEvent) => {
      viewer.keysPressed.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("keyup", handleGlobalKeyup);

    // Initialize backend config
    invoke<string>("get_omniverse_url")
      .then((url) => {
        if (url) omniverseUrl = url;
      })
      .catch(console.warn);

    loadControlPreferences();
    loadGraphicsPreferences();
    loadPlaybackState();
    const stopThemeListener = initTheme();
    const savedWidth = localStorage.getItem("sidebarWidth");
    if (savedWidth) {
      let parsed = parseInt(savedWidth);
      if (!isNaN(parsed) && parsed >= 150) {
        sidebarWidth = parsed;
      }
    }

    renderState.onTimeChange = () => {
      // Playback perf: suppress the ~205 ms inspector refresh while the
      // playhead auto-advances; the pause effect below catches up once.
      stageState.onStageTimeChanged(viewer.isPlayingAnim);
    };

    // Listeners for Rust events
    const unlisteners = [
      listen<{ check: boolean; full: boolean }>("open-about", (event) => {
        aboutFull = event.payload?.full === true;
        showAboutModal = true;
        if (event.payload?.check) void checkForUpdates();
      }),
      listen("open-export-modal", () => {
        console.log("RECEIVED open-export-modal from Rust!");
        openExport();
      }),
      listen("open-save-dialog", () => {
        void openSaveDialog();
      }),
      // The scene-side of usd-stage-changed moves with the Viewport; the
      // page keeps the selected-prim details refresh for the inspector.
      listen("usd-stage-changed", (event) => {
        const payload = event.payload as { stage_id?: number } | null;
        if (payload?.stage_id !== stageState.activeStageId) return;
        void stageState.refreshAfterEdit();
      }),
    ];

    // Editing state: subscribes to usd-stage-changed (dirty-layer and
    // undo-state refresh) and primes the edit-target/dirty-layer snapshot.
    unlisteners.push(editState.init());

    // Task 12: dropped USD files open as stages (mixed or non-USD drops
    // surface the shared error modal and open nothing).
    unlisteners.push(
      initDragDrop(
        (path) => tabsState.openTab(path),
        (msg) => loadOrchestrator.openErrorModal(msg),
      ),
    );

    // Task 11: the guard aggregates dirt across ALL open stages
    // (list_stages dirty counts) plus the active stage's unapplied text
    // draft — not just the active tab. preventDefault must run
    // synchronously, so the clean path destroys the window explicitly
    // once the check resolves; the decision logic is pure code in
    // closeGuard.ts (Vitest-pinned).
    unlisteners.push(
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        void (async () => {
          const summaries = (await invoke<StageSummary[]>("list_stages").catch(() => null)) ?? [
            {
              stage_id: stageState.activeStageId,
              root_identifier: "",
              dirty_count: editState.dirtyLayers.length,
            },
          ];
          if (windowCloseConfirmNeeded(summaries, layerTextState.draftDirty)) {
            closeConfirmDirty = summaries.reduce((total, s) => total + s.dirty_count, 0);
            closeConfirmDraft = layerTextState.draftDirty;
            showCloseConfirm = true;
          } else {
            // destroy() bypasses the close-time window-state save.
            await saveWindowState(StateFlags.ALL).catch(console.warn);
            getCurrentWindow().destroy().catch(console.warn);
          }
        })();
      }),
    );

    // Register first, then tell Rust the page is ready: a menu click that lands
    // in between is held in Rust and flushed by this call.
    void Promise.allSettled(unlisteners)
      .then(() => invoke("frontend_ready"))
      .catch(console.warn);

    // Silent startup check, gated on the persisted preference and delayed past
    // the first stage load.
    void startupAutoCheck();

    // Cleanup listeners
    return () => {
      stopThemeListener();
      window.removeEventListener("keydown", handleGlobalKeydown);
      window.removeEventListener("keyup", handleGlobalKeyup);
      unlisteners.forEach((u) => u.then((f) => f()));
      renderState.onTimeChange = null;
    };
  });

  // Sidebar drag logic
  function startResize(e: MouseEvent) {
    isResizing = true;
    document.body.style.cursor = "col-resize";

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing) return;
      sidebarWidth = clampSidebarWidth(moveEvent.clientX);
    };

    const onMouseUp = () => {
      isResizing = false;
      document.body.style.cursor = "";
      localStorage.setItem("sidebarWidth", sidebarWidth.toString());
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Trigger resize for Three.js
      window.dispatchEvent(new Event("resize"));
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // Keyboard equivalent of the drag (Phase 1 review flag): the separator is
  // focusable, arrow keys nudge the width and persist like a drag release.
  const SIDEBAR_STEP = 16;

  function clampSidebarWidth(width: number): number {
    const maxAllowed = window.innerWidth > 0 ? window.innerWidth - 100 : 3000;
    return Math.min(Math.max(width, 150), maxAllowed);
  }

  function resizeByKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    sidebarWidth = clampSidebarWidth(sidebarWidth + (e.key === "ArrowLeft" ? -SIDEBAR_STEP : SIDEBAR_STEP));
    localStorage.setItem("sidebarWidth", sidebarWidth.toString());
    window.dispatchEvent(new Event("resize"));
  }
</script>

<div class="app-shell">
  <TabBar />
  <main class="app-layout" class:resizing={isResizing}>
    <!-- Sidebar for Dependency Tree -->
    <aside class="sidebar" style="width: {sidebarWidth}px;">
      <div class="sidebar-header">
        <h2>
          USDA / Asset Graph
          {#if editState.dirtyLayers.length > 0}
            <span
              class="dirty-dot"
              title="{editState.dirtyLayers.length} layer(s) with unsaved changes — Ctrl+S to save"
            ></span>
          {/if}
        </h2>
        <div class="header-actions">
          <button
            class="primary-btn"
            onclick={() => void loadOrchestrator.openUsdFile()}
            title="Open USD File"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            Open
          </button>
          <button
            class="primary-btn"
            onclick={openExport}
            disabled={loadOrchestrator.loadingProgress !== null || loadOrchestrator.rootFile === null}
            title="Export Scene"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Export
          </button>
        </div>
      </div>

      <div class="tab-bar">
        <button class="tab-btn" class:active={activeTab === "files"} onclick={() => (activeTab = "files")}
          >Files</button
        >
        <button class="tab-btn" class:active={activeTab === "scene"} onclick={() => (activeTab = "scene")}
          >Hierarchy</button
        >
        <button
          class="tab-btn"
          class:active={activeTab === "rendering"}
          onclick={() => (activeTab = "rendering")}>Rendering</button
        >
        <button class="tab-btn" class:active={activeTab === "layers"} onclick={() => (activeTab = "layers")}
          >Layer Text</button
        >
        <button
          class="tab-btn"
          class:active={activeTab === "settings"}
          onclick={() => (activeTab = "settings")}>Settings</button
        >
      </div>

      {#if loadOrchestrator.loadingProgress}
        <div class="progress-box">
          <p>{loadOrchestrator.loadingProgress.stage}</p>
          <div class="progress-bar">
            <div class="progress-fill" style="width: {loadOrchestrator.loadingProgress.percent}%"></div>
          </div>
        </div>
      {/if}

      <div class="dependency-tree">
        {#if activeTab === "files"}
          <FilesTab {viewer} />
        {/if}
        {#if activeTab === "scene"}
          <HierarchyTab {viewer} />
        {/if}

        {#if activeTab === "rendering"}
          <RenderingTab
            bind:maxFps={viewerSettings.maxFps}
            bind:renderScale={viewerSettings.renderScale}
            {saveGraphicsPreferences}
            bind:toneMapping={viewerSettings.toneMapping}
            bind:toneExposure={viewerSettings.toneExposure}
            bind:ambientIntensity={viewerSettings.ambientIntensity}
            bind:dirIntensity={viewerSettings.dirIntensity}
            bind:shadowsEnabled={viewerSettings.shadowsEnabled}
            bind:shadowMapSize={viewerSettings.shadowMapSize}
            bind:shadowMapType={viewerSettings.shadowMapType}
            bind:anisotropy={viewerSettings.anisotropy}
            bind:envMapIntensity={viewerSettings.envMapIntensity}
            bind:backgroundColor={viewer.backgroundColor}
            bind:lightAzimuth
            bind:lightElevation
            bind:lightingSource={viewerSettings.lightingSource}
            bind:sceneLightScale={viewerSettings.sceneLightScale}
            cameras={viewer.stageCameras}
            activeCameraPath={viewer.pinnedCamera ? viewer.pinnedCameraPath : null}
            pickCamera={pickRenderingCamera}
          />
        {/if}
        {#if activeTab === "layers"}
          <LayerTextTab />
        {/if}
        {#if activeTab === "settings"}
          <SettingsTab
            bind:showWireframe={viewer.showWireframe}
            bind:showGrid={viewer.showGrid}
            bind:showBoundingBox={viewer.showBoundingBox}
            bind:moveSpeedFactor={controlsState.moveSpeedFactor}
            bind:rotSpeedFactor={controlsState.rotSpeedFactor}
            bind:invertMouseX={controlsState.invertMouseX}
            bind:invertMouseY={controlsState.invertMouseY}
            bind:mouseButtonLeft={controlsState.mouseButtonLeft}
            bind:mouseButtonMiddle={controlsState.mouseButtonMiddle}
            bind:mouseButtonRight={controlsState.mouseButtonRight}
            bind:keybindings={controlsState.keybindings}
            bind:activeCameraIndex={viewer.activeCameraIndex}
            bind:omniverseUrl
            usdCameras={viewer.usdCameras}
            hasAnimation={viewer.hasAnimation}
            triangleCount={viewer.triangleCount}
            {saveControlPreferences}
            keysPressed={viewer.keysPressed}
            {updateOmniverseUrl}
          />
        {/if}
      </div>
    </aside>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="resize-handle"
      onmousedown={startResize}
      onkeydown={resizeByKey}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabindex="0"
    ></div>

    <!-- Main View for 3D Render Surface -->
    <Viewport
      {viewer}
      bind:gizmoMode
      {lightAzimuth}
      {lightElevation}
      onOpenSettings={() => void openSettingsAtRecent()}
    />
  </main>
</div>

{#if loadOrchestrator.modalError}
  <ErrorModal error={loadOrchestrator.modalError} onClose={loadOrchestrator.closeErrorModal} />
{:else if stageModal !== null && !stageModalDismissed}
  <ErrorModal notices={stageModal.notices} lines={stageModal.errors} onClose={closeStageModal} />
{/if}

{#if showSaveModal}
  <SaveDialog onClose={() => (showSaveModal = false)} />
{/if}

{#if showExportModal}
  <ExportModal
    onClose={() => !isExporting && void closeExport()}
    renderer={viewer.renderer}
    scene={viewer.scene}
    camera={viewer.camera}
    hasAnimation={viewer.hasAnimation}
    animationDuration={viewer.animationDuration}
    animationProgress={viewer.animationProgress}
    previewAt={(t: number) => renderState.setStageTime(toAbsoluteTime(t, startTimeCode()))}
    {isExporting}
    {exportProgress}
    {exportStage}
    onExport={handleExport}
  />
{/if}

{#if showAboutModal}
  <AboutModal full={aboutFull} onClose={() => (showAboutModal = false)} />
{/if}

{#if showCloseConfirm}
  <Modal
    title="Unsaved changes"
    contentClass="close-confirm-box"
    closeOnBackdrop={false}
    onClose={() => (showCloseConfirm = false)}
  >
    <p>
      {closeConfirmDirty} layer(s) with unsaved edits across open stages{closeConfirmDraft
        ? " and an unapplied text draft"
        : ""}. Quit anyway and lose them?
    </p>
    <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
      <button class="tool-btn" onclick={() => (showCloseConfirm = false)}>Cancel</button>
      <button
        class="primary-btn"
        style="background: var(--danger-solid);"
        onclick={() => {
          showCloseConfirm = false;
          void saveWindowState(StateFlags.ALL)
            .catch(console.warn)
            .finally(() => getCurrentWindow().destroy().catch(console.warn));
        }}>Close anyway</button
      >
    </div>
  </Modal>
{/if}

<CommandPalette />
