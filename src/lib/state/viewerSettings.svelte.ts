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
  // Phase 2: which pipeline builds the viewport scene — "legacy" (Three.js
  // USDLoader over the packed zip) or "rust" (manifest from the composed
  // stage). Switching reloads the open scene through the selected backend.
  renderBackend: "legacy" as "legacy" | "rust",
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
      renderBackend: viewerSettings.renderBackend,
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
      if (parsed.renderBackend === "rust" || parsed.renderBackend === "legacy")
        viewerSettings.renderBackend = parsed.renderBackend;
    } catch (e) {
      console.warn("Failed to load graphics preferences", e);
    }
  }
}
