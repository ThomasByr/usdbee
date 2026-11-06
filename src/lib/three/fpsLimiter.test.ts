// The maxFps gate as a pure decision over a sampled clock: the pacing can be
// simulated at any tick pattern without a renderer.

import { describe, expect, it } from "vitest";
import { FPS_EPSILON_MS, nextFrameTime, shouldRenderFrame } from "./fpsLimiter";

const INTERVAL_60 = 1000 / 60; // 16.667 ms

// Drives a tick sequence through the gate exactly like the frame loop does and
// returns the timestamps that would reach the renderer.
function simulate(ticks: number[], interval: number): { renders: number[]; anchor: number } {
  const renders: number[] = [];
  let anchor = 0;
  for (const now of ticks) {
    if (!shouldRenderFrame(now, anchor, interval)) continue;
    renders.push(now);
    anchor = nextFrameTime(now, anchor, interval);
  }
  return { renders, anchor };
}

function ticks(stepMs: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * stepMs);
}

// Renders per ms, so two halves of a run can be compared.
function rate(renders: number[], fromMs: number, toMs: number): number {
  const n = renders.filter((t) => t > fromMs && t <= toMs).length;
  return n / (toMs - fromMs);
}

describe("shouldRenderFrame", () => {
  it("renders every tick of a steady 60 Hz callback stream", () => {
    const { renders } = simulate(ticks(16.7, 120), INTERVAL_60);
    expect(renders).toHaveLength(120);
  });

  it("renders every tick when the callback is already slower than the cap", () => {
    // 20 ms callbacks on a 60 fps cap: the cap cannot slow a 50 fps stream.
    const { renders } = simulate(ticks(20, 120), INTERVAL_60);
    expect(renders).toHaveLength(120);
  });

  it("skips and renders in a fixed pattern on a 144 Hz callback stream", () => {
    // 144 Hz callbacks, maxFps 60: roughly two of three callbacks are skipped.
    const { renders } = simulate(ticks(6.9, 600), INTERVAL_60);
    expect(renders.length).toBeGreaterThan(200);
    expect(renders.length).toBeLessThan(300);
  });

  it("keeps the render cadence from drifting", () => {
    // The skipped callbacks must not accumulate phase error: the second half
    // of a 16.5 s run renders at the same rate as the first half, and the
    // anchor stays on the interval grid.
    const totalMs = 16560;
    const { renders, anchor } = simulate(ticks(6.9, 2400), INTERVAL_60);
    const firstHalf = rate(renders, 0, totalMs / 2);
    const secondHalf = rate(renders, totalMs / 2, totalMs);
    expect(secondHalf / firstHalf).toBeCloseTo(1, 2);
    expect(Math.abs(anchor / INTERVAL_60 - Math.round(anchor / INTERVAL_60))).toBeLessThan(1e-6);
  });

  it("renders the next tick after a single late callback", () => {
    // One 33 ms gap must not cost a second render: a late frame already paid
    // the interval, and the following tick starts a fresh one.
    const { renders } = simulate([16.7, 33.4, 50.1, 66.8, 83.5], INTERVAL_60);
    expect(renders).toEqual([16.7, 33.4, 50.1, 66.8, 83.5]);
  });

  it("tolerates a callback landing just under the interval", () => {
    const justUnder = INTERVAL_60 - FPS_EPSILON_MS - 0.5;
    const justOver = INTERVAL_60 - FPS_EPSILON_MS + 0.5;
    expect(shouldRenderFrame(justUnder, 0, INTERVAL_60)).toBe(false);
    expect(shouldRenderFrame(justOver, 0, INTERVAL_60)).toBe(true);
    expect(shouldRenderFrame(INTERVAL_60 - FPS_EPSILON_MS, 0, INTERVAL_60)).toBe(true);
  });

  it("does not render on a clock that went backwards", () => {
    expect(shouldRenderFrame(90, 100, INTERVAL_60)).toBe(false);
  });
});

describe("nextFrameTime", () => {
  it("anchors on the interval grid, not on the callback time", () => {
    // `anchor = now` would drift by the sub-interval part of every render; the
    // anchor must stay a whole number of intervals from the previous one.
    expect(nextFrameTime(16.7, 0, INTERVAL_60)).toBeCloseTo(INTERVAL_60, 6);
    expect(nextFrameTime(20.7, 0, INTERVAL_60)).toBeCloseTo(INTERVAL_60, 6);
    expect(nextFrameTime(34.5, 16.666666666666668, INTERVAL_60)).toBeCloseTo(2 * INTERVAL_60, 6);
  });

  it("does not advance inside the epsilon window", () => {
    // A render that fires one millisecond early keeps the anchor where it was,
    // so the next render is not pushed a whole interval later.
    const early = INTERVAL_60 - FPS_EPSILON_MS + 0.5;
    expect(nextFrameTime(early, 0, INTERVAL_60)).toBe(0);
  });
});
