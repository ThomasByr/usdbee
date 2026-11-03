<script lang="ts">
  let {
    maxFps = $bindable(),
    renderScale = $bindable(),
    saveGraphicsPreferences,
    toneMapping = $bindable(),
    toneExposure = $bindable(),
    ambientIntensity = $bindable(),
    dirIntensity = $bindable(),
    shadowsEnabled = $bindable(),
    shadowMapSize = $bindable(),
    shadowMapType = $bindable(),
    anisotropy = $bindable(),
    envMapIntensity = $bindable(),
    backgroundColor = $bindable(),
    lightAzimuth = $bindable(),
    lightElevation = $bindable(),
  } = $props<any>();
</script>

<div class="settings-panel">
  <div class="settings-group">
    <h3>Performance</h3>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px;">
      Max FPS: {maxFps === 0 ? "Uncapped" : maxFps}
      <select bind:value={maxFps} class="dropdown">
        <option value={0}>Uncapped</option>
        <option value={120}>120 FPS</option>
        <option value={60}>60 FPS</option>
        <option value={30}>30 FPS</option>
        <option value={15}>15 FPS</option>
      </select>
    </label>
  </div>

  <div class="settings-group">
    <h3>Lighting & Exposure</h3>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Tone Mapping Exposure: {toneExposure.toFixed(1)}
      <input type="range" class="slider" min="0" max="5" step="0.1" bind:value={toneExposure} />
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Ambient Light Intensity: {ambientIntensity.toFixed(1)}
      <input type="range" class="slider" min="0" max="2" step="0.1" bind:value={ambientIntensity} />
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Directional Light Intensity: {dirIntensity.toFixed(1)}
      <input type="range" class="slider" min="0" max="5" step="0.1" bind:value={dirIntensity} />
    </label>
  </div>

  <div class="settings-group">
    <h3>Sun Positioning</h3>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Azimuth (Rotation): {Math.round(lightAzimuth)}°
      <input type="range" class="slider" min="-180" max="180" step="1" bind:value={lightAzimuth} />
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Elevation (Height): {Math.round(lightElevation)}°
      <input type="range" class="slider" min="0" max="90" step="1" bind:value={lightElevation} />
    </label>
  </div>

  <div class="settings-group">
    <h3>Shadows</h3>
    <label style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
      <span style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" bind:checked={shadowsEnabled} onchange={saveGraphicsPreferences} /> Enable Shadows
      </span>
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Shadow Map Resolution
      <select bind:value={shadowMapSize} onchange={saveGraphicsPreferences} class="dropdown">
        <option value={512}>512x512</option>
        <option value={1024}>1024x1024</option>
        <option value={2048}>2048x2048 (Default)</option>
        <option value={4096}>4096x4096</option>
      </select>
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Shadow Type
      <select bind:value={shadowMapType} onchange={saveGraphicsPreferences} class="dropdown">
        <option value="Basic">Basic (Fastest)</option>
        <option value="PCF">PCF (Simple Filter)</option>
        <option value="PCFSoft">PCF Soft (Good Default)</option>
        <option value="VSM">VSM (Variance Soft)</option>
      </select>
    </label>
  </div>

  <div class="settings-group">
    <h3>Quality & Textures</h3>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Render Resolution Scale: {Math.round(renderScale * 100)}%
      <input
        type="range"
        class="slider"
        min="0.1"
        max="2.0"
        step="0.1"
        bind:value={renderScale}
        onchange={saveGraphicsPreferences}
      />
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Anisotropic Filtering: {anisotropy}x
      <select bind:value={anisotropy} onchange={saveGraphicsPreferences} class="dropdown">
        <option value={1}>1x (Off)</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
        <option value={8}>8x</option>
        <option value={16}>16x (Max Quality)</option>
      </select>
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Tone Mapping Algorithm
      <select bind:value={toneMapping} onchange={saveGraphicsPreferences} class="dropdown">
        <option value="ACESFilmic">ACES Filmic (Cinematic)</option>
        <option value="AgX">AgX (Filmic V2)</option>
        <option value="Reinhard">Reinhard (Flatter HDR)</option>
        <option value="Linear">Linear (Raw)</option>
      </select>
    </label>
    <label style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%;">
      Global Environment Reflection Intensity: {envMapIntensity.toFixed(1)}
      <input
        type="range"
        class="slider"
        min="0.0"
        max="3.0"
        step="0.1"
        bind:value={envMapIntensity}
        onchange={saveGraphicsPreferences}
      />
    </label>
  </div>
</div>
