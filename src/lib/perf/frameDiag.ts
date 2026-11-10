// Frame and pose pacing diagnostic. One module singleton, no reactivity:
// the hot-path writers are O(1) stores into preallocated rings, and the
// percentiles are computed only in snapshot(), when someone asks.
//
// Deliberately not dev-gated: dev and release must report identical
// numbers for the comparison to mean anything.

export const FRAMES = 600; // 10 s at 60 Hz
export const POSES = 240; // 10 s at 24 tcps

interface Ring {
  buf: Float32Array;
  capacity: number;
  i: number;
  n: number;
}

function ring(capacity: number): Ring {
  return { buf: new Float32Array(capacity), capacity, i: 0, n: 0 };
}

function push(r: Ring, v: number) {
  r.buf[r.i] = v;
  r.i = r.i + 1 === r.capacity ? 0 : r.i + 1;
  if (r.n < r.capacity) r.n++;
}

export interface Series {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface DiagSnapshot {
  tcps: number;
  expectedPoseMs: number;
  rafN: number;
  rafP50: number;
  rafP95: number;
  rafMax: number;
  rafFps: number;
  renderN: number;
  renderP50: number;
  renderP95: number;
  renderMax: number;
  renderFps: number;
  throttled: number;
  poseN: number;
  poseP50: number;
  poseP95: number;
  poseMax: number;
  droppedCodes: number;
  applyN: number;
  applyP50: number;
  applyP95: number;
  applyMax: number;
  dispatchN: number;
  dispatchP50: number;
  dispatchP95: number;
  dispatchMax: number;
  heldTotal: number;
  prefetchDead: boolean;
  resyncTotal: number;
  rewindTotal: number;
  invalidateWrap: number;
  invalidateResync: number;
  invalidateEdit: number;
  invalidateLoad: number;
  deadlineTripTotal: number;
  singleFallbackTotal: number;
  holeFrameTotal: number;
  codeIdx: number;
  codesN: number;
  nextCodeGap: number;
}

// Why the look-ahead was dropped. The four callers are the whole set; a
// stranded buffer (kept across a change it cannot survive) shows up as the
// matching counter moving at the same time as a pose gap.
export type InvalidateReason = "wrap" | "resync" | "edit" | "load";

const rafRing = ring(FRAMES);
const renderRing = ring(FRAMES);
const gapRing = ring(POSES);
const applyRing = ring(POSES);
const dispatchRing = ring(POSES);

// -1 = no sample yet (a 0 ms timestamp is a legitimate first sample).
let lastRaf = -1;
let lastRender = -1;
let lastPoseAt = -1;
let lastCodeIdx = -1;
let throttled = 0;
let dropped = 0;
let held = 0;
let prefetchDead = false;
let rate = 0;
let resyncs = 0;
let rewinds = 0;
let deadlineTrips = 0;
let singleFallbacks = 0;
let holeFrames = 0;
const invalidations: Record<InvalidateReason, number> = { wrap: 0, resync: 0, edit: 0, load: 0 };
// Playhead position relative to the authored codes: how many exist at all and
// how far the next one is (-1 = the playhead is inside a hole in the keys, so
// there is no next code to measure to; 0 = it sits on the last code).
let codesN = 0;
let nextCodeGap = 0;

/** Expected pose interval for the stage rate; 0 when the rate is unknown. */
export function expectedIntervalMs(tcps: number): number {
  return tcps > 0 ? 1000 / tcps : 0;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[idx];
}

// Codes are ascending (the rust side unions the sampled time samples), so
// the index of an authored code is a binary search. -1 = not authored.
export function codeIndex(codes: readonly number[], code: number): number {
  let lo = 0;
  let hi = codes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = codes[mid];
    if (v === code) return mid;
    if (v < code) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Authored codes that went unpresented between two presented indices.
 * A backwards index is a loop restart or a scrub, not a drop.
 */
export function droppedBetween(prevIdx: number, nextIdx: number): number {
  return Math.max(0, nextIdx - prevIdx - 1);
}

/** One rAF tick. Takes the loop's own timestamp; no clock read. */
export function onRaf(t: number) {
  // animate() defaults to 0 when called off the rAF path: not a sample.
  if (t <= 0) return;
  if (lastRaf > 0) push(rafRing, t - lastRaf);
  lastRaf = t;
}

/** One frame the fps cap gate skipped. */
export function onThrottled() {
  throttled++;
}

/**
 * One frame that reached the renderer. Takes the loop's gate clock, not the
 * rAF stamp: the fps cap paces on it, so the ring must too.
 */
export function onRender(t: number) {
  if (t <= 0) return;
  if (lastRender > 0) push(renderRing, t - lastRender);
  lastRender = t;
}

/** One distinct presented code: inter-pose gap plus dropped-code count. */
export function onPose(nowMs: number, codeIdx: number) {
  if (lastPoseAt >= 0) push(gapRing, nowMs - lastPoseAt);
  lastPoseAt = nowMs;
  if (codeIdx >= 0 && lastCodeIdx >= 0) dropped += droppedBetween(lastCodeIdx, codeIdx);
  lastCodeIdx = codeIdx;
}

/** One pose end to end: the usdbee:pose measure pair's own span. */
export function onPoseApplied(ms: number) {
  push(applyRing, ms);
}

/**
 * Bytes in hand: one single-pose fetch, or one batch invoke recorded ONCE per
 * batch (its whole wall time), never once per pose the batch carries.
 */
export function onPoseDispatched(ms: number) {
  push(dispatchRing, ms);
}

/** One playback step held on a buffer miss: nothing presented that frame. */
export function onPoseHeld() {
  held++;
}

/** The batch path is off for this generation; the driver reports it per tick. */
export function setPrefetchDead(dead: boolean) {
  prefetchDead = dead;
}

/** Stage rate the pose expectation derives from. */
export function setRate(tcps: number) {
  rate = tcps;
}

/**
 * The playhead jumped (scrub, load, pause): the next present starts a new
 * chain. `rewound` marks the harmful form — the playhead moved BACKWARDS, so
 * codes it already presented are presented again.
 */
export function onPoseResync(rewound = false) {
  lastCodeIdx = -1;
  lastPoseAt = -1;
  resyncs++;
  if (rewound) rewinds++;
}

/** The look-ahead was dropped, and by whom. */
export function onInvalidate(reason: InvalidateReason) {
  invalidations[reason]++;
}

/** A hold gave up waiting for its batch and let the step fetch singly. */
export function onHoldDeadline() {
  deadlineTrips++;
}

/** A playback step missed the buffer and fetched one pose (no hold was left). */
export function onSingleFallback() {
  singleFallbacks++;
}

/**
 * One pose applied at an unauthored time, i.e. inside a code hole. Deliberate:
 * keeping it out of singleFallbackTotal is what keeps that counter readable as
 * starvation.
 */
export function onHoleFrame() {
  holeFrames++;
}

/** Authored codes on the stage and the span to the one after the playhead. */
export function setCodes(count: number, gap: number) {
  codesN = count;
  nextCodeGap = gap;
}

export function reset() {
  for (const r of [rafRing, renderRing, gapRing, applyRing, dispatchRing]) {
    r.i = 0;
    r.n = 0;
  }
  lastRaf = -1;
  lastRender = -1;
  lastPoseAt = -1;
  lastCodeIdx = -1;
  throttled = 0;
  dropped = 0;
  held = 0;
  prefetchDead = false;
  resyncs = 0;
  rewinds = 0;
  deadlineTrips = 0;
  singleFallbacks = 0;
  holeFrames = 0;
  invalidations.wrap = 0;
  invalidations.resync = 0;
  invalidations.edit = 0;
  invalidations.load = 0;
  codesN = 0;
  nextCodeGap = 0;
  // `rate` is a stage property, not a measurement: keep it.
}

// Two decimals keeps a pasted snapshot readable without losing a ms.
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function series(r: Ring): Series {
  if (r.n === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  // Ring order is irrelevant: every slot is one sample either way.
  const sorted = Array.from(r.buf.subarray(0, r.n)).sort((a, b) => a - b);
  return {
    n: r.n,
    p50: round2(percentile(sorted, 0.5)),
    p95: round2(percentile(sorted, 0.95)),
    max: round2(sorted[sorted.length - 1]),
  };
}

function fpsOf(p50: number): number {
  return p50 > 0 ? round2(1000 / p50) : 0;
}

export function snapshot(): DiagSnapshot {
  const raf = series(rafRing);
  const render = series(renderRing);
  const pose = series(gapRing);
  const apply = series(applyRing);
  const dispatch = series(dispatchRing);
  return {
    tcps: rate,
    expectedPoseMs: round2(expectedIntervalMs(rate)),
    rafN: raf.n,
    rafP50: raf.p50,
    rafP95: raf.p95,
    rafMax: raf.max,
    rafFps: fpsOf(raf.p50),
    renderN: render.n,
    renderP50: render.p50,
    renderP95: render.p95,
    renderMax: render.max,
    renderFps: fpsOf(render.p50),
    throttled,
    poseN: pose.n,
    poseP50: pose.p50,
    poseP95: pose.p95,
    poseMax: pose.max,
    droppedCodes: dropped,
    applyN: apply.n,
    applyP50: apply.p50,
    applyP95: apply.p95,
    applyMax: apply.max,
    dispatchN: dispatch.n,
    dispatchP50: dispatch.p50,
    dispatchP95: dispatch.p95,
    dispatchMax: dispatch.max,
    heldTotal: held,
    prefetchDead,
    resyncTotal: resyncs,
    rewindTotal: rewinds,
    invalidateWrap: invalidations.wrap,
    invalidateResync: invalidations.resync,
    invalidateEdit: invalidations.edit,
    invalidateLoad: invalidations.load,
    deadlineTripTotal: deadlineTrips,
    singleFallbackTotal: singleFallbacks,
    holeFrameTotal: holeFrames,
    // -1 until the driver has presented a code.
    codeIdx: lastCodeIdx,
    codesN,
    nextCodeGap: round2(nextCodeGap),
  };
}
