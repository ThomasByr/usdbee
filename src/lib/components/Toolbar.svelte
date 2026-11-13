<script lang="ts">
  import { editState } from "$lib/state/editState.svelte";
  import { tabsState } from "$lib/state/tabsState.svelte";
  import type { RendererKit } from "$lib/three/RendererKit.svelte";
  import type { GizmoMode } from "$lib/render/xformOps";

  // The toolbar toggles live on the shared RendererKit (the page keeps it
  // for the sidebar tabs); mode + gate status come from the Viewport's
  // gizmo wiring.
  let {
    viewer,
    gizmoMode = $bindable(),
    gizmoMessage,
    attachable,
    disabled = false,
  }: {
    viewer: RendererKit;
    gizmoMode: GizmoMode;
    gizmoMessage: string | null;
    attachable: boolean;
    disabled?: boolean;
  } = $props();

  let showFovSlider = $state<boolean>(false);
</script>

<div class="top-toolbar" class:disabled inert={disabled}>
  <button
    class="tool-btn"
    disabled={!editState.canUndo}
    onclick={() => void editState.undo()}
    title="Undo (Ctrl+Z)"
  >
    <span>Undo</span>
  </button>
  <button
    class="tool-btn"
    disabled={!editState.canRedo}
    onclick={() => void editState.redo()}
    title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
  >
    <span>Redo</span>
  </button>
  <div class="gizmo-sep"></div>
  <button
    class="tool-btn"
    onclick={() => {
      tabsState.forgetActiveCamera();
      viewer.resetCameraView();
    }}
    title="Reset View"
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
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
      <path d="M3 3v5h5"></path>
    </svg>
    <span>Reset View</span>
  </button>

  <div style="position: relative;">
    <button class="tool-btn" onclick={() => (showFovSlider = !showFovSlider)} title="Field of View">
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
        <path d="M2 12A10 10 0 1 0 22 12 10 10 0 1 0 2 12Z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
      <span>FOV: fov={viewer.fov}°</span>
    </button>
    {#if showFovSlider}
      <div class="slider-dropdown">
        <input
          type="range"
          class="slider"
          min="10"
          max="120"
          step="1"
          bind:value={viewer.fov}
          oninput={() => {
            if (viewer.camera) {
              viewer.camera.fov = viewer.fov;
              viewer.camera.updateProjectionMatrix();
            }
          }}
          onchange={() => localStorage.setItem("cameraFov", viewer.fov.toString())}
        />
      </div>
    {/if}
  </div>

  <button
    class="tool-btn"
    style={viewer.enableDamping ? "color: var(--accent);" : ""}
    onclick={() => {
      viewer.enableDamping = !viewer.enableDamping;
      if (viewer.controls) viewer.controls.enableDamping = viewer.enableDamping;
      localStorage.setItem("cameraDamping", viewer.enableDamping.toString());
    }}
    title="Toggle Camera Inertia"
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
      {#if viewer.enableDamping}
        <path d="M9.59 4.59A2 2 0 1 1 11 8H2"></path>
        <path d="M12.59 19.41A2 2 0 1 0 14 16H2"></path>
        <path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2"></path>
      {:else}
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
      {/if}
    </svg>
    <span>Inertia: {viewer.enableDamping ? "On" : "Off"}</span>
  </button>

  <div class="gizmo-sep"></div>
  <button
    class="tool-btn"
    class:active={gizmoMode === "translate"}
    disabled={!attachable}
    onclick={() => (gizmoMode = "translate")}
    title="Move the selected prim (viewport gizmo)"
  >
    <span>Move</span>
  </button>
  <button
    class="tool-btn"
    class:active={gizmoMode === "rotate"}
    disabled={!attachable}
    onclick={() => (gizmoMode = "rotate")}
    title="Rotate the selected prim (XYZ Euler degrees)"
  >
    <span>Rotate</span>
  </button>
  <button
    class="tool-btn"
    class:active={gizmoMode === "scale"}
    disabled={!attachable}
    onclick={() => (gizmoMode = "scale")}
    title="Scale the selected prim"
  >
    <span>Scale</span>
  </button>
  {#if gizmoMessage}<span class="gizmo-status" title={gizmoMessage}>⚠</span>{/if}

  <div class="triangle-count" style="gap: 4px;">
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
      <path d="M12 2L2 22h20L12 2z"></path>
    </svg>
    <span>{viewer.triangleCount.toLocaleString()}</span>
  </div>
</div>

<style>
  .top-toolbar {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100% - 20px);
    display: flex;
    gap: 8px;
    background: var(--toolbar-bg);
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--control-border);
    z-index: 10;
    backdrop-filter: blur(4px);
    align-items: center;
  }

  /* Fit on one line when there is room; shrink to ellipsis when there is not. */
  .top-toolbar .tool-btn {
    white-space: nowrap;
    overflow: hidden;
    min-width: 0;
  }

  .top-toolbar .tool-btn span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .top-toolbar .tool-btn svg {
    flex-shrink: 0;
  }

  .gizmo-status {
    color: var(--warning-soft);
    font-size: 13px;
    cursor: help;
  }

  .gizmo-sep {
    width: 1px;
    height: 18px;
    background: var(--control-bg);
  }

  /* No stage open: visible but inert (inert blocks interaction + focus;
     pointer-events covers older WebKitGTK). */
  .top-toolbar.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .slider-dropdown {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 8px;
    background: var(--panel);
    border: 1px solid var(--control-border);
    padding: 10px 14px;
    border-radius: 6px;
    box-shadow: 0 4px 12px var(--shadow);
    display: flex;
    align-items: center;
    z-index: 20;
    width: 150px;
    /* Ensures the slider has enough space to expand */
  }

  .triangle-count {
    font-family: monospace;
    font-size: 12px;
    color: var(--syntax-cyan);
    padding-left: 8px;
    border-left: 1px solid var(--control-border);
    display: flex;
    align-items: center;
    height: 20px;
  }
</style>
