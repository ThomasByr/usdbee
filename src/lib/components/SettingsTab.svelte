<script lang="ts">
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
    backgroundColor = $bindable(),
    activeCameraIndex = $bindable(),
    omniverseUrl = $bindable(),
    usdCameras,
    triangleCount,
    saveControlPreferences,
    formatKeyName,
    keysPressed,
    updateOmniverseUrl,
  } = $props<any>();
</script>

<div class="settings-panel">
  <div class="settings-group">
    <h3>Viewport Overlays</h3>
    <label><input type="checkbox" bind:checked={showWireframe} /> Wireframe Mode</label>
    <label><input type="checkbox" bind:checked={showGrid} /> Show Ground Grid</label>
    <label><input type="checkbox" bind:checked={showBoundingBox} /> Show Bounding Box</label>
  </div>

  <div class="settings-group">
    <h3>Keybindings & Control</h3>
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

    <div style="font-size: 11px; color: #888; text-transform: uppercase; margin: 8px 0 4px 0;">
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

    <div style="font-size: 11px; color: #888; text-transform: uppercase; margin: 8px 0 4px 0;">Keyboard</div>
    {#each Object.entries(keybindings) as [action, key]}
      <div
        style="display: flex; align-items: center; justify-content: space-between; font-size: 13px; margin-bottom: 4px;"
      >
        <span style="text-transform: capitalize;">{action}</span>
        <button
          class="keybtn"
          onclick={() => {
            const newKey = prompt(`Press new key for ${action}:`);
            if (newKey) {
              keybindings[action as keyof typeof keybindings] = newKey.toLowerCase();
              localStorage.setItem("usdbee_keybindings", JSON.stringify(keybindings));
            }
          }}
        >
          {formatKeyName(key)}
        </button>
      </div>
    {/each}
  </div>

  <div class="settings-group">
    <h3>Environment</h3>
    <div
      style="display: flex; align-items: center; justify-content: space-between; font-size: 13px; margin-bottom: 8px;"
    >
      <span>Background Color</span>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="reset-btn" onclick={() => (backgroundColor = "#1e1e1e")} title="Reset Background"
          >Reset</button
        >
        <input type="color" bind:value={backgroundColor} />
      </div>
    </div>

    <div style="font-size: 13px; margin-top: 12px; margin-bottom: 6px;">
      <span>Omniverse Nucleus URL</span>
    </div>
    <div style="display: flex; gap: 8px;">
      <input
        type="text"
        bind:value={omniverseUrl}
        onchange={updateOmniverseUrl}
        style="flex: 1; padding: 4px; background: #333; color: white; border: 1px solid #555; border-radius: 4px;"
        placeholder="http://localhost:34080"
      />
    </div>
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
