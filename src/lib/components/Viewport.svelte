<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import { tabsState } from "$lib/state/tabsState.svelte";
  import { stageState } from "$lib/stage/stageState.svelte";
  import {
    renderState,
    snapToTimeCodes,
    toAbsoluteTime,
    toPlayheadOffset,
  } from "$lib/render/renderState.svelte";
  import {
    clearSceneLights,
    integrateScene,
    loadRustScene,
    installPlaybackDriver,
    refreshSceneAfterEdit,
    resetLoadedScene,
    sceneLightsActive,
    syncGraphicsSettings,
    syncLightRig,
    syncSceneLights,
  } from "$lib/render/sceneIntegration";
  import {
    disposeGizmo,
    gateCommitStageRefresh,
    getGizmoError,
    getGizmoGate,
    initGizmo,
  } from "$lib/render/gizmoCommit.svelte";
  import type { GizmoMode } from "$lib/render/xformOps";
  import type { RendererKit } from "$lib/three/RendererKit.svelte";
  import { controlsState } from "$lib/state/controlsState.svelte";
  import { viewerSettings } from "$lib/state/viewerSettings.svelte";
  import { consumeLaunchOptions } from "$lib/commands/launch";
  import { setBridgeViewer } from "$lib/commands/viewerRef";
  import { formatTimeline, formatTimelineEnd, playbackState } from "$lib/state/playbackState.svelte";
  import * as THREE from "three";
  import Toolbar from "./Toolbar.svelte";

  // The page owns the RendererKit instance and the sidebar-facing bindings
  // (SettingsTab / RenderingTab / ExportModal read it); the viewport wires
  // the canvas, the gizmo and the scene pipeline onto it.
  let {
    viewer,
    lightAzimuth,
    lightElevation,
    gizmoMode = $bindable(),
  }: {
    viewer: RendererKit;
    lightAzimuth: number;
    lightElevation: number;
    gizmoMode: GizmoMode;
  } = $props();

  let canvas: HTMLCanvasElement;

  const gizmoGate = $derived(getGizmoGate());
  const gizmoMessage = $derived(getGizmoError() ?? gizmoGate.message);

  // Review fix (playhead units): the timeline works in 0..(end-start)
  // offsets; this is the boundary to the absolute USD time codes that
  // setStageTime speaks. (The page keeps its own copy for export ranges.)
  function startTimeCode(): number {
    return stageState.stageInfo?.start_time_code ?? 0;
  }

  // The backend reports 24 when a stage has no authored rate.
  const timeCodesPerSecond = $derived(stageState.stageInfo?.time_codes_per_second ?? 0);

  // Fixed-width label: padding the current text to the end text's length
  // (monospace font) keeps the timeline bar from hopping when the frame
  // count changes digit count mid-playback.
  const timelineEnd = $derived(
    formatTimelineEnd(
      viewer.animationDuration,
      startTimeCode(),
      timeCodesPerSecond,
      playbackState.timelineUnits,
    ),
  );
  const timelineCurrent = $derived(
    formatTimeline(
      viewer.animationProgress + startTimeCode(),
      timeCodesPerSecond,
      playbackState.timelineUnits,
    ).padStart(timelineEnd.length),
  );

  $effect(() => {
    if (viewer.scene) viewer.scene.background = new THREE.Color(viewer.backgroundColor);
  });

  $effect(() => {
    if (viewer.gridHelper) viewer.gridHelper.visible = viewer.showGrid;
  });

  $effect(() => {
    if (viewer.boxHelper) viewer.boxHelper.visible = viewer.showBoundingBox;
  });

  // The bar mirrors the stage time, not just the playback driver's ticks: a
  // palette, CLI or MCP set_time writes the time without ticking the driver,
  // and the slider and readout stayed put. The driver still owns the
  // continuous value between writes, so a held pose keeps the bar moving.
  $effect(() => {
    const time = renderState.time;
    if (time !== null) viewer.animationProgress = toPlayheadOffset(time, startTimeCode());
  });

  // The graphics-sync bodies live in sceneIntegration.ts; the reads inside
  // them are still tracked because they run synchronously within these
  // effects.
  $effect(() => {
    syncGraphicsSettings(viewer);
  });

  // F4: the lighting source picks between the studio rig and the stage's own
  // lights. Every read here is tracked, so a settings change (or a new light
  // fetch) re-lights the viewport without reopening the stage.
  $effect(() => {
    if (sceneLightsActive(viewerSettings.lightingSource, viewer.stageLights)) {
      syncSceneLights(viewer, viewer.stageLights, viewerSettings);
    } else {
      clearSceneLights(viewer);
      syncLightRig(viewer, lightAzimuth, lightElevation);
    }
  });

  $effect(() => {
    if (viewer.loadedGroup) {
      viewer.loadedGroup.traverse((obj: any) => {
        if (obj.isMesh && obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m: any) => (m.wireframe = viewer.showWireframe));
        }
      });
    }
  });

  $effect(() => {
    const mLeft = controlsState.mouseButtonLeft;
    const mMiddle = controlsState.mouseButtonMiddle;
    const mRight = controlsState.mouseButtonRight;
    const speed = controlsState.rotSpeedFactor;

    if (viewer.controls) {
      const MOUSE_MAPPING: Record<string, number> = {
        rotate: THREE.MOUSE.ROTATE,
        pan: THREE.MOUSE.PAN,
        zoom: THREE.MOUSE.DOLLY,
      };
      viewer.controls.rotateSpeed = speed;
      viewer.controls.mouseButtons = {
        LEFT: MOUSE_MAPPING[mLeft] || THREE.MOUSE.ROTATE,
        MIDDLE: MOUSE_MAPPING[mMiddle] || THREE.MOUSE.DOLLY,
        RIGHT: MOUSE_MAPPING[mRight] || THREE.MOUSE.PAN,
      };
    }
  });

  $effect(() => {
    if (viewer.camera && viewer.fov) {
      if (viewer.camera.fov !== viewer.fov) {
        viewer.camera.fov = viewer.fov;
        viewer.camera.updateProjectionMatrix();
      }
    }
  });

  onMount(() => {
    const savedFov = localStorage.getItem("cameraFov");
    if (savedFov) {
      viewer.fov = parseFloat(savedFov);
    }

    const savedDamping = localStorage.getItem("cameraDamping");
    if (savedDamping !== null) {
      viewer.enableDamping = savedDamping === "true";
    }

    if (canvas) {
      viewer.init(canvas);
      initGizmo(viewer, () => gizmoMode);
    }

    installPlaybackDriver(viewer);

    // The palette runs the same commands the dev bridge does and has no
    // viewer of its own: publish the live one for the whole mount.
    setBridgeViewer(viewer);

    // CLI files open as tabs and the camera options pin the view; it waits
    // for the viewer above and runs at most once per app start.
    void consumeLaunchOptions();

    // Dev-only MCP bridge. The dynamic import sits behind the same DEV flag
    // the bridge's own gate uses, so a release bundle carries neither.
    let stopBridge: (() => void) | null = null;
    let stopKeepAlive: (() => void) | null = null;
    // The imports land in a promise: an unmount before that must not leave an
    // interval (or a socket) with nothing left to stop it.
    let disposed = false;
    if (import.meta.env.DEV) {
      void import("$lib/dev/mcpBridge.svelte").then((bridge) => {
        if (disposed) return;
        stopBridge = bridge.startMcpBridge(viewer);
      });
      // Idle only: playback and loads invoke on their own schedule, which is
      // what the ping exists to imitate. A scrub is a schedule of its own: one
      // pose step per drag step, so the transport is not quiet between them.
      void import("$lib/dev/transportKeepAlive").then((keepAlive) => {
        if (disposed) return;
        stopKeepAlive = keepAlive.startTransportKeepAlive({
          isIdle: () =>
            !viewer.isPlayingAnim && renderState.status !== "loading" && !renderState.isTimeStepInFlight,
        });
      });
    }

    // Loading orchestration lives in loadOrchestrator; the viewport-bound
    // steps it can't own are handed back through the sceneIntegration
    // step functions.
    const unlisteners = [
      loadOrchestrator.init({
        resetScene: () => resetLoadedScene(viewer),
        loadScene: () => loadRustScene(viewer),
      }),
      // Stage tabs (Task 11): switching tabs composes the active stage's
      // scene through the same viewport-bound steps; closing the last tab
      // resets to the empty view.
      tabsState.init({
        resetScene: () => resetLoadedScene(viewer),
        // A pin belongs to the tab that set it: a scene composed for a tab
        // enter starts unpinned, then applyCamera restores that tab's view.
        loadScene: () => {
          viewer.pinnedCamera = null;
          return loadRustScene(viewer);
        },
        readCamera: () => {
          if (!viewer.camera || !viewer.controls) return null;
          return {
            position: viewer.camera.position.toArray() as [number, number, number],
            target: viewer.controls.target.toArray() as [number, number, number],
            fov: viewer.fov,
          };
        },
        // A stored view wins over the automatic framing.
        applyCamera: (view) => {
          if (!view) return;
          viewer.camera.position.fromArray(view.position);
          viewer.controls.target.fromArray(view.target);
          viewer.fov = view.fov;
          viewer.camera.fov = view.fov;
          viewer.camera.updateProjectionMatrix();
          viewer.controls.update();
        },
      }),
      listen("usd-stage-changed", (event) => {
        const payload = event.payload as { stage_id?: number; paths?: string[] } | null;
        if (payload?.stage_id !== stageState.activeStageId) return;
        const paths = (payload?.paths ?? []) as string[];
        // A gizmo commit authors its ops in one transaction, so ONE event
        // arrives per commit. The gate still matters: an ungated refresh
        // mid-commit can rebuild the scene from under the dragged node. The
        // commit refreshes once, when its write is done.
        if (gateCommitStageRefresh(paths)) return;
        void refreshSceneAfterEdit(viewer, paths);
      }),
    ];

    return () => {
      disposed = true;
      setBridgeViewer(null);
      stopBridge?.();
      stopKeepAlive?.();
      unlisteners.forEach((u) => u.then((f) => f()));
      disposeGizmo();
      viewer.dispose();
    };
  });
</script>

<section class="viewport">
  <Toolbar
    {viewer}
    bind:gizmoMode
    {gizmoMessage}
    attachable={gizmoGate.attachable}
    disabled={!loadOrchestrator.rootFile}
  />

  <canvas bind:this={canvas} class="webgl-canvas" class:visible={!!loadOrchestrator.rootFile}></canvas>

  {#if viewer.hasAnimation}
    <div class="timeline-overlay">
      <button
        class="icon-btn"
        style="color: var(--overlay-text)"
        onclick={() => (viewer.isPlayingAnim = !viewer.isPlayingAnim)}
        title={viewer.isPlayingAnim ? "Pause" : "Play"}
      >
        <!-- Drawn rather than typed: the ▶/⏸ glyphs differ in both advance
             width and inner weight, so the bar moved and the pause bars
             looked undersized next to the triangle. -->
        {#if viewer.isPlayingAnim}
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="3" y="2" width="3.5" height="12" fill="currentColor" />
            <rect x="9.5" y="2" width="3.5" height="12" fill="currentColor" />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 2 L13.5 8 L4 14 Z" fill="currentColor" />
          </svg>
        {/if}
      </button>
      <input
        type="range"
        class="timeline-slider slider"
        min="0"
        max={viewer.animationDuration}
        step="0.01"
        value={viewer.animationProgress}
        oninput={(e) => {
          viewer.animationProgress = parseFloat(e.currentTarget.value);
          void renderState.setStageTime(
            snapToTimeCodes(toAbsoluteTime(viewer.animationProgress, startTimeCode()), renderState.timeCodes),
          );
          if (viewer.showBoundingBox && viewer.loadedGroup)
            viewer.sceneBox.setFromObject(viewer.loadedGroup, true);
          viewer.refreshSelectionBox();
        }}
        onmousedown={() => (viewer.isDraggingAnim = true)}
        onmouseup={() => (viewer.isDraggingAnim = false)}
      />
      <span class="timeline-time" title={`${timeCodesPerSecond} fps`}>{timelineCurrent} / {timelineEnd}</span>
    </div>
  {/if}

  {#if !loadOrchestrator.rootFile}
    <div class="empty-state">
      <p>No USD scene loaded.</p>
      <p class="subtitle">Use File > Open USD... or the button to begin.</p>
    </div>
  {:else if loadOrchestrator.loadingProgress}
    <div class="loading-overlay">
      <h3>{loadOrchestrator.loadingProgress.stage}...</h3>
    </div>
  {/if}
</section>

<style>
  .viewport {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    position: relative;
    overflow: hidden;
  }

  .webgl-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100% !important;
    height: 100% !important;
    display: none;
    z-index: 1;
  }

  .webgl-canvas.visible {
    display: block;
  }

  .timeline-overlay {
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--overlay-strong);
    padding: 10px 20px;
    border-radius: 8px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 60%;
    min-width: 300px;
    backdrop-filter: blur(4px);
    border: 1px solid var(--border);
  }

  /* ▶ and ⏸ do not share an advance width or an inner weight, so the bar
     resized on play/pause and the pause bars read as too small. The icons are
     now inline SVG; this keeps the button box fixed either way. */
  .timeline-overlay .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    margin: 0;
    padding: 0;
    flex: none;
  }

  .timeline-slider {
    flex: 1;
  }

  .timeline-time {
    color: var(--overlay-accent);
    font-family: monospace;
    font-size: 12px;
    min-width: 125px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    /* The label is padded with leading spaces to the end label's width;
       default whitespace processing eats them, so the span resizes as the
       digits change. pre keeps the padding literal. */
    white-space: pre;
  }

  .empty-state {
    text-align: center;
    color: var(--text-faint);
    z-index: 2;
  }

  .loading-overlay {
    position: absolute;
    bottom: 20px;
    right: 20px;
    background: var(--overlay-strong);
    padding: 10px 20px;
    border-radius: 6px;
    z-index: 2;
    color: var(--overlay-accent);
  }

  .empty-state p {
    margin: 4px 0;
  }

  .empty-state .subtitle {
    font-size: 13px;
    color: var(--text-muted);
  }
</style>
