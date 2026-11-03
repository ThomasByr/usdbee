<script lang="ts">
  import type { WebGLRenderer, PerspectiveCamera, Scene } from "three";
  import * as THREE from "three";
  import Modal from "$lib/components/Modal.svelte";

  let {
    renderer = null,
    scene = null,
    camera = null,
    hasAnimation = false,
    animationDuration = 0,
    animationProgress = 0,
    // Task 6: steps the stage playhead to `t` — a 0-based offset from
    // start_time_code (the modal's range inputs are offsets) — and waits for
    // the animated refresh before rendering a preview frame. The caller
    // (+page) converts to absolute USD time codes.
    previewAt = null,
    isExporting = false,
    exportProgress = 0,
    exportStage = "Exporting...",
    onClose,
    onExport,
  }: {
    renderer: WebGLRenderer | null;
    scene: Scene | null;
    camera: PerspectiveCamera | null;
    hasAnimation: boolean;
    animationDuration: number;
    animationProgress: number;
    previewAt: ((t: number) => Promise<void>) | null;
    isExporting: boolean;
    exportProgress: number;
    exportStage: string;
    onClose: () => void;
    onExport: (detail: ExportRequest) => void;
  } = $props();

  let format = $state<"jpg" | "png" | "mp4">("png");
  let quality = $state(0.9);
  let resolution = $state("1920x1080");
  let bgTransparent = $state(true);
  let previewUrl = $state<string | null>(null);
  let previewGeneration = $state(0);

  let exportTime = $state(0);
  let crop = $state(false);
  let exportStartTime = $state(0);
  let exportEndTime = $state(0);
  let previewTarget = $state<"start" | "end">("start");
  let loop = $state(false);

  $effect(() => {
    if (animationDuration > 0 && exportEndTime === 0) {
      exportEndTime = animationDuration;
    }
  });

  const resolutions = [
    { label: "480p (4:3)", value: "640x480", width: 640, height: 480 },
    { label: "720p (16:9)", value: "1280x720", width: 1280, height: 720 },
    { label: "1080p (16:9)", value: "1920x1080", width: 1920, height: 1080 },
    { label: "1440p (16:9)", value: "2560x1440", width: 2560, height: 1440 },
    { label: "4K (16:9)", value: "3840x2160", width: 3840, height: 2160 },
  ];

  function close() {
    onClose();
  }

  async function updatePreview() {
    const generation = ++previewGeneration;
    if (!renderer || !scene || !camera) {
      console.log("updatePreview: missing renderer/scene/camera");
      return;
    }

    const res = resolutions.find((r) => r.value === resolution);
    if (!res) return;

    try {
      if (hasAnimation && previewAt) {
        let pTime =
          format === "mp4" ? (previewTarget === "start" ? exportStartTime : exportEndTime) : exportTime;
        await previewAt(pTime);
      }
      if (generation !== previewGeneration) return;

      const originalSize = new THREE.Vector2();
      renderer.getSize(originalSize);
      const originalClearAlpha = renderer.getClearAlpha();
      const originalClearColor = renderer.getClearColor(new THREE.Color());
      const originalSceneBackground = scene.background;

      const isTransparent = format === "png" && bgTransparent;
      renderer.setClearAlpha(isTransparent ? 0 : 1);
      if (isTransparent) {
        scene.background = null;
      } else if (!isTransparent) {
        renderer.setClearColor(0x333333, 1);
      }

      // render to preview
      renderer.setSize(res.width, res.height);
      camera.aspect = res.width / res.height;
      camera.updateProjectionMatrix();

      renderer.render(scene, camera);

      if (format === "jpg") {
        previewUrl = renderer.domElement.toDataURL("image/jpeg", quality);
      } else {
        previewUrl = renderer.domElement.toDataURL("image/png");
      }

      // Restore
      renderer.setSize(originalSize.x, originalSize.y);
      camera.aspect = originalSize.x / originalSize.y;
      camera.updateProjectionMatrix();
      renderer.setClearAlpha(originalClearAlpha);
      renderer.setClearColor(originalClearColor, originalClearAlpha);
      scene.background = originalSceneBackground;

      if (hasAnimation && previewAt) {
        await previewAt(animationProgress);
      }
    } catch (err) {
      console.error("updatePreview error:", err);
    }
  }

  $effect(() => {
    if (renderer && scene && camera) {
      const timer = setTimeout(updatePreview, 50);
      return () => clearTimeout(timer);
    }
  });

  $effect(() => {
    format;
    resolution;
    quality;
    bgTransparent;
    exportTime;
    exportStartTime;
    exportEndTime;
    previewTarget;
    const timer = setTimeout(updatePreview, 50);
    return () => clearTimeout(timer);
  });

  async function doExport() {
    const res = resolutions.find((r) => r.value === resolution);
    if (!res || !renderer || !scene || !camera) return;

    const data = {
      format,
      quality: format === "jpg" ? quality : undefined,
      resolution: { width: res.width, height: res.height },
      bgTransparent: format === "png" && bgTransparent,
      timestamp: (format === "jpg" || format === "png") && hasAnimation ? exportTime : undefined,
      mp4Crop: format === "mp4" && crop ? { start: exportStartTime, end: exportEndTime } : undefined,
      loop: format === "mp4" ? loop : undefined,
    };
    onExport(data);
  }
  type ExportRequest = {
    format: "jpg" | "png" | "mp4";
    quality: number | undefined;
    resolution: { width: number; height: number };
    bgTransparent: boolean;
    timestamp: number | undefined;
    mp4Crop: { start: number; end: number } | undefined;
    loop: boolean | undefined;
  };
</script>

<Modal title="Export Scene" contentClass="export-modal-content" onClose={close}>
  <div class="export-body">
    <!-- Settings Panel -->
    <div class="export-settings">
      <!-- Format Selection -->
      <div class="format-buttons">
        {#each hasAnimation ? ["png", "jpg", "mp4"] : ["png", "jpg"] as f}
          <button
            class="format-btn {format === f ? 'active' : ''}"
            onclick={() => (format = f as "jpg" | "png" | "mp4")}
          >
            {f}
          </button>
        {/each}
      </div>

      <!-- Resolution -->
      <div class="setting-group">
        <label for="resolution_select">Resolution & Aspect Ratio</label>
        <select id="resolution_select" bind:value={resolution} class="export-select">
          {#each resolutions as res}
            <option value={res.value}>{res.label} ({res.width}x{res.height})</option>
          {/each}
        </select>
      </div>

      <!-- Format-specific options -->
      <div class="format-options">
        {#if format === "jpg"}
          <div class="setting-group">
            <label class="range-label" for="quality_slider">
              <span>Quality</span>
              <span>{quality.toFixed(1)}</span>
            </label>
            <input
              id="quality_slider"
              type="range"
              min="0.1"
              max="1"
              step="0.1"
              bind:value={quality}
              class="export-slider"
            />
          </div>
          {#if hasAnimation}
            <div class="setting-group">
              <label class="range-label" for="time_slider">
                <span>Timestamp</span>
                <span>{exportTime.toFixed(2)}</span>
              </label>
              <input
                id="time_slider"
                type="range"
                min="0"
                max={animationDuration}
                step="0.01"
                bind:value={exportTime}
                class="export-slider"
              />
            </div>
          {/if}
        {:else if format === "png"}
          <div class="setting-group">
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={bgTransparent} />
              Transparent Background
            </label>
          </div>
          {#if hasAnimation}
            <div class="setting-group">
              <label class="range-label" for="time_slider_png">
                <span>Timestamp</span>
                <span>{exportTime.toFixed(2)}</span>
              </label>
              <input
                id="time_slider_png"
                type="range"
                min="0"
                max={animationDuration}
                step="0.01"
                bind:value={exportTime}
                class="export-slider"
              />
            </div>
          {/if}
        {:else if format === "mp4"}
          <div class="setting-group">
            <label
              class="checkbox-label"
              title="Appends MP4 metadata to tell video players to loop the video endlessly"
            >
              <input type="checkbox" bind:checked={loop} />
              Infinite Loop Playback Metadata
            </label>
            {#if hasAnimation}
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={crop} />
                Crop Timeline to Content
              </label>
              {#if crop}
                <div class="setting-group time-crop-group">
                  <label class="range-label" for="crop_start_time">
                    <span>Crop Timeline</span>
                  </label>
                  <div class="dual-slider-container">
                    <div class="slider-track-bg"></div>
                    <div
                      class="slider-track"
                      style="left: {(exportStartTime / animationDuration) * 100}%; right: {100 -
                        (exportEndTime / animationDuration) * 100}%;"
                    ></div>
                    <input
                      id="crop_start_time"
                      type="range"
                      class="dual-range"
                      min="0"
                      max={animationDuration}
                      step="0.01"
                      bind:value={exportStartTime}
                      oninput={() => {
                        if (exportStartTime > exportEndTime) exportStartTime = exportEndTime;
                        previewTarget = "start";
                      }}
                    />
                    <input
                      type="range"
                      class="dual-range"
                      min="0"
                      max={animationDuration}
                      step="0.01"
                      bind:value={exportEndTime}
                      oninput={() => {
                        if (exportEndTime < exportStartTime) exportEndTime = exportStartTime;
                        previewTarget = "end";
                      }}
                    />
                  </div>
                  <div
                    style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-mid);"
                  >
                    <span>Start: {exportStartTime.toFixed(2)}</span>
                    <span>End: {exportEndTime.toFixed(2)}</span>
                  </div>
                </div>
              {/if}
            {/if}
            <p class="export-warning">MP4 Export requires rendering all frames.</p>
          </div>
        {/if}
      </div>
    </div>

    <!-- Preview Panel -->
    <div class="export-preview-panel">
      <div class="preview-badge">Preview</div>
      <div class="preview-container checkerboard">
        {#if previewUrl}
          <img src={previewUrl} alt="Export Preview" class="preview-img" />
        {:else}
          <div class="mp4-placeholder">
            <span class="mp4-icon">▶</span>
            <span>Preview not available for MP4</span>
            <span class="mp4-sub">Video will be rendered directly.</span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Footer Actions -->
  <div class="export-footer">
    {#if isExporting}
      <div class="export-progress-container" style="flex: 1; margin-right: 15px;">
        <div style="font-size: 0.85rem; margin-bottom: 5px; color: var(--text);">
          {exportStage}
          {exportProgress}%
        </div>
        <div
          class="export-progress-bar"
          style="background: var(--bg-sunken); height: 8px; border-radius: 4px; overflow: hidden;"
        >
          <div
            style="background: var(--success-strong); height: 100%; width: {exportProgress}%; transition: width 0.1s linear;"
          ></div>
        </div>
      </div>
    {:else}
      <button class="export-btn cancel" onclick={close} disabled={isExporting}>Cancel</button>
      <button class="export-btn confirm" onclick={doExport} disabled={isExporting}
        >Export {format.toUpperCase()}</button
      >
    {/if}
  </div>
</Modal>

<style>
  :global(.export-modal-content) {
    background: var(--bg);
    color: var(--text-strong);
    border-radius: 8px;
    width: 100%;
    max-width: 800px;
    max-height: 90vh;
    padding: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 30px var(--shadow);
    border: 1px solid var(--border);
  }

  :global(.export-modal-content > h3) {
    margin: 0;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    border-radius: 8px 8px 0 0;
    font-size: 1.2rem;
  }

  .export-body {
    display: flex;
    flex-direction: row;
    padding: 20px;
    gap: 20px;
    flex: 1;
    overflow: hidden;
  }

  .export-settings {
    width: 300px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .format-buttons {
    display: flex;
    gap: 8px;
  }

  .format-btn {
    flex: 1;
    padding: 8px;
    background: var(--bg-sunken);
    color: var(--text);
    border: 1px solid var(--border-muted);
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    text-transform: uppercase;
  }

  .format-btn:hover {
    background: var(--btn-secondary-bg);
  }

  .format-btn.active {
    background: var(--accent);
    color: var(--accent-contrast);
    border-color: var(--accent-hover);
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .setting-group label {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .export-select {
    background: var(--bg-sunken);
    color: var(--text-bright);
    border: 1px solid var(--border-strong);
    padding: 8px;
    border-radius: 4px;
  }

  .export-select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .format-options {
    background: var(--panel-inset);
    padding: 16px;
    border-radius: 4px;
    border: 1px solid var(--border);
    min-height: 120px;
    flex: 1;
  }

  .range-label {
    display: flex;
    justify-content: space-between;
  }

  .export-slider {
    width: 100%;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .export-warning {
    color: var(--warning-pale);
    font-size: 0.8rem;
    margin-top: 10px;
  }

  .export-preview-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-deep);
    border-radius: 4px;
    border: 1px solid var(--border);
    position: relative;
    min-height: 300px;
    overflow: hidden;
  }

  .preview-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    background: var(--accent);
    padding: 4px 8px;
    font-size: 0.8rem;
    border-radius: 4px;
    color: var(--accent-contrast);
    z-index: 10;
    pointer-events: none;
  }

  .preview-container {
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 20px;
  }

  .checkerboard {
    background-image:
      linear-gradient(45deg, var(--checkerboard) 25%, transparent 25%),
      linear-gradient(-45deg, var(--checkerboard) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--checkerboard) 75%),
      linear-gradient(-45deg, transparent 75%, var(--checkerboard) 75%);
    background-size: 20px 20px;
    background-position:
      0 0,
      0 10px,
      10px -10px,
      -10px 0px;
    background-color: var(--preview-bg);
  }

  .preview-img {
    max-width: 100%;
    max-height: 50vh;
    object-fit: contain;
    box-shadow: 0 5px 15px var(--shadow);
  }

  .mp4-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    color: var(--text-faint);
  }

  .mp4-icon {
    font-size: 2.5rem;
    margin-bottom: 10px;
    opacity: 0.5;
  }

  .mp4-sub {
    font-size: 0.8rem;
    opacity: 0.7;
    margin-top: 4px;
  }

  .export-footer {
    padding: 16px 20px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    border-radius: 0 0 8px 8px;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  .export-btn {
    padding: 8px 20px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.95rem;
  }

  .export-btn.cancel {
    background: var(--btn-secondary-bg);
    color: var(--text-bright);
  }

  .export-btn.cancel:hover {
    background: var(--btn-secondary-hover);
  }

  .export-btn.confirm {
    background: var(--accent);
    color: var(--accent-contrast);
  }

  .export-btn.confirm:hover {
    background: var(--accent-hover);
  }

  @media (max-width: 600px) {
    .export-body {
      flex-direction: column;
    }
    .export-settings {
      width: 100%;
      flex: none;
    }
  }
  .dual-slider-container {
    position: relative;
    width: 100%;
    height: 30px;
    margin-top: 5px;
    display: flex;
    align-items: center;
  }
  .dual-slider-container input[type="range"] {
    position: absolute;
    width: 100%;
    pointer-events: none;
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    z-index: 2;
    margin: 0;
  }
  .dual-slider-container input[type="range"]::-webkit-slider-thumb {
    pointer-events: auto;
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
  }
  .dual-slider-container input[type="range"]::-moz-range-thumb {
    pointer-events: auto;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: none;
  }
  .slider-track-bg {
    position: absolute;
    width: 100%;
    height: 4px;
    background: var(--bg-sunken);
    border-radius: 2px;
    z-index: 0;
  }
  .slider-track {
    position: absolute;
    height: 4px;
    background: var(--accent);
    border-radius: 2px;
    z-index: 1;
  }
</style>
