// posePrefetch tests: the playback look-ahead buffer. Pure module — no mocks,
// no IPC; the batch fetch itself lives in renderState.

import { beforeEach, describe, expect, it } from "vitest";
import {
  POSE_PREFETCH,
  claimPoseBatch,
  invalidatePoseBuffer,
  poseCoverage,
  settlePoseBatch,
  takePose,
} from "./posePrefetch";
import type { AnimatedPose } from "./sceneBuilder";

function pose(tag: number): AnimatedPose {
  return { manifest: [{ path: `/${tag}` }] as never, prefetched: new Map() };
}

function poses(count: number, from = 0): AnimatedPose[] {
  return Array.from({ length: count }, (_, i) => pose(from + i));
}

const CODES = Array.from({ length: 40 }, (_, i) => i);

// A claimed batch settled with one pose per requested code.
function fillAt(code: number) {
  const claimed = claimPoseBatch(CODES, code)!;
  settlePoseBatch(claimed, poses(claimed.times.length));
  return claimed;
}

beforeEach(() => {
  invalidatePoseBuffer();
});

describe("the look-ahead buffer", () => {
  it("returns nothing before any batch landed", () => {
    expect(takePose(1)).toBeNull();
    expect(poseCoverage(0)).toBe(0);
  });

  it("takes a settled pose once and no more", () => {
    fillAt(0);

    expect(takePose(1)).not.toBeNull();
    expect(takePose(1)).toBeNull();
  });

  it("claims the next K codes after the playhead, never the playhead itself", () => {
    expect(claimPoseBatch(CODES, 0)!.times).toEqual(CODES.slice(1, 1 + POSE_PREFETCH));
  });

  it("clamps the request at the stage's last code instead of wrapping", () => {
    expect(claimPoseBatch(CODES, 37)!.times).toEqual([38, 39]);
  });

  it("claims nothing from the last code, an unauthored code, or an empty list", () => {
    expect(claimPoseBatch(CODES, 39)).toBeNull();
    expect(claimPoseBatch(CODES, 1.5)).toBeNull();
    expect(claimPoseBatch([], 0)).toBeNull();
  });

  it("counts only the codes ahead of the playhead", () => {
    fillAt(0); // 1..12 buffered
    expect(poseCoverage(0)).toBe(POSE_PREFETCH);
    expect(poseCoverage(6)).toBe(6);
    expect(poseCoverage(12)).toBe(0);
  });

  it("never holds more than K codes of coverage", () => {
    fillAt(0);
    expect(poseCoverage(0)).toBe(POSE_PREFETCH);
    // A partly consumed window re-claims; the new window stays K wide.
    for (let code = 1; code <= 7; code++) takePose(code);
    fillAt(7);
    expect(poseCoverage(7)).toBe(POSE_PREFETCH);
    expect(poseCoverage(0)).toBeLessThanOrEqual(POSE_PREFETCH);
  });

  it("keeps one batch in flight at a time", () => {
    const claimed = claimPoseBatch(CODES, 0);
    expect(claimed).not.toBeNull();
    expect(claimPoseBatch(CODES, 0)).toBeNull();

    settlePoseBatch(claimed!, poses(claimed!.times.length));
    invalidatePoseBuffer();
    expect(claimPoseBatch(CODES, 0)).not.toBeNull();
  });

  it("refills only below half the look-ahead", () => {
    fillAt(0); // 1..12 buffered, playhead 0
    for (let code = 1; code <= 6; code++) takePose(code); // coverage(6) = 6
    expect(poseCoverage(6)).toBe(POSE_PREFETCH / 2);
    expect(claimPoseBatch(CODES, 6)).toBeNull();

    takePose(7); // coverage(7) = 5
    expect(claimPoseBatch(CODES, 7)).not.toBeNull();
  });

  it("replaces the window on fill so nothing behind the playhead lingers", () => {
    fillAt(0); // 1..12
    const claimed = claimPoseBatch(CODES, 20)!;
    settlePoseBatch(claimed, poses(claimed.times.length));

    expect(poseCoverage(20)).toBe(POSE_PREFETCH);
    expect(takePose(1)).toBeNull();
    expect(takePose(21)).not.toBeNull();
  });

  it("drops a batch that arrives after invalidation", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    invalidatePoseBuffer();
    settlePoseBatch(claimed, poses(claimed.times.length));

    expect(takePose(1)).toBeNull();
    expect(poseCoverage(0)).toBe(0);
  });

  it("clears the window on invalidation", () => {
    fillAt(0);
    invalidatePoseBuffer();

    expect(poseCoverage(0)).toBe(0);
    expect(takePose(1)).toBeNull();
  });

  it("stops retrying after a failed batch until the next generation", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    settlePoseBatch(claimed, null);

    // No hammering one invoke per frame while the batch path is broken.
    expect(claimPoseBatch(CODES, 0)).toBeNull();

    invalidatePoseBuffer();
    expect(claimPoseBatch(CODES, 0)).not.toBeNull();
  });
});
