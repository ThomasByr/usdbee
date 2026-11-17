<script lang="ts">
  import { themeState, setThemePreference, type ThemePreference } from "$lib/state/themeState.svelte";
  import { playbackState, setTimelineUnits, type TimelineUnits } from "$lib/state/playbackState.svelte";
  import { recentFiles } from "$lib/state/recentFiles.svelte";
  import { tabsState } from "$lib/state/tabsState.svelte";
  import { openContainingFolder } from "$lib/utils/reveal";
  import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import {
    controlsState,
    resetControls,
    resetKeybindings,
    saveKeybindings,
  } from "$lib/state/controlsState.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import KeyRecorder from "$lib/components/KeyRecorder.svelte";

  // Display names for the binding keys; the keys themselves stay camelCase.
  const KEY_LABELS: Record<string, string> = {
    playPause: "Play / Pause",
    gizmoTranslate: "Gizmo Translate",
    gizmoRotate: "Gizmo Rotate",
    gizmoScale: "Gizmo Scale",
    turnLeft: "Turn Left",
    turnRight: "Turn Right",
    commandPalette: "Command Palette",
  };

  let {
    showWireframe = $bindable(),
    showGrid = $bindable(),
    showBoundingBox = $bindable(),
    moveSpeedFactor = $bindable(),
    rotSpeedFactor = $bindable(),
    invertMouseX = $bindable(),
    invertMouseY = $bindable(),
    mouseButtonLeft = $bindable(),
    mouseButtonMiddle = $bindable(),
    mouseButtonRight = $bindable(),
    keybindings = $bindable(),
    activeCameraIndex = $bindable(),
    omniverseUrl = $bindable(),
    usdCameras,
    triangleCount,
    saveControlPreferences,
    keysPressed,
    updateOmniverseUrl,
  } = $props<any>();
</script>

<div class="settings-panel">
  <div class="settings-group">
    <h3>Appearance</h3>
    <label style="display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
      Theme
      <select
        class="dropdown"
        style="width: auto"
        value={themeState.preference}
        onchange={(e) => setThemePreference(e.currentTarget.value as ThemePreference)}
      >
        <option value="system">System</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
    <div class="theme-hint">
      Currently {themeState.resolved === "light" ? "Light" : "Dark"}
      <Icon name={themeState.resolved === "light" ? "sun" : "moon"} />
    </div>
  </div>

  <div class="settings-group">
    <h3>Playback</h3>
    <label style="display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
      Timeline Units
      <select
        class="dropdown"
        style="width: auto"
        value={playbackState.timelineUnits}
        onchange={(e) => setTimelineUnits(e.currentTarget.value as TimelineUnits)}
      >
        <option value="frames-seconds">Frames + Seconds</option>
        <option value="frames">Frames</option>
        <option value="seconds">Seconds</option>
      </select>
    </label>
    <div class="theme-hint">How the viewport timeline labels the playhead.</div>
  </div>

  <div class="settings-group">
    <h3>Viewport Overlays</h3>
    <label><input type="checkbox" bind:checked={showWireframe} /> Wireframe Mode</label>
    <label><input type="checkbox" bind:checked={showGrid} /> Show Ground Grid</label>
    <label><input type="checkbox" bind:checked={showBoundingBox} /> Show Bounding Box</label>
  </div>

  <div class="settings-group">
    <div style="display: flex; align-items: center; justify-content: space-between;">
      <h3>Keybindings & Control</h3>
      <button class="reset-btn" onclick={resetControls} title="Restore mouse and speed defaults">
        Reset controls
      </button>
    </div>
    <label style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
      Movement Speed (x{moveSpeedFactor.toFixed(1)})
      <input
        type="range"
        class="slider"
        min="0.1"
        max="10"
        step="0.1"
        bind:value={moveSpeedFactor}
        onchange={saveControlPreferences}
        style="width: 50%"
      />
    </label>
    <label style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
      Rotation Speed (x{rotSpeedFactor.toFixed(1)})
      <input
        type="range"
        class="slider"
        min="0.1"
        max="10"
        step="0.1"
        bind:value={rotSpeedFactor}
        onchange={saveControlPreferences}
        style="width: 50%"
      />
    </label>
    <label style="margin-bottom: 4px;">
      <input type="checkbox" bind:checked={invertMouseX} onchange={saveControlPreferences} /> Invert Mouse X
    </label>
    <label style="margin-bottom: 8px;">
      <input type="checkbox" bind:checked={invertMouseY} onchange={saveControlPreferences} /> Invert Mouse Y
    </label>

    <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; margin: 8px 0 4px 0;">
      Mouse Actions
    </div>
    <label style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
      Left Button
      <select
        class="dropdown"
        style="width: auto; padding: 2px"
        bind:value={mouseButtonLeft}
        onchange={saveControlPreferences}
      >
        <option value="rotate">Rotate</option>
        <option value="pan">Pan</option>
        <option value="zoom">Zoom</option>
      </select>
    </label>
    <label style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
      Middle Button
      <select
        class="dropdown"
        style="width: auto; padding: 2px"
        bind:value={mouseButtonMiddle}
        onchange={saveControlPreferences}
      >
        <option value="rotate">Rotate</option>
        <option value="pan">Pan</option>
        <option value="zoom">Zoom</option>
      </select>
    </label>
    <label style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
      Right Button
      <select
        class="dropdown"
        style="width: auto; padding: 2px"
        bind:value={mouseButtonRight}
        onchange={saveControlPreferences}
      >
        <option value="rotate">Rotate</option>
        <option value="pan">Pan</option>
        <option value="zoom">Zoom</option>
      </select>
    </label>

    <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; margin: 8px 0 4px 0;">
      Command Palette
    </div>
    <label style="margin-bottom: 8px;">
      <input
        type="checkbox"
        bind:checked={controlsState.paletteTabExecutes}
        onchange={saveControlPreferences}
      /> Tab executes highlighted command
    </label>

    <div style="display: flex; align-items: center; justify-content: space-between; margin: 8px 0 4px 0;">
      <span style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Keyboard</span>
      <button class="reset-btn" onclick={resetKeybindings} title="Restore default shortcuts">
        Reset keyboard
      </button>
    </div>
    {#each Object.keys(keybindings) as action}
      <div
        data-action={action}
        style="display: flex; align-items: center; justify-content: space-between; font-size: 13px; margin-bottom: 4px;"
      >
        <span>{KEY_LABELS[action] ?? action}</span>
        <KeyRecorder bind:binding={keybindings[action]} onchange={saveKeybindings} />
      </div>
    {/each}
  </div>

  <div class="settings-group">
    <h3>Environment</h3>
    <div style="font-size: 13px; margin-top: 12px; margin-bottom: 6px;">
      <span>Omniverse Nucleus URL</span>
    </div>
    <div style="display: flex; gap: 8px;">
      <input
        type="text"
        bind:value={omniverseUrl}
        onchange={updateOmniverseUrl}
        style="flex: 1; padding: 4px; background: var(--bg-sunken); color: var(--text-bright); border: 1px solid var(--border-strong); border-radius: 4px;"
        placeholder="http://localhost:34080"
      />
    </div>
  </div>

  <div class="settings-group">
    <h3>Recent Files</h3>
    {#if recentFiles.entries.length === 0}
      <p style="font-size: 12px; color: var(--text-dim);">No recent files yet.</p>
    {:else}
      <div class="recent-list">
        {#each recentFiles.entries as entry (entry.path)}
          <div class="recent-item" title={entry.path}>
            <span class="recent-name">{entry.name}</span>
            <span class="recent-actions">
              <button
                class="reset-btn"
                title="Open {entry.path}"
                onclick={() => void tabsState.openTab(entry.path)}>Open</button
              >
              <button
                class="reset-btn"
                title="Open containing folder"
                onclick={() => void openContainingFolder(entry.path, loadOrchestrator.openErrorModal)}
                >Folder</button
              >
              <button
                class="reset-btn"
                title="Remove from recent files"
                onclick={() => recentFiles.remove(entry.path)}>✕</button
              >
            </span>
          </div>
        {/each}
      </div>
      <button class="reset-btn" onclick={() => recentFiles.clear()}>Clear all</button>
    {/if}
  </div>

  <div class="settings-group">
    <h3>Scene Information</h3>
    <p>Triangles: {triangleCount.toLocaleString()}</p>
  </div>

  {#if usdCameras.length > 0}
    <div class="settings-group">
      <h3>Camera Controls</h3>
      <label>
        Active Camera
        <select bind:value={activeCameraIndex} class="dropdown">
          <option value={-1}>Orbit Controller (Free)</option>
          {#each usdCameras as cam, i}
            <option value={i}>Authored: {cam.name || `Camera ${i + 1}`}</option>
          {/each}
        </select>
      </label>
    </div>
  {/if}
</div>

<style>
  .theme-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }

  .recent-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 13px;
    min-width: 0;
  }

  .recent-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
</style>
