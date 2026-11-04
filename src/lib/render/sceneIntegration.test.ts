// sceneIntegration tests: the playback driver gate — autoplay must not
// advance the playhead while a scene load is in flight, or the pose the
// scene centers on would depend on how long the load took.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import { invoke } from "@tauri-apps/api/core";
import { installPlaybackDriver } from "./sceneIntegration";
import { renderState } from "./renderState.svelte";
import { stageState } from "../stage/stageState.svelte";
import type { RendererKit } from "../three/RendererKit.svelte";

const mockedInvoke = vi.mocked(invoke);

function viewer(): RendererKit {
  return { animationProgress: 0 } as unknown as RendererKit;
}

beforeEach(() => {
  mockedInvoke.mockReset();
  renderState.time = null;
  renderState.status = "idle";
  renderState.timeCodes = [];
  stageState.stageInfo = {
    start_time_code: 0,
    end_time_code: 24,
    time_codes_per_second: 24,
  } as any;
});

describe("installPlaybackDriver", () => {
  it("does not advance time while the render state is loading", () => {
    renderState.time = 0;
    renderState.status = "loading";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0.5);

    expect(renderState.time).toBe(0);
    expect(v.animationProgress).toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("advances normally once the status is ready again", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0.05);

    expect(renderState.time).toBeCloseTo(1.2, 10);
    expect(v.animationProgress).toBeCloseTo(1.2, 10);
  });

  it("caps a single huge delta (main-thread stall) at 0.1 s of advance", () => {
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 240,
      time_codes_per_second: 24,
    } as any;
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    // 5 s stall at 24 tcps would be 120 codes unclamped.
    v.onAdvanceTime!(5);

    expect(renderState.time).toBeLessThanOrEqual(0.1 * 24);
  });

  it("still accumulates repeated small deltas normally", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeCloseTo(10 / 60 * 24, 5);
  });

  it("advances past the first authored code under exact small deltas (stall regression)", () => {
    // Regression: advancing from the ALREADY-SNAPPED time re-snaps to the
    // same authored code every frame — 30 tcps at 60 Hz advances 0.5
    // codes, then snapping eats the sub-code delta, so playback stalls.
    // Real rAF deltas are irregular, which is why this only failed on
    // exact-delta displays.
    renderState.timeCodes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 8,
      time_codes_per_second: 30,
    } as any;
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeGreaterThan(1);
  });

  it("continues from an externally scrubbed time, not a stale playhead", () => {
    // The driver keeps its own continuous playhead; any external write of
    // renderState.time (scrub slider, new load) must be adopted on the
    // very next frame so the two never diverge.
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(1 / 60); // the driver now holds a stale playhead
    void renderState.setStageTime(10); // simulated scrub
    v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeGreaterThan(10);
  });
});
