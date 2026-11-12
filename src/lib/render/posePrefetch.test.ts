// posePrefetch tests: the playback look-ahead buffer. Pure module — no mocks,
// no IPC; the batch fetch itself lives in renderState.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POSE_HOLD_DEADLINE_MS,
  POSE_PREFETCH,
  claimPoseBatch,
  holeQueryTime,
  holdsPoseStep,
  invalidatePoseBuffer,
  isPrefetchDead,
  poseBufferAnchoredAt,
  poseCoverage,
  setHoldClockForTests,
  settlePoseBatch,
  takePose,
} from "./posePrefetch";
import { snapshot as diagSnapshot } from "../perf/frameDiag";
import { encodePoseBatch, encodePoseFrame, emptyPoseBatch } from "./poseFrameFixture";
import type { AnimatedPose } from "./sceneBuilder";

// Raw frame bytes per buffered code — the buffer stores undecoded frames and
// takePose decodes one per pose (C5). One node at /<tag> is enough: the
// tests only read the decoded manifest back for identity.
function frame(tag: number): ArrayBuffer {
  return encodePoseFrame([{ path: `/${tag}` }], emptyPoseBatch());
}

// One settled batch: `count` frames, the i-th carrying path /<from + i>.
function frames(count: number, from = 0): ArrayBuffer {
  return encodePoseBatch(Array.from({ length: count }, (_, i) => frame(from + i)));
}

const CODES = Array.from({ length: 40 }, (_, i) => i);

// The bike stage's shape: 0..3 dense, then a 37-code hole up to 40..42.
const SPARSE = [0, 1, 2, 3, 40, 41, 42];

// A claimed batch settled with one pose per requested code. Every test that
// claims also settles: the in-flight guard is global and only a settle (or a
// wedged invoke) releases it, so a leftover claim would starve the next test.
function fillAt(code: number, codes: readonly number[] = CODES, tcps = 0) {
  const claimed = claimPoseBatch(codes, code, tcps)!;
  settlePoseBatch(claimed, frames(claimed.times.length));
  return claimed;
}

function settleAll(claimed: ReturnType<typeof claimPoseBatch>) {
  settlePoseBatch(claimed!, frames(claimed!.times.length));
}

// --- Cold-start seed ---------------------------------------------------

describe("the window's anchor", () => {
  it("remembers the code the window was claimed from", () => {
    fillAt(5);

    expect(poseBufferAnchoredAt(5)).toBe(true);
    expect(poseBufferAnchoredAt(6)).toBe(false);
  });

  it("forgets it when the window is invalidated", () => {
    fillAt(5);

    invalidatePoseBuffer();

    expect(poseBufferAnchoredAt(5)).toBe(false);
  });

  it("has none before the first claim", () => {
    expect(poseBufferAnchoredAt(0)).toBe(false);
    expect(poseBufferAnchoredAt(null)).toBe(false);
  });

  it("forgets it when the batch that claimed it failed", () => {
    const claimed = claimPoseBatch(CODES, 5)!;
    settlePoseBatch(claimed, null);

    // The anchor outliving the failure closes the only cheap retry: a resync
    // onto the same code skips the invalidation, so the epoch never bumps and
    // prefetch stays off for the rest of the session.
    expect(isPrefetchDead()).toBe(true);
    expect(poseBufferAnchoredAt(5)).toBe(false);
  });

  it("forgets it when the batch lands a desync instead of poses", () => {
    const claimed = claimPoseBatch(CODES, 5)!;
    settlePoseBatch(claimed, frames(1));

    expect(poseBufferAnchoredAt(5)).toBe(false);
  });
});

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
    const claimed = claimPoseBatch(CODES, 0)!;
    expect(claimed.times).toEqual(CODES.slice(1, 1 + POSE_PREFETCH));
    settleAll(claimed);
  });

  it("never claims a code the buffer already holds", () => {
    fillAt(0); // 1..12 held
    takePose(1);

    const claimed = claimPoseBatch(CODES, 1)!;
    expect(claimed.times).toEqual(CODES.slice(13, 13 + POSE_PREFETCH));
    settleAll(claimed);
  });

  it("clamps the request at the stage's last code instead of wrapping", () => {
    const claimed = claimPoseBatch(CODES, 37)!;
    expect(claimed.times).toEqual([38, 39]);
    settleAll(claimed);
  });

  it("claims nothing from the last code or an empty list", () => {
    expect(claimPoseBatch(CODES, 39)).toBeNull();
    expect(claimPoseBatch([], 0)).toBeNull();
  });

  it("counts only the codes ahead of the playhead", () => {
    fillAt(0); // 1..12 buffered
    expect(poseCoverage(0)).toBe(POSE_PREFETCH);
    expect(poseCoverage(6)).toBe(6);
    expect(poseCoverage(12)).toBe(0);
  });

  it("tops up to at most 2K - 1 codes of coverage", () => {
    fillAt(0);
    expect(poseCoverage(0)).toBe(POSE_PREFETCH);
    // A partly consumed window re-claims, but only the codes it does not hold:
    // what is still held plus K fetched ones, bounded by 2K - 1.
    for (let code = 1; code <= 7; code++) takePose(code);
    fillAt(7);
    expect(poseCoverage(7)).toBe(5 + POSE_PREFETCH);
    expect(poseCoverage(7)).toBeLessThanOrEqual(2 * POSE_PREFETCH - 1);
  });

  it("keeps one batch in flight at a time", () => {
    const claimed = claimPoseBatch(CODES, 0);
    expect(claimed).not.toBeNull();
    expect(claimPoseBatch(CODES, 0)).toBeNull();

    settlePoseBatch(claimed!, frames(claimed!.times.length));
    invalidatePoseBuffer();
    // The settle released the guard, so the new generation can claim.
    const fresh = claimPoseBatch(CODES, 0);
    expect(fresh).not.toBeNull();
    settleAll(fresh);
  });

  it("tops up as soon as one pose of the window is consumed", () => {
    fillAt(0); // 1..12 buffered, playhead 0
    expect(claimPoseBatch(CODES, 0)).toBeNull(); // full: nothing to fetch

    takePose(1);
    expect(poseCoverage(1)).toBe(POSE_PREFETCH - 1);
    // The 11 buffered codes are not re-transferred; the batch refills ahead.
    const claimed = claimPoseBatch(CODES, 1)!;
    expect(claimed.times).toEqual(CODES.slice(13, 13 + POSE_PREFETCH));
    settleAll(claimed);
  });

  it("claims nothing while the top-up batch is in flight", () => {
    fillAt(0);
    takePose(1);
    const topUp = claimPoseBatch(CODES, 1);
    expect(topUp).not.toBeNull();

    takePose(2);
    expect(claimPoseBatch(CODES, 2)).toBeNull();

    settlePoseBatch(topUp!, frames(topUp!.times.length));
  });

  it("claims nothing once every code at the stage's tail is held", () => {
    fillAt(37); // 38,39 — a short window at the stage's end
    expect(poseCoverage(37)).toBe(2);

    expect(claimPoseBatch(CODES, 37)).toBeNull();
  });

  it("drops the poses behind the playhead so nothing lingers", () => {
    fillAt(0); // 1..12
    const claimed = claimPoseBatch(CODES, 20)!;
    settlePoseBatch(claimed, frames(claimed.times.length));

    expect(poseCoverage(20)).toBe(POSE_PREFETCH);
    expect(takePose(1)).toBeNull();
    expect(takePose(21)).not.toBeNull();
  });

  it("drops a batch that arrives after invalidation", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    invalidatePoseBuffer();
    settlePoseBatch(claimed, frames(claimed.times.length));

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
    const fresh = claimPoseBatch(CODES, 0);
    expect(fresh).not.toBeNull();
    settleAll(fresh);
  });

  it("keeps prefetching in the new generation after a stale batch fails", () => {
    const stale = claimPoseBatch(CODES, 0)!;
    // A scrub / stage switch while that batch is still in flight: the stale
    // batch is on the wire, so no second one is claimed on top of it.
    invalidatePoseBuffer();
    expect(claimPoseBatch(CODES, 0)).toBeNull();

    // The pre-scrub batch rejects late: its failure belongs to the old epoch,
    // so the new generation keeps prefetching.
    settlePoseBatch(stale, null);
    const fresh = claimPoseBatch(CODES, 0)!;
    settlePoseBatch(fresh, frames(fresh.times.length)); // window 1..12
    expect(poseCoverage(0)).toBe(POSE_PREFETCH);
  });

  it("marks the generation failed when the batch bytes will not split", () => {
    // The fetcher splits the batch at settle; bytes it cannot bound are the
    // same verdict as a batch that failed wholesale.
    const claimed = claimPoseBatch(CODES, 0)!;
    settlePoseBatch(claimed, new ArrayBuffer(8));

    expect(isPrefetchDead()).toBe(true);
    expect(poseCoverage(0)).toBe(0);
    expect(claimPoseBatch(CODES, 0)).toBeNull();
  });

  it("stores the settled frames without decoding them", () => {
    // A frame whose visibility byte is 2: the split can bound it, the decode
    // rejects it. A settle that decoded all K frames would drop the batch
    // whole; a settle that only splits keeps the window for takePose.
    const payload = encodePoseBatch([
      ...Array.from({ length: POSE_PREFETCH - 1 }, (_, i) => frame(i + 1)),
      frameWithBadVisibility(),
    ]);
    const claimed = claimPoseBatch(CODES, 0)!;

    settlePoseBatch(claimed, payload);

    expect(poseCoverage(0)).toBe(POSE_PREFETCH);
    expect(isPrefetchDead()).toBe(false);
  });

  it("decodes one frame per takePose, after the settle", () => {
    fillAt(0); // codes 1..12 carry frames tagged 0..11

    const pose: AnimatedPose | null = takePose(1);

    expect(pose).not.toBeNull();
    expect(pose!.manifest[0]!.path).toBe("/0");
    expect(takePose(1)).toBeNull(); // consumed exactly like a decoded pose was
  });

  it("falls into the failed-epoch fallback on a corrupt buffered frame", () => {
    const payload = encodePoseBatch([
      ...Array.from({ length: POSE_PREFETCH - 1 }, (_, i) => frame(i + 1)),
      frameWithBadVisibility(), // the LAST frame: code POSE_PREFETCH of window 1..12
    ]);
    const claimed = claimPoseBatch(CODES, 0)!;
    settlePoseBatch(claimed, payload);

    // The corrupt frame is the LAST of the window: taking it must land in
    // the same fallback a failed batch lands in — dead generation, window
    // dropped whole, the step free to single-fetch — never a thrown error.
    expect(takePose(POSE_PREFETCH)).toBeNull();
    expect(isPrefetchDead()).toBe(true);
    expect(takePose(1)).toBeNull();
    expect(poseCoverage(0)).toBe(0);
    expect(claimPoseBatch(CODES, 0)).toBeNull();
  });
});

// A frame whose node table is structurally scannable but semantically
// corrupt (visibility byte 2): the split bounds it, the decode throws.
function frameWithBadVisibility(): ArrayBuffer {
  const frame = encodePoseFrame([{ path: "/Bad" }], emptyPoseBatch());
  const view = new DataView(frame);
  let at = 4 + 4 + view.getUint32(4, true); // past the single path entry
  at = (at + 3) & ~3; // section padding
  at += 4; // material count (0 entries)
  at += 4; // node count (1 record follows)
  view.setUint8(at + 11, 2); // node record: visibility byte
  return frame;
}

describe("hole times on the tcps grid", () => {
  // Inside a hole the playhead's own time is wall-clock derived: unquantized,
  // every frame is a new f64, so the backend pose-frame cache (keyed by the
  // exact f64) never hits and every hole pose pays the full walk, every pass.
  it("quantizes an in-hole time onto the grid", () => {
    expect(Object.is(holeQueryTime(120.001, SPARSE, 30), 120)).toBe(true);
    expect(Object.is(holeQueryTime(120.02, SPARSE, 30), 120.03333333333333)).toBe(true);
  });

  it("returns identical bits for the same grid slot on a second loop pass", () => {
    const first = holeQueryTime(120.001, SPARSE, 30);
    const second = holeQueryTime(120.009, SPARSE, 30); // next pass, other float
    expect(Object.is(first, second)).toBe(true);

    // And the batch's keys are the very values the driver asks for, so the
    // frame cache hits on the second pass.
    const claimed = claimPoseBatch(SPARSE, holeQueryTime(119.97, SPARSE, 30), 30)!;
    expect(Object.is(claimed.times[0], first)).toBe(true);
    settleAll(claimed);
  });

  it("clamps the grid time at the hole's exit code", () => {
    // An exit code in the upper half of its grid cell: the time below it rounds
    // UP past it, and presenting a pose beyond the authored key then snapping
    // back onto it is what the driver reads as a loop wrap.
    expect(holeQueryTime(40.037, [0, 40.038, 41], 100)).toBe(40.038);
  });

  it("passes the time through without codes or a rate", () => {
    expect(holeQueryTime(1.234, [], 30)).toBe(1.234);
    expect(holeQueryTime(1.234, SPARSE, 0)).toBe(1.234);
  });
});

describe("claiming a hole batch", () => {
  it("claims the grid times strictly after the playhead", () => {
    const claimed = claimPoseBatch(SPARSE, 4, 10)!;
    expect(claimed.times).toHaveLength(POSE_PREFETCH);
    expect(claimed.times[0]).toBe(4.1);
    expect(claimed.times[POSE_PREFETCH - 1]).toBe(5.2);
    expect(claimed.times).not.toContain(4);
    settleAll(claimed);
  });

  it("clamps the hole batch at the exit code instead of crossing it", () => {
    const claimed = claimPoseBatch(SPARSE, 39.5, 10)!;
    expect(claimed.times).toEqual([39.6, 39.7, 39.8, 39.9]);
    expect(claimed.times).not.toContain(40);
    settleAll(claimed);
  });

  it("re-claims only what the hole window does not hold", () => {
    const claimed = claimPoseBatch(SPARSE, 4, 10)!; // 4.1..5.2 buffered
    settleAll(claimed);

    expect(claimPoseBatch(SPARSE, 4, 10)).toBeNull();
    takePose(4.1);
    const topUp = claimPoseBatch(SPARSE, 4.1, 10)!;
    // The 11 keys still held are not re-transferred; the window refills ahead.
    expect(topUp.times[0]).toBe(5.3);
    expect(topUp.times).not.toContain(5.2);
    settleAll(topUp);
  });

  it("claims a hole batch even with authored poses buffered past the exit", () => {
    const codes = [0, 1, 2, 3, ...Array.from({ length: 20 }, (_, i) => 40 + i)];
    fillAt(0, codes, 10); // 1,2,3 and 40..48
    fillAt(40, codes, 10); // tops the authored window up past the exit
    expect(poseCoverage(6.5)).toBeGreaterThanOrEqual(POSE_PREFETCH);

    // Those poses cannot serve a hole time, so they must not mask the window.
    const claimed = claimPoseBatch(codes, 6.5, 10)!;
    expect(claimed.times[0]).toBe(6.6);
    settleAll(claimed);
  });

  it("prunes the poses behind the playhead on the hole path too", () => {
    fillAt(18); // 19..30 buffered
    const claimed = claimPoseBatch(CODES, 20.5, 24)!;

    expect(takePose(19)).toBeNull();
    expect(claimed.times[0]).toBe(20.541666666666668);
    settleAll(claimed);
  });
});

describe("holding a playback step on a miss", () => {
  it("holds while a batch is in flight", () => {
    const claimed = claimPoseBatch(CODES, 0); // in flight, nothing buffered yet
    expect(holdsPoseStep(CODES, 5)).toBe(true);
    settleAll(claimed);
  });

  it("does not hold on a cold buffer: a seed fetch beats an unissued claim", () => {
    // Nothing in flight (cold start, first frame after a wrap): waiting for a
    // claim that has not been issued costs the batch wall (~260 ms), the seed
    // fetch ~145 ms with nothing to queue behind.
    expect(holdsPoseStep(CODES, 20)).toBe(false);
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

  it("reports a dead prefetch path for the rest of its generation", () => {
    expect(isPrefetchDead()).toBe(false);
    const claimed = claimPoseBatch(CODES, 0)!;
    settlePoseBatch(claimed, null);
    expect(isPrefetchDead()).toBe(true);

    invalidatePoseBuffer();
    expect(isPrefetchDead()).toBe(false);
  });

  it("does not hold for an unauthored code, and re-arms once a claim is issued", () => {
    expect(holdsPoseStep(CODES, 1.5)).toBe(false);

    fillAt(0);
    invalidatePoseBuffer();
    expect(holdsPoseStep(CODES, 5)).toBe(false); // nothing on the wire

    const claimed = claimPoseBatch(CODES, 1); // the driver claims on this frame
    expect(holdsPoseStep(CODES, 5)).toBe(true);
    settleAll(claimed);
  });

  it("does not hold for a time the batch on the wire cannot carry", () => {
    const claimed = claimPoseBatch(CODES, 0)!; // in flight, nothing buffered yet
    expect(holdsPoseStep(CODES, 5)).toBe(true);

    // A time inside a hole in the authored keys: no claim ever asks for it, so
    // holding would spend the deadline waiting for a pose that is not coming.
    expect(holdsPoseStep(CODES, 20.5)).toBe(false);

    settleAll(claimed);
  });

  it("holds for an in-hole time the hole batch carries, and only for those", () => {
    const claimed = claimPoseBatch(SPARSE, 4, 10)!; // 4.1..5.2 on the wire

    expect(holdsPoseStep(SPARSE, 4.1)).toBe(true);
    expect(holdsPoseStep(SPARSE, 5.2)).toBe(true);
    // Off the grid, or past the batch's window: no batch can carry it.
    expect(holdsPoseStep(SPARSE, 4.05)).toBe(false);
    expect(holdsPoseStep(SPARSE, 20)).toBe(false);

    settleAll(claimed);
  });
});

describe("the hold deadline", () => {
  // The deadline is wall-clock: a hold must not outlive the batch's failure to
  // arrive, so the module's clock is a seam here.
  let clock = 0;

  beforeEach(() => {
    clock = 1000;
    setHoldClockForTests(() => clock);
  });

  afterEach(() => setHoldClockForTests());

  it("releases the hold once the deadline passes", () => {
    const claimed = claimPoseBatch(CODES, 0)!; // in flight, nothing buffered

    expect(holdsPoseStep(CODES, 30)).toBe(true);
    clock += POSE_HOLD_DEADLINE_MS - 1;
    expect(holdsPoseStep(CODES, 30)).toBe(true);
    clock += 1;
    // The driver may now single-fetch: a bounded hitch beats a frozen picture.
    expect(holdsPoseStep(CODES, 30)).toBe(false);

    settleAll(claimed);
  });

  it("pins the deadline at 250 ms", () => {
    // The turn-length budget is what makes a release hitch acceptable; the
    // behaviour below is expressed against the constant, so pin its value.
    expect(POSE_HOLD_DEADLINE_MS).toBe(250);
  });

  it("keeps one deadline across code advances within the same holding state", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    expect(holdsPoseStep(CODES, 30)).toBe(true);
    clock += POSE_HOLD_DEADLINE_MS;
    expect(holdsPoseStep(CODES, 30)).toBe(false);

    // A new code the same batch would have carried: still the same wait, so
    // the spent deadline stays spent instead of restarting per code.
    expect(holdsPoseStep(CODES, 31)).toBe(false);

    settleAll(claimed);
  });

  it("counts one deadline trip per holding episode", () => {
    const before = diagSnapshot().deadlineTripTotal;
    const claimed = claimPoseBatch(CODES, 0)!;
    expect(holdsPoseStep(CODES, 30)).toBe(true);
    clock += POSE_HOLD_DEADLINE_MS;
    expect(holdsPoseStep(CODES, 30)).toBe(false);
    // Every later frame of the same episode is the same trip, not a new one.
    clock += 1000;
    expect(holdsPoseStep(CODES, 31)).toBe(false);

    expect(diagSnapshot().deadlineTripTotal - before).toBe(1);

    settleAll(claimed);
  });

  it("releases the hold after the deadline while the playhead keeps advancing", () => {
    // The shape playback actually produces: 24 tcps at 60 fps reaches a new
    // authored code every ~2.5 frames, so a batch that never settles would
    // restart a per-code deadline forever. Here for the batch's whole 1.4 s
    // wall: the hold must stop at the deadline, not at the batch's arrival.
    const claimed = claimPoseBatch(CODES, 0)!; // in flight, never settles
    const frameMs = 1000 / 60;
    let continuous = 0;
    let held = 0;
    for (let frame = 0; frame < 84; frame++) {
      clock += frameMs;
      continuous += 24 / 60;
      if (holdsPoseStep(CODES, Math.floor(continuous))) held++;
    }

    // 250 ms at 60 fps is 15 frames; a per-code deadline held 84 of 84.
    expect(held).toBeLessThanOrEqual(Math.ceil(POSE_HOLD_DEADLINE_MS / frameMs));
    expect(held).toBeGreaterThan(0);

    settleAll(claimed);
  });

  it("keeps the hold unchanged before the deadline", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    expect(holdsPoseStep(CODES, 30)).toBe(true);
    clock += POSE_HOLD_DEADLINE_MS / 2;
    expect(holdsPoseStep(CODES, 30)).toBe(true);

    settleAll(claimed);
  });

  it("bounds a hole hold by the same deadline", () => {
    const claimed = claimPoseBatch(SPARSE, 4, 10)!; // 4.1..5.2 on the wire
    expect(holdsPoseStep(SPARSE, 4.1)).toBe(true);
    clock += POSE_HOLD_DEADLINE_MS;
    expect(holdsPoseStep(SPARSE, 4.1)).toBe(false);

    settleAll(claimed);
  });

  it("clears the spent deadline when the batch settles", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    expect(holdsPoseStep(CODES, 30)).toBe(true);
    clock += POSE_HOLD_DEADLINE_MS;
    expect(holdsPoseStep(CODES, 30)).toBe(false);

    settleAll(claimed); // window 1..12: code 30 is still a miss
    const next = claimPoseBatch(CODES, 10)!;
    expect(holdsPoseStep(CODES, 30)).toBe(true); // fresh start, not sticky

    settleAll(next);
  });

  it("clears the spent deadline once the buffer covers the code", () => {
    const claimed = claimPoseBatch(CODES, 0)!;
    expect(holdsPoseStep(CODES, 5)).toBe(true);
    clock += POSE_HOLD_DEADLINE_MS;
    expect(holdsPoseStep(CODES, 5)).toBe(false);

    settleAll(claimed); // 5 is buffered now
    expect(holdsPoseStep(CODES, 5)).toBe(false);

    // Consumed again and a new batch is on the wire: the deadline restarts.
    takePose(5);
    const next = claimPoseBatch(CODES, 5)!;
    expect(holdsPoseStep(CODES, 5)).toBe(true);

    settleAll(next);
  });
});
