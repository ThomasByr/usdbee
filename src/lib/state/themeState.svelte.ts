export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "usdbee_theme";
const MEDIA_QUERY = "(prefers-color-scheme: light)";
const VALID_PREFERENCES: ThemePreference[] = ["system", "dark", "light"];

export const themeState = $state({
  preference: "system" as ThemePreference,
  resolved: "dark" as ResolvedTheme,
});

function systemTheme(): ResolvedTheme {
  return window.matchMedia(MEDIA_QUERY).matches ? "light" : "dark";
}

function resolvePreference(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function applyResolvedTheme() {
  document.documentElement.dataset.theme = themeState.resolved;
}

export function setThemePreference(preference: ThemePreference) {
  themeState.preference = preference;
  themeState.resolved = resolvePreference(preference);
  applyResolvedTheme();
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch (e) {
    console.warn("Failed to persist theme preference", e);
  }
}

// Loads the stored preference (migration-safe: a missing, invalid or corrupt
// value keeps the "system" default), applies it, and tracks OS scheme changes
// while the preference is "system". Returns a cleanup function.
export function initTheme(): () => void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    console.warn("Failed to read theme preference", e);
  }
  const preference = VALID_PREFERENCES.includes(stored as ThemePreference)
    ? (stored as ThemePreference)
    : "system";

  themeState.preference = preference;
  themeState.resolved = resolvePreference(preference);
  applyResolvedTheme();

  const onSystemChange = () => {
    if (themeState.preference !== "system") return;
    themeState.resolved = systemTheme();
    applyResolvedTheme();
  };
  window.matchMedia(MEDIA_QUERY).addEventListener("change", onSystemChange);
  return () => window.matchMedia(MEDIA_QUERY).removeEventListener("change", onSystemChange);
}
