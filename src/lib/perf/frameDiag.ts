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
}

const rafRing = ring(FRAMES);
const renderRing = ring(FRAMES);
const gapRing = ring(POSES);
const applyRing = ring(POSES);

// -1 = no sample yet (a 0 ms timestamp is a legitimate first sample).
let lastRaf = -1;
let lastRender = -1;
let lastPoseAt = -1;
let lastCodeIdx = -1;
let throttled = 0;
let dropped = 0;
let rate = 0;

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

/** Stage rate the pose expectation derives from. */
export function setRate(tcps: number) {
  rate = tcps;
}

/** The playhead jumped (scrub, load, pause): the next present starts a new chain. */
export function onPoseResync() {
  lastCodeIdx = -1;
  lastPoseAt = -1;
}

export function reset() {
  for (const r of [rafRing, renderRing, gapRing, applyRing]) {
    r.i = 0;
    r.n = 0;
  }
  lastRaf = -1;
  lastRender = -1;
  lastPoseAt = -1;
  lastCodeIdx = -1;
  throttled = 0;
  dropped = 0;
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
  };
}
