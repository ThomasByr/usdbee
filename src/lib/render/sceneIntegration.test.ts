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
});
