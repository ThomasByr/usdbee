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

    v.onAdvanceTime!(0.5);

    expect(renderState.time).toBe(12);
    expect(v.animationProgress).toBe(12);
  });
});
