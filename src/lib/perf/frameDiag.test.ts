// frameDiag unit tests: the ring buffers, the percentiles and the pure
// pacing helpers behind window.__usdbeePerf.

import { beforeEach, describe, expect, it } from "vitest";
import {
  FRAMES,
  codeIndex,
  droppedBetween,
  expectedIntervalMs,
  onPose,
  onPoseApplied,
  onRaf,
  onRender,
  onPoseResync,
  onThrottled,
  percentile,
  reset,
  setRate,
  snapshot,
} from "./frameDiag";

beforeEach(() => reset());

describe("expectedIntervalMs", () => {
  it("derives the pose interval from the stage rate", () => {
    expect(expectedIntervalMs(24)).toBeCloseTo(41.6667, 3);
    expect(expectedIntervalMs(23.976)).toBeCloseTo(41.71, 2);
    expect(expectedIntervalMs(30)).toBeCloseTo(33.3333, 3);
  });

  it("reports 0 for a missing rate instead of Infinity", () => {
    expect(expectedIntervalMs(0)).toBe(0);
    expect(expectedIntervalMs(-24)).toBe(0);
  });
});

describe("percentile", () => {
  it("takes nearest-rank percentiles of a sorted array", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile([4, 4, 4], 0.5)).toBe(4);
  });
});

describe("codeIndex", () => {
  it("binary-searches an authored code", () => {
    const codes = [0, 1, 2, 3, 4, 5];
    expect(codeIndex(codes, 0)).toBe(0);
    expect(codeIndex(codes, 4)).toBe(4);
    expect(codeIndex(codes, 5)).toBe(5);
  });

  it("reports -1 when the code is not authored", () => {
    expect(codeIndex([0, 1, 2], 2.5)).toBe(-1);
    expect(codeIndex([], 1)).toBe(-1);
  });
});

describe("droppedBetween", () => {
  it("counts the authored codes strictly between two indices", () => {
    expect(droppedBetween(0, 1)).toBe(0);
    expect(droppedBetween(0, 4)).toBe(3);
    expect(droppedBetween(3, 3)).toBe(0);
  });

  it("does not treat a loop restart or backwards scrub as drops", () => {
    expect(droppedBetween(239, 0)).toBe(0);
    expect(droppedBetween(10, 4)).toBe(0);
  });
});

describe("frame ring buffers", () => {
  it("keeps only the newest intervals once the ring wraps", () => {
    onRaf(1);
    for (let i = 0; i < FRAMES; i++) onRaf(1 + (i + 1) * 10);
    expect(snapshot().rafN).toBe(FRAMES);
    expect(snapshot().rafMax).toBe(10);

    // The evicting write keeps its own value: max, not the oldest sample.
    onRaf(1 + FRAMES * 10 + 100);
    const s = snapshot();
    expect(s.rafN).toBe(FRAMES);
    expect(s.rafMax).toBe(100);
    expect(s.rafP50).toBe(10);
    expect(s.rafP95).toBe(10);
  });

  it("ignores the zero timestamp the loop passes off the rAF path", () => {
    onRaf(0);
    onRaf(1000);
    onRaf(1016);
    const s = snapshot();
    expect(s.rafN).toBe(1);
    expect(s.rafMax).toBe(16);
  });

  it("counts the throttled frames apart from the rendered ones", () => {
    onThrottled();
    onThrottled();
    onRender(1000);
    onRender(1016.7);
    onRender(1033.4);
    const s = snapshot();
    expect(s.throttled).toBe(2);
    expect(s.renderN).toBe(2);
    expect(s.renderP50).toBeCloseTo(16.7, 5);
    expect(s.renderFps).toBeCloseTo(59.88, 2);
  });

  it("records a fixed amount of storage however many frames arrive", () => {
    const keys = Object.keys(snapshot()).sort();
    for (let i = 0; i < 5000; i++) onRaf(1000 + i * 16);
    const s = snapshot();
    expect(s.rafN).toBe(FRAMES);
    expect(Object.keys(s).sort()).toEqual(keys);
  });
});

describe("pose pacing", () => {
  it("records the gap between distinct codes and counts the skipped ones", () => {
    setRate(24);
    onPose(0, 0);
    onPose(41.7, 1);
    onPose(91.7, 3); // code at index 2 never reached the screen
    const s = snapshot();
    expect(s.poseN).toBe(2);
    expect(s.poseP50).toBeCloseTo(41.7, 5);
    expect(s.poseMax).toBe(50);
    expect(s.droppedCodes).toBe(1);
    expect(s.tcps).toBe(24);
    expect(s.expectedPoseMs).toBeCloseTo(41.67, 2);
  });

  it("does not count a loop restart as dropped codes", () => {
    onPose(0, 47);
    onPose(41.7, 0);
    expect(snapshot().droppedCodes).toBe(0);
  });

  it("does not record a pause as a pose gap", () => {
    onPose(0, 0);
    onPose(41.7, 1);
    // 3 s paused, then playback resumes: the present after the resume must
    // not inherit the pause as one inter-pose interval.
    onPoseResync();
    onPose(3041.7, 2);
    const s = snapshot();
    expect(s.poseN).toBe(1);
    expect(s.poseMax).toBe(41.7);
  });

  it("keeps the gap but judges no codes when the stage has none", () => {
    onPose(0, -1);
    onPose(41.7, -1);
    const s = snapshot();
    expect(s.poseN).toBe(1);
    expect(s.droppedCodes).toBe(0);
  });

  it("records the pose apply cost", () => {
    onPoseApplied(1.5);
    onPoseApplied(2.5);
    onPoseApplied(9);
    const s = snapshot();
    expect(s.applyN).toBe(3);
    expect(s.applyP50).toBe(2.5);
    expect(s.applyMax).toBe(9);
  });
});

describe("snapshot", () => {
  const KEYS = [
    "applyMax",
    "applyN",
    "applyP50",
    "applyP95",
    "droppedCodes",
    "expectedPoseMs",
    "poseMax",
    "poseN",
    "poseP50",
    "poseP95",
    "rafFps",
    "rafMax",
    "rafN",
    "rafP50",
    "rafP95",
    "renderFps",
    "renderMax",
    "renderN",
    "renderP50",
    "renderP95",
    "tcps",
    "throttled",
  ];

  it("has a stable, plain JSON-able shape", () => {
    const empty = snapshot();
    expect(Object.keys(empty).sort()).toEqual(KEYS);
    expect(empty.rafN).toBe(0);
    expect(empty.rafP50).toBe(0);

    onRaf(1);
    onRaf(17);
    onPose(0, 0);
    onPose(41.7, 1);
    onPoseApplied(3);
    expect(Object.keys(snapshot()).sort()).toEqual(KEYS);
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty);
  });

  it("clears every stream on reset", () => {
    onRaf(1);
    onRaf(17);
    onThrottled();
    onPose(0, 0);
    onPose(41.7, 3);
    onPoseApplied(4);
    reset();
    const s = snapshot();
    expect(s.rafN).toBe(0);
    expect(s.throttled).toBe(0);
    expect(s.poseN).toBe(0);
    expect(s.droppedCodes).toBe(0);
    expect(s.applyN).toBe(0);
  });

  it("keeps the stage rate across a reset, so a reset while paused still reports it", () => {
    // The rate is a stage property, not a measurement: reset happens
    // mid-session (a reset-then-play run never resyncs the driver).
    setRate(24);
    onPose(0, 0);
    reset();
    const s = snapshot();
    expect(s.tcps).toBe(24);
    expect(s.expectedPoseMs).toBeCloseTo(41.67, 2);
    expect(s.poseN).toBe(0);
  });
});
