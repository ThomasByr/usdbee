// posePrefetch tests: the playback look-ahead buffer. Pure module — no mocks,
// no IPC; the batch fetch itself lives in renderState.

import { beforeEach, describe, expect, it } from "vitest";
import {
  POSE_PREFETCH,
  claimPoseBatch,
  holdsPoseStep,
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

  it("tops up as soon as one pose of the window is consumed", () => {
    fillAt(0); // 1..12 buffered, playhead 0
    expect(claimPoseBatch(CODES, 0)).toBeNull(); // full: nothing to fetch

    takePose(1);
    expect(poseCoverage(1)).toBe(POSE_PREFETCH - 1);
    expect(claimPoseBatch(CODES, 1)).not.toBeNull();
  });

  it("claims nothing while the top-up batch is in flight", () => {
    fillAt(0);
    takePose(1);
    const topUp = claimPoseBatch(CODES, 1);
    expect(topUp).not.toBeNull();

    takePose(2);
    expect(claimPoseBatch(CODES, 2)).toBeNull();

    settlePoseBatch(topUp!, poses(topUp!.times.length));
  });

  it("stops re-claiming a tail window the buffer already holds", () => {
    fillAt(37); // 38,39 — a short window at the stage's end
    expect(poseCoverage(37)).toBe(2);

    expect(claimPoseBatch(CODES, 37)).toBeNull();
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

  it("keeps prefetching in the new generation after a stale batch fails", () => {
    const stale = claimPoseBatch(CODES, 0)!;
    // A scrub / stage switch while that batch is still in flight.
    invalidatePoseBuffer();
    const fresh = claimPoseBatch(CODES, 0)!;
    settlePoseBatch(fresh, poses(fresh.times.length)); // window 1..12

    // The pre-scrub batch rejects late: its failure belongs to the old epoch.
    settlePoseBatch(stale, null);
    expect(poseCoverage(0)).toBe(POSE_PREFETCH);

    for (let code = 1; code <= 7; code++) takePose(code); // coverage 5
    expect(claimPoseBatch(CODES, 7)).not.toBeNull();
  });
});

describe("holding a playback step on a miss", () => {
  it("holds while a batch is in flight", () => {
    claimPoseBatch(CODES, 0); // in flight, nothing buffered yet
    expect(holdsPoseStep(CODES, 5)).toBe(true);
  });

  it("holds for a code a fresh claim can still cover", () => {
    // No batch in flight: the driver claims on this very frame.
    expect(holdsPoseStep(CODES, 20)).toBe(true);
  });

  it("does not hold for a pose already in hand", () => {
    fillAt(0);
    expect(holdsPoseStep(CODES, 5)).toBe(false);
  });

  it("does not hold without authored codes (nothing to claim)", () => {
    expect(holdsPoseStep([], 5)).toBe(false);
  });

  it("does not hold once the batch path failed for this generation", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    settlePoseBatch(claimed, null);

    expect(holdsPoseStep(CODES, 5)).toBe(false);
  });

  it("does not hold for an unauthored code, and re-arms after an invalidation", () => {
    expect(holdsPoseStep(CODES, 1.5)).toBe(false);

    fillAt(0);
    invalidatePoseBuffer();
    expect(holdsPoseStep(CODES, 5)).toBe(true);
  });
});
