// Playback look-ahead pose buffer (round 4, task 2). Plain TS, no runes: the
// playback driver fills it from ONE background batch invoke and setStageTime
// consumes it synchronously, so the hot path pays decode+apply only.
//
// Why batching: in dev, every pose invoke costs ~145 ms in the Tauri raw
// payload transport (two IPC hops per >= 1 KB payload), which capped playback
// at ~5-7 presented poses per second regardless of the render loop. K poses
// arrive in one invoke; per-pose latency collapses to decode+apply (< 1 ms).
import { codeIndex } from "../perf/frameDiag";
import type { AnimatedPose } from "./sceneBuilder";

// Poses held ahead of the playhead: ~1 MB at ~78 KB a pose, and ~< 1 s at bike
// cadence, so a refill never has to outrun playback.
export const POSE_PREFETCH = 12;

// Generation of the buffer: bumped by invalidation so a batch still in flight
// lands stale and is dropped instead of slotting pre-edit/pre-load poses.
let epoch = 0;
// Epoch of the batch in flight (-1 = none). Keyed by epoch so an invalidated
// batch, which can no longer block a refill of the new generation, cannot
// release the guard of the batch that replaced it.
let inFlightEpoch = -1;
// A failed batch keeps prefetch off for the rest of its own generation:
// retrying at frame rate would spend one ~145 ms invoke per frame while it is
// broken. Only a failure of the current generation lands here.
let failedEpoch = -1;
// The look-ahead window. Fill REPLACES it: both the playhead's window and the
// new batch start after the same playhead, so nothing valid is dropped and the
// map can never outgrow K.
let buffered = new Map<number, AnimatedPose>();

export interface ClaimedPoseBatch {
  epoch: number;
  times: number[];
}

/** Clears the look-ahead; an in-flight batch lands stale and is dropped. */
export function invalidatePoseBuffer() {
  epoch++;
  buffered = new Map();
}

/**
 * How many authored codes ahead of `code` are buffered. A counter of held
 * entries cannot answer this: coverage is relative to the playhead, which can
 * skip buffered codes (they then sit behind it until the next fill replaces
 * the window), so the scan is the honest form. Cost per driver tick is one
 * short-lived Map iterator, K <= 12.
 */
export function poseCoverage(code: number): number {
  let ahead = 0;
  for (const bufferedCode of buffered.keys()) {
    if (bufferedCode > code) ahead++;
  }
  return ahead;
}

/**
 * The next K authored codes after `code` to fetch in ONE background batch, or
 * null while a batch runs or when the playhead is not on an authored code.
 * Clamped at the stage's last code (the request never wraps; the batch after
 * the wrap refills).
 */
export function claimPoseBatch(codes: readonly number[], code: number): ClaimedPoseBatch | null {
  if (inFlightEpoch === epoch || failedEpoch === epoch) return null;
  // Continuous top-up: any consumed pose re-claims, so a batch is in transit
  // for the whole of playback. A half-full window was shorter than the batch's
  // own wall time (~190 ms of buffer against a ~260 ms invoke), which dried
  // the buffer out every cycle.
  if (poseCoverage(code) >= POSE_PREFETCH) return null;
  const index = codeIndex(codes, code);
  if (index < 0) return null;
  const times = codes.slice(index + 1, index + 1 + POSE_PREFETCH);
  // A short window at the stage's tail is worth one fetch, not one per frame
  // that lands: nothing new means the buffer already holds it.
  if (times.length === 0 || times.every((time) => buffered.has(time))) return null;
  inFlightEpoch = epoch;
  return { epoch, times };
}

/**
 * True when a playback step must WAIT for the prefetch instead of fetching
 * that one pose: the pipeline is alive (authored codes, no failure in this
 * generation) and either a batch is in flight or the missed code is one a
 * claim can still cover. The ipc transport serializes requests, so a single
 * fetch queues in front of the batch that would have delivered the pose
 * (measured: 260 ms -> > 2 s per batch).
 */
export function holdsPoseStep(codes: readonly number[], code: number): boolean {
  if (buffered.has(code)) return false;
  if (codes.length === 0 || failedEpoch === epoch) return false;
  return inFlightEpoch === epoch || codeIndex(codes, code) >= 0;
}

/**
 * One batch arrived (null = it failed): fills the window when the epoch still
 * matches, then releases the in-flight guard. A count mismatch is a desync —
 * the batch is dropped whole rather than slotted onto the wrong codes.
 */
export function settlePoseBatch(claimed: ClaimedPoseBatch, poses: AnimatedPose[] | null) {
  if (inFlightEpoch === claimed.epoch) inFlightEpoch = -1;
  // Epoch first: a batch that failed before an invalidation says nothing about
  // the generation that replaced it, and marking the new one failed would turn
  // prefetch off for the rest of the session.
  if (claimed.epoch !== epoch) return;
  if (poses === null) {
    failedEpoch = epoch;
    return;
  }
  if (poses.length !== claimed.times.length) {
    console.warn(`usdbee: pose prefetch dropped, ${poses.length} poses for ${claimed.times.length} codes`);
    return;
  }
  buffered = new Map();
  claimed.times.forEach((code, slot) => buffered.set(code, poses[slot]!));
}

/** The buffered pose for `code`, consumed by the caller (null on a miss). */
export function takePose(code: number): AnimatedPose | null {
  const pose = buffered.get(code);
  if (!pose) return null;
  buffered.delete(code);
  return pose;
}
