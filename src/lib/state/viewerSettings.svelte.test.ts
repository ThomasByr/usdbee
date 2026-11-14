// @vitest-environment happy-dom
// The graphics blob is the only place a rendering setting survives a restart:
// a key that is not written here resets on every launch.

import { beforeEach, describe, expect, it } from "vitest";
import { loadGraphicsPreferences, saveGraphicsPreferences, viewerSettings } from "./viewerSettings.svelte";

beforeEach(() => {
  localStorage.clear();
  viewerSettings.lightingSource = "auto";
  viewerSettings.sceneLightScale = 1;
});

describe("graphics preferences", () => {
  it("round-trips the lighting source and the scene light scale", () => {
    viewerSettings.lightingSource = "scene";
    viewerSettings.sceneLightScale = 2.5;
    saveGraphicsPreferences();

    viewerSettings.lightingSource = "auto";
    viewerSettings.sceneLightScale = 1;
    loadGraphicsPreferences();

    expect(viewerSettings.lightingSource).toBe("scene");
    expect(viewerSettings.sceneLightScale).toBe(2.5);
  });

  it("keeps the defaults when an older blob carries no lighting keys", () => {
    localStorage.setItem("usdbee_graphics", JSON.stringify({ shadowsEnabled: false }));

    loadGraphicsPreferences();

    expect(viewerSettings.lightingSource).toBe("auto");
    expect(viewerSettings.sceneLightScale).toBe(1);
    viewerSettings.shadowsEnabled = true;
  });
});
