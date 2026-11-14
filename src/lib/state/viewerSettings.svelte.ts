export const viewerSettings = $state({
  maxFps: 60, // 0 = Uncapped
  toneExposure: 0.4,
  ambientIntensity: 0.4,
  dirIntensity: 2.0,
  shadowsEnabled: true,
  renderScale: 1.0,
  shadowMapSize: 2048,
  shadowMapType: "PCFSoft",
  anisotropy: 8,
  envMapIntensity: 1.0,
  toneMapping: "ACESFilmic",
  // F4: "auto" lights a stage from its own light prims when it has any and
  // falls back to the studio rig otherwise; "scene" never falls back (dark if
  // the stage authors no light); "studio" always keeps the rig.
  lightingSource: "auto" as "auto" | "scene" | "studio",
  sceneLightScale: 1.0,
});

export function saveGraphicsPreferences() {
  localStorage.setItem(
    "usdbee_graphics",
    JSON.stringify({
      shadowsEnabled: viewerSettings.shadowsEnabled,
      renderScale: viewerSettings.renderScale,
      shadowMapSize: viewerSettings.shadowMapSize,
      shadowMapType: viewerSettings.shadowMapType,
      anisotropy: viewerSettings.anisotropy,
      envMapIntensity: viewerSettings.envMapIntensity,
      toneMapping: viewerSettings.toneMapping,
      lightingSource: viewerSettings.lightingSource,
      sceneLightScale: viewerSettings.sceneLightScale,
    }),
  );
}

export function loadGraphicsPreferences() {
  const savedGraphics = localStorage.getItem("usdbee_graphics");
  if (savedGraphics) {
    try {
      const parsed = JSON.parse(savedGraphics);
      if (parsed.shadowsEnabled !== undefined) viewerSettings.shadowsEnabled = parsed.shadowsEnabled;
      if (parsed.renderScale !== undefined) viewerSettings.renderScale = parsed.renderScale;
      if (parsed.shadowMapSize !== undefined) viewerSettings.shadowMapSize = parsed.shadowMapSize;
      if (parsed.shadowMapType !== undefined) viewerSettings.shadowMapType = parsed.shadowMapType;
      if (parsed.anisotropy !== undefined) viewerSettings.anisotropy = parsed.anisotropy;
      if (parsed.envMapIntensity !== undefined) viewerSettings.envMapIntensity = parsed.envMapIntensity;
      if (parsed.toneMapping !== undefined) viewerSettings.toneMapping = parsed.toneMapping;
      if (parsed.lightingSource !== undefined) viewerSettings.lightingSource = parsed.lightingSource;
      if (parsed.sceneLightScale !== undefined) viewerSettings.sceneLightScale = parsed.sceneLightScale;
    } catch (e) {
      console.warn("Failed to load graphics preferences", e);
    }
  }
}
