// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MediaQueryListener = (event: { matches: boolean }) => void;

function stubMatchMedia(startsLight: boolean) {
  const listeners = new Set<MediaQueryListener>();
  const query = {
    matches: startsLight,
    addEventListener: (_type: string, cb: MediaQueryListener) => listeners.add(cb),
    removeEventListener: (_type: string, cb: MediaQueryListener) => listeners.delete(cb),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    emitSystemPrefersLight(matches: boolean) {
      query.matches = matches;
      listeners.forEach((cb) => cb({ matches }));
    },
  };
}

// Runes modules hold module-level $state; reset modules so each test gets a
// fresh store instead of leaking preferences between tests.
async function freshThemeModule() {
  vi.resetModules();
  return await import("./themeState.svelte");
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("themeState", () => {
  it("defaults to system and resolves dark when the OS prefers dark", async () => {
    stubMatchMedia(false);
    const { themeState, initTheme } = await freshThemeModule();

    const cleanup = initTheme();

    expect(themeState.preference).toBe("system");
    expect(themeState.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    cleanup();
  });

  it("resolves light when the OS prefers light", async () => {
    stubMatchMedia(true);
    const { themeState, initTheme } = await freshThemeModule();

    const cleanup = initTheme();

    expect(themeState.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    cleanup();
  });

  it("falls back to system for a missing stored value", async () => {
    stubMatchMedia(true);
    const { themeState, initTheme } = await freshThemeModule();

    const cleanup = initTheme();

    expect(localStorage.getItem("usdbee_theme")).toBeNull();
    expect(themeState.preference).toBe("system");
    expect(themeState.resolved).toBe("light");
    cleanup();
  });

  it("falls back to system for an invalid stored value (migration-safe load)", async () => {
    localStorage.setItem("usdbee_theme", "neon-pink");
    stubMatchMedia(false);
    const { themeState, initTheme } = await freshThemeModule();

    const cleanup = initTheme();

    expect(themeState.preference).toBe("system");
    expect(themeState.resolved).toBe("dark");
    cleanup();
  });

  it("loads a valid stored preference and applies it over the OS scheme", async () => {
    localStorage.setItem("usdbee_theme", "dark");
    stubMatchMedia(true);
    const { themeState, initTheme } = await freshThemeModule();

    const cleanup = initTheme();

    expect(themeState.preference).toBe("dark");
    expect(themeState.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    cleanup();
  });

  it("follows OS scheme changes while preference is system", async () => {
    const media = stubMatchMedia(false);
    const { themeState, initTheme } = await freshThemeModule();
    const cleanup = initTheme();

    media.emitSystemPrefersLight(true);

    expect(themeState.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    cleanup();
  });

  it("ignores OS scheme changes when an explicit preference is set", async () => {
    localStorage.setItem("usdbee_theme", "dark");
    const media = stubMatchMedia(false);
    const { themeState, initTheme } = await freshThemeModule();
    const cleanup = initTheme();

    media.emitSystemPrefersLight(true);

    expect(themeState.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    cleanup();
  });

  it("persists explicit preference changes and applies them immediately", async () => {
    stubMatchMedia(false);
    const { themeState, setThemePreference } = await freshThemeModule();

    setThemePreference("light");

    expect(localStorage.getItem("usdbee_theme")).toBe("light");
    expect(themeState.preference).toBe("light");
    expect(themeState.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
