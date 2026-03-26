<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import type { WebGLRenderer, PerspectiveCamera, Scene } from "three";
  import * as THREE from "three";

  export let renderer: WebGLRenderer | null = null;
  export let scene: Scene | null = null;
  export let camera: PerspectiveCamera | null = null;
  export let hasAnimation: boolean = false;
  export let animationDuration: number = 0;
  export let animationProgress: number = 0;
  export let mixer: THREE.AnimationMixer | null = null;
  export let isExporting: boolean = false;
  export let exportProgress: number = 0;
  export let exportStage: string = "Exporting...";

  const dispatch = createEventDispatcher();

  let format: "jpg" | "png" | "mp4" = "png";
  let quality = 0.9;
  let resolution = "1920x1080";
  let bgTransparent = true;
  let previewUrl: string | null = null;

  let exportTime = 0;
  let crop = false;
  let exportStartTime = 0;
  let exportEndTime = 0;
  let previewTarget: "start" | "end" = "start";
  let loop = false;

  $: if (animationDuration > 0 && exportEndTime === 0) {
    exportEndTime = animationDuration;
  }

  const resolutions = [
    { label: "480p (4:3)", value: "640x480", width: 640, height: 480 },
    { label: "720p (16:9)", value: "1280x720", width: 1280, height: 720 },
    { label: "1080p (16:9)", value: "1920x1080", width: 1920, height: 1080 },
    { label: "1440p (16:9)", value: "2560x1440", width: 2560, height: 1440 },
    { label: "4K (16:9)", value: "3840x2160", width: 3840, height: 2160 },
  ];

  function close() {
    dispatch("close");
  }

  function updatePreview() {
    if (!renderer || !scene || !camera) {
      console.log("updatePreview: missing renderer/scene/camera");
      return;
    }

    const res = resolutions.find((r) => r.value === resolution);
    if (!res) return;

    try {
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

      if (hasAnimation && mixer) {
        let pTime =
          format === "mp4" ? (previewTarget === "start" ? exportStartTime : exportEndTime) : exportTime;
        mixer.setTime(pTime);
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

      if (hasAnimation && mixer) {
        mixer.setTime(animationProgress);
      }
    } catch (err) {
      console.error("updatePreview error:", err);
    }
  }

  onMount(() => {
    if (renderer && scene && camera) {
      setTimeout(updatePreview, 50);
    }
  });

  $: if (
    format ||
    resolution ||
    quality ||
    bgTransparent ||
    exportTime ||
    exportStartTime ||
    exportEndTime ||
    previewTarget
  ) {
    setTimeout(updatePreview, 50);
  }

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
    dispatch("export", data);
  }
</script>

<div
  class="modal-overlay"
  on:click|self={close}
  role="button"
  tabindex="0"
  on:keydown={(e) => e.key === "Escape" && close()}
>
  <div class="export-modal-content">
    <div class="export-header">
      <h2>Export Scene</h2>
      <button on:click={close} class="export-close-btn">&times;</button>
    </div>

    <div class="export-body">
      <!-- Settings Panel -->
      <div class="export-settings">
        <!-- Format Selection -->
        <div class="format-buttons">
          {#each hasAnimation ? ["png", "jpg", "mp4"] : ["png", "jpg"] as f}
            <button class="format-btn {format === f ? 'active' : ''}" on:click={() => (format = f as any)}>
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
                  <span>{exportTime.toFixed(2)}s</span>
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
                  <span>{exportTime.toFixed(2)}s</span>
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
                        on:input={() => {
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
                        on:input={() => {
                          if (exportEndTime < exportStartTime) exportEndTime = exportStartTime;
                          previewTarget = "end";
                        }}
                      />
                    </div>
                    <div
                      style="display: flex; justify-content: space-between; font-size: 0.8rem; color: #aaa;"
                    >
                      <span>Start: {exportStartTime.toFixed(2)}s</span>
                      <span>End: {exportEndTime.toFixed(2)}s</span>
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
          <div style="font-size: 0.85rem; margin-bottom: 5px; color: #ccc;">
            {exportStage}
            {exportProgress}%
          </div>
          <div
            class="export-progress-bar"
            style="background: #333; height: 8px; border-radius: 4px; overflow: hidden;"
          >
            <div
              style="background: #4caf50; height: 100%; width: {exportProgress}%; transition: width 0.1s linear;"
            ></div>
          </div>
        </div>
      {:else}
        <button class="export-btn cancel" on:click={close} disabled={isExporting}>Cancel</button>
        <button class="export-btn confirm" on:click={doExport} disabled={isExporting}
          >Export {format.toUpperCase()}</button
        >
      {/if}
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }

  .export-modal-content {
    background: #1e1e1e;
    color: #e0e0e0;
    border-radius: 8px;
    width: 100%;
    max-width: 800px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    border: 1px solid #333;
  }

  .export-header {
    padding: 16px 20px;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #252526;
    border-radius: 8px 8px 0 0;
  }

  .export-header h2 {
    margin: 0;
    font-size: 1.2rem;
  }

  .export-close-btn {
    background: none;
    border: none;
    color: #888;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0;
  }

  .export-close-btn:hover {
    color: #fff;
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
    background: #333;
    color: #ccc;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    text-transform: uppercase;
  }

  .format-btn:hover {
    background: #444;
  }

  .format-btn.active {
    background: #0e639c;
    color: white;
    border-color: #1177bb;
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
    background: #333;
    color: white;
    border: 1px solid #555;
    padding: 8px;
    border-radius: 4px;
  }

  .export-select:focus {
    outline: none;
    border-color: #0e639c;
  }

  .format-options {
    background: #252525;
    padding: 16px;
    border-radius: 4px;
    border: 1px solid #333;
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
    color: #d7ba7d;
    font-size: 0.8rem;
    margin-top: 10px;
  }

  .export-preview-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: #111;
    border-radius: 4px;
    border: 1px solid #333;
    position: relative;
    min-height: 300px;
    overflow: hidden;
  }

  .preview-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    background: rgba(0, 0, 0, 0.6);
    padding: 4px 8px;
    font-size: 0.8rem;
    border-radius: 4px;
    color: #aaa;
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
      linear-gradient(45deg, #222 25%, transparent 25%), linear-gradient(-45deg, #222 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #222 75%), linear-gradient(-45deg, transparent 75%, #222 75%);
    background-size: 20px 20px;
    background-position:
      0 0,
      0 10px,
      10px -10px,
      -10px 0px;
    background-color: #1a1a1a;
  }

  .preview-img {
    max-width: 100%;
    max-height: 50vh;
    object-fit: contain;
    box-shadow: 0 5px 15px rgba(0, 0, 0, 0.5);
  }

  .mp4-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    color: #666;
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
    background: #252526;
    border-top: 1px solid #333;
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
    background: #444;
    color: #fff;
  }

  .export-btn.cancel:hover {
    background: #555;
  }

  .export-btn.confirm {
    background: #0e639c;
    color: #fff;
  }

  .export-btn.confirm:hover {
    background: #1177bb;
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
    background: #0e639c;
    cursor: pointer;
  }
  .dual-slider-container input[type="range"]::-moz-range-thumb {
    pointer-events: auto;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #0e639c;
    cursor: pointer;
    border: none;
  }
  .slider-track-bg {
    position: absolute;
    width: 100%;
    height: 4px;
    background: #333;
    border-radius: 2px;
    z-index: 0;
  }
  .slider-track {
    position: absolute;
    height: 4px;
    background: #0e639c;
    border-radius: 2px;
    z-index: 1;
  }
</style>
