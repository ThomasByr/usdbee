<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import { stageState } from "$lib/stage/stageState.svelte";
  import {
    renderState,
    advanceStageTime,
    toAbsoluteTime,
    toPlayheadOffset,
  } from "$lib/render/renderState.svelte";
  import {
    integrateScene,
    loadRustScene,
    refreshSceneAfterEdit,
    resetLoadedScene,
    syncGraphicsSettings,
    syncLightRig,
  } from "$lib/render/sceneIntegration";
  import { TransformGizmo, type GizmoCommit } from "$lib/render/transformGizmo";
  import { composeOpUpdate, evaluateGizmoGate, matricesClose, type GizmoMode } from "$lib/render/xformOps";
  import type { RendererKit } from "$lib/three/RendererKit.svelte";
  import { controlsState } from "$lib/state/controlsState.svelte";
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

  // Transform gizmo (Phase 3 Task 4): attached to a scene-root proxy at the
  // selected prim's world transform; commits author through set_attribute_value
  // and the usd-stage-changed refresh re-anchors it.
  let gizmo = $state<TransformGizmo | null>(null);
  let gizmoError = $state<string | null>(null);
  let gizmoCommitInFlight = $state(false);

  // The gate logic is pure code in xformOps.ts (Vitest-pinned): a prim
  // with no authored xformOpOrder reports identity transforms and stays
  // editable, so the create-op path can author the op AND xformOpOrder
  // from scratch; only genuinely unsupported stacks disable the gizmo.
  const gizmoGate = $derived(evaluateGizmoGate(stageState.selectedPath, stageState.details));

  const gizmoMessage = $derived(gizmoError ?? gizmoGate.message);

  // Review fix (playhead units): the timeline works in 0..(end-start)
  // offsets; this is the boundary to the absolute USD time codes that
  // setStageTime speaks. (The page keeps its own copy for export ranges.)
  function startTimeCode(): number {
    return stageState.stageInfo?.start_time_code ?? 0;
  }

  // The prim's world matrix in VIEWPORT space: the USD world transform
  // composed with the loaded group's recentering + up-axis transform.
  function gizmoWorldMatrix(): THREE.Matrix4 | null {
    const details = stageState.details;
    if (!details?.world_transform) return null;
    const world = new THREE.Matrix4().fromArray(details.world_transform);
    const group = viewer.loadedGroup;
    if (group) {
      group.updateMatrixWorld();
      world.premultiply(group.matrixWorld);
    }
    return world;
  }

  // Commit errors clear with the next selection; a fresh anchor snaps the
  // proxy back to stage truth (also the failure path: a refused commit
  // leaves details unchanged, so the re-anchor undoes the drag).
  $effect(() => {
    const _path = stageState.details?.path;
    gizmoError = null;
  });

  $effect(() => {
    const kit = gizmo;
    const gate = gizmoGate;
    if (!kit) return;
    kit.controls.setMode(gizmoMode);
    if (!gate.attachable) {
      kit.detach();
      return;
    }
    const world = gizmoWorldMatrix();
    if (world) kit.attach(world);
  });

  // Drag end -> desired USD local matrix -> the op(s) to author. The
  // parent/world chain cancels in the start/end ratio, so no ancestor
  // walk is needed: L' = L * inv(startWorld) * endWorld.
  async function handleGizmoCommit(commit: GizmoCommit) {
    const details = stageState.details;
    if (gizmoCommitInFlight || !details?.local_transform || !details.world_transform) return;
    gizmoCommitInFlight = true;
    if (gizmo) gizmo.controls.enabled = false;
    try {
      const local = new THREE.Matrix4().fromArray(details.local_transform);
      const target = local
        .clone()
        .multiply(commit.startWorld.clone().invert())
        .multiply(commit.endWorld)
        .toArray() as number[];
      if (matricesClose(target, details.local_transform)) {
        gizmo?.attach(gizmoWorldMatrix() ?? commit.endWorld);
        return;
      }
      const orderAttribute = details.attributes.find((a) => a.name === "xformOpOrder");
      const order = Array.isArray(orderAttribute?.value.data) ? (orderAttribute!.value.data as string[]) : [];
      const result = composeOpUpdate({
        mode: gizmoMode,
        order,
        attrs: details.attributes,
        localMatrix: details.local_transform,
        targetLocalMatrix: target,
      });
      if (!result.ok) {
        gizmoError = result.error;
        gizmo?.attach(gizmoWorldMatrix() ?? commit.endWorld);
        return;
      }
      let failed = false;
      for (const write of result.writes) {
        // xformOpOrder is uniform: it authors its default, never a time
        // sample; the op values author at the viewer's current time code.
        const error = await stageState.setAttributeValue(
          write.name,
          { type: write.type, data: write.data },
          write.name === "xformOpOrder" ? null : undefined,
        );
        if (error !== null) {
          gizmoError = error;
          failed = true;
          break;
        }
      }
      // Keep commits disabled until fresh details land; a second drag must
      // never compute from the pre-commit local transform.
      if (!failed) await stageState.refreshAfterEdit();
      gizmo?.attach(failed ? (gizmoWorldMatrix() ?? commit.endWorld) : commit.endWorld);
    } finally {
      gizmoCommitInFlight = false;
      if (gizmo) gizmo.controls.enabled = true;
    }
  }

  $effect(() => {
    if (viewer.scene) viewer.scene.background = new THREE.Color(viewer.backgroundColor);
  });

  $effect(() => {
    if (viewer.gridHelper) viewer.gridHelper.visible = viewer.showGrid;
  });

  $effect(() => {
    if (viewer.boxHelper) viewer.boxHelper.visible = viewer.showBoundingBox;
  });

  // The graphics-sync bodies live in sceneIntegration.ts; the reads inside
  // them are still tracked because they run synchronously within these
  // effects.
  $effect(() => {
    syncGraphicsSettings(viewer);
  });

  $effect(() => {
    syncLightRig(viewer, lightAzimuth, lightElevation);
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
      // The gizmo lives with the renderer kit's camera/scene/orbit: drag
      // events come off the same canvas, and the orbit disables while a
      // gizmo drag is active. The editing POLICY (gating, anchor, commit
      // math) stays with the viewer here.
      gizmo = new TransformGizmo(viewer.camera, viewer.renderer.domElement, viewer.scene, viewer.controls);
      gizmo.onCommit = handleGizmoCommit;
    }

    // Task 6 playback driver: the render loop advances the stage playhead
    // in USD time codes. The seconds -> time-code rate conversion lives
    // ONLY here and in the exporter (spec §8) — advanceStageTime.
    viewer.onAdvanceTime = (deltaSeconds: number) => {
      const info = stageState.stageInfo;
      const start = info?.start_time_code ?? 0;
      const end = info?.end_time_code ?? 0;
      if (end <= start) return;
      const tcps = info?.time_codes_per_second ?? 24;
      const next = advanceStageTime(renderState.time ?? start, deltaSeconds, tcps, start, end);
      viewer.animationProgress = toPlayheadOffset(next, start);
      void renderState.setStageTime(next);
    };

    // Loading orchestration lives in loadOrchestrator; the viewport-bound
    // steps it can't own are handed back through the sceneIntegration
    // step functions.
    const unlisteners = [
      loadOrchestrator.init({
        resetScene: () => resetLoadedScene(viewer),
        loadScene: () => loadRustScene(viewer),
      }),
      listen("usd-stage-changed", (event) => {
        const paths = ((event.payload as { paths?: string[] } | null)?.paths ?? []) as string[];
        void refreshSceneAfterEdit(viewer, paths);
      }),
    ];

    return () => {
      unlisteners.forEach((u) => u.then((f) => f()));
      gizmo?.dispose();
      gizmo = null;
      viewer.dispose();
    };
  });
</script>

<section class="viewport">
  {#if loadOrchestrator.rootFile}
    <Toolbar {viewer} bind:gizmoMode {gizmoMessage} attachable={gizmoGate.attachable} />
  {/if}

  <canvas bind:this={canvas} class="webgl-canvas" class:visible={!!loadOrchestrator.rootFile}></canvas>

  {#if viewer.hasAnimation}
    <div class="timeline-overlay">
      <button
        class="icon-btn"
        style="color: #d4d4d4"
        onclick={() => (viewer.isPlayingAnim = !viewer.isPlayingAnim)}
        title={viewer.isPlayingAnim ? "Pause" : "Play"}
      >
        {viewer.isPlayingAnim ? "⏸" : "▶"}
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
          void renderState.setStageTime(toAbsoluteTime(viewer.animationProgress, startTimeCode()));
          if (viewer.showBoundingBox && viewer.loadedGroup)
            viewer.sceneBox.setFromObject(viewer.loadedGroup, true);
          if (viewer.selectedNode && viewer.selectionHelper) {
            // @ts-ignore
            viewer.selectionHelper.box.setFromObject(viewer.selectedNode, true);
          }
        }}
        onmousedown={() => (viewer.isDraggingAnim = true)}
        onmouseup={() => (viewer.isDraggingAnim = false)}
      />
      <span class="timeline-time"
        >{viewer.animationProgress.toFixed(2)} / {viewer.animationDuration.toFixed(2)}</span
      >
    </div>
  {/if}

  {#if !loadOrchestrator.rootFile}
    <div class="empty-state">
      <p>No USD scene loaded.</p>
      <p class="subtitle">Use File > Open USD... or the button to begin.</p>
    </div>
  {:else if loadOrchestrator.loadingProgress}
    <div class="loading-overlay">
      <h3>Loading {loadOrchestrator.loadingProgress.stage}...</h3>
    </div>
  {/if}
</section>

<style>
  .viewport {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1e1e1e;
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
    background: rgba(0, 0, 0, 0.7);
    padding: 10px 20px;
    border-radius: 8px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 60%;
    min-width: 300px;
    backdrop-filter: blur(4px);
    border: 1px solid #333;
  }

  .timeline-slider {
    flex: 1;
  }

  .timeline-time {
    color: #4ec9b0;
    font-family: monospace;
    font-size: 12px;
    min-width: 125px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .empty-state {
    text-align: center;
    color: #666;
    z-index: 2;
  }

  .loading-overlay {
    position: absolute;
    bottom: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.7);
    padding: 10px 20px;
    border-radius: 6px;
    z-index: 2;
    color: #4ec9b0;
  }

  .empty-state p {
    margin: 4px 0;
  }

  .empty-state .subtitle {
    font-size: 13px;
    color: #555;
  }
</style>
