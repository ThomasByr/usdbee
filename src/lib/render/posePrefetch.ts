// Playback look-ahead pose buffer (round 4, task 2). Plain TS, no runes: the
// playback driver fills it from ONE background batch invoke and setStageTime
// consumes it synchronously, so the hot path pays decode+apply only.
//
// Why batching: in dev, every pose invoke costs ~145 ms in the Tauri raw
// payload transport (two IPC hops per >= 1 KB payload), which capped playback
// at ~5-7 presented poses per second regardless of the render loop. K poses
// arrive in one invoke; per-pose latency collapses to decode+apply (< 1 ms).
// The hold-deadline counter is the diag's only view into this module.
import { codeIndex, onHoldDeadline } from "../perf/frameDiag";
import type { AnimatedPose } from "./sceneBuilder";

// Poses held ahead of the playhead: ~290 KB at ~24 KB a pose, and ~< 1 s at
// bike cadence, so a refill never has to outrun playback.
export const POSE_PREFETCH = 12;

// A hold is a wait for the batch in transit, not a promise it arrives: a slow
// batch (dev cold walk ~1.4 s) or a dead window after invalidation would
// otherwise freeze presentation for its whole wall. Past this the driver falls
// back to the coalesced single-pose fetch (timeStepInFlight keeps singles
// one-at-a-time, so no transport spiral) for the poses the hold withheld.
// What the fallback buys is bounded, not instant: the single queues behind the
// batch still on the serialized transport, so the hitch is
// (remaining batch wall) + one ~145 ms fetch. Release hitches stay ~5 ms;
// the deadline pays off when the batch stalls without holding the transport.
export const POSE_HOLD_DEADLINE_MS = 250;

// Generation of the buffer: bumped by invalidation so a batch still in flight
// lands stale and is dropped instead of slotting pre-edit/pre-load poses.
let epoch = 0;
// Epoch of the batch in flight (-1 = none). Recorded by epoch so its own
// settle releases the guard, never a later batch's.
let inFlightEpoch = -1;
// A failed batch keeps prefetch off for the rest of its own generation:
// retrying at frame rate would spend one ~145 ms invoke per frame while it is
// broken. Only a failure of the current generation lands here.
let failedEpoch = -1;
// The look-ahead window. A claim takes only the codes it does not hold and the
// fill merges them, so nothing valid is dropped; entries behind the playhead
// are pruned on the next claim, which bounds the map at 2K - 1.
let buffered = new Map<number, AnimatedPose>();
// Whether a hold is running and when it started. The clock measures time spent
// IN the holding state, not time on one code: during a hold the playhead still
// advances to a new code every ~1.4 frames at 24 tcps / 60 fps, so a per-code
// stamp would restart on every frame and never trip. Cleared by every path
// that stops holding (buffer covers the code, batch settles, invalidation,
// failed generation), so the next hold starts from zero instead of inheriting
// a spent deadline.
let holding = false;
let holdStartedAt = 0;
// Whether the current holding episode already gave up at its deadline: the
// state stays armed (so the deadline is not restarted per code) but the trip
// is only counted once.
let holdTripped = false;
// Injectable so the deadline is testable: vitest cannot fake this module's
// clock reads.
let holdNow: () => number = () => performance.now();

/** Test seam: passing nothing restores the real clock. */
export function setHoldClockForTests(now?: () => number) {
  holdNow = now ?? (() => performance.now());
}

/** True while the batch path is off for this generation (last batch failed). */
export function isPrefetchDead(): boolean {
  return failedEpoch === epoch;
}

export interface ClaimedPoseBatch {
  epoch: number;
  times: number[];
}

/** Clears the look-ahead; an in-flight batch lands stale and is dropped. */
export function invalidatePoseBuffer() {
  epoch++;
  buffered = new Map();
  holding = false;
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
 * The next K authored codes after `code` that the buffer does not already
 * hold, to fetch in ONE background batch, or null while a batch runs or when
 * the playhead is not on an authored code. Clamped at the stage's last code
 * (the request never wraps; the batch after the wrap refills).
 */
export function claimPoseBatch(codes: readonly number[], code: number): ClaimedPoseBatch | null {
  // The guard is global, not epoch-scoped: invalidation abandons the batch it
  // interrupts but that batch is still on the serialized transport, so a second
  // claim would queue behind it (a wrap then waits two batch walls for its
  // first pose). Trade-off: a wedged invoke blocks prefetch until it settles —
  // the same exposure the non-invalidated path already has.
  if (inFlightEpoch !== -1 || failedEpoch === epoch) return null;
  // Continuous top-up: any consumed pose re-claims, so a batch is in transit
  // for the whole of playback. A half-full window was shorter than the batch's
  // own wall time (~190 ms of buffer against a ~260 ms invoke), which dried
  // the buffer out every cycle.
  if (poseCoverage(code) >= POSE_PREFETCH) return null;
  const index = codeIndex(codes, code);
  if (index < 0) return null;
  // Poses the playhead has passed can never be consumed again: never fetch
  // them, and never let them sit in the map.
  for (const bufferedCode of buffered.keys()) if (bufferedCode <= code) buffered.delete(bufferedCode);
  // Only what is missing: a sliding window re-sent 6-11 poses that were
  // already decoded (~2x the transfer at a high batch duty cycle, real cost on
  // the serialized transport). Empty means the playhead sits on the stage's
  // tail and every code there is held: nothing to fetch.
  const times: number[] = [];
  for (let slot = index + 1; slot < codes.length && times.length < POSE_PREFETCH; slot++) {
    const time = codes[slot]!;
    if (!buffered.has(time)) times.push(time);
  }
  if (times.length === 0) return null;
  inFlightEpoch = epoch;
  return { epoch, times };
}

/**
 * True when a playback step must WAIT for the prefetch instead of fetching
 * that one pose: the pipeline is alive (authored codes, no failure in this
 * generation) and a batch is in flight for it. The ipc transport serializes
 * requests, so a single fetch queues in front of the batch that would have
 * delivered the pose (measured: 260 ms -> > 2 s per batch). With nothing on
 * the wire there is nothing to queue behind, so a cold start (first frame, the
 * frame after a wrap) seeds the buffer with one ~145 ms fetch instead of
 * waiting ~260 ms for a claim.
 *
 * Hold does not imply a refill is coming: on a fully buffered tail window the
 * playhead's last code holds while a claim returns null. Worst case is one
 * skipped pose.
 *
 * Bounded: a hold that outlives POSE_HOLD_DEADLINE_MS releases the step, so a
 * stalled batch cannot park presentation for its whole wall time. The deadline
 * runs from the moment the hold starts, not from the requested code: the
 * playhead reaches a new code every ~1.4 frames, so a per-code clock would
 * never expire.
 */
export function holdsPoseStep(codes: readonly number[], code: number): boolean {
  if (buffered.has(code) || codes.length === 0 || failedEpoch === epoch || inFlightEpoch !== epoch) {
    holding = false;
    holdTripped = false;
    return false;
  }
  const now = holdNow();
  if (!holding) {
    holding = true;
    holdStartedAt = now;
    holdTripped = false;
  }
  if (now - holdStartedAt < POSE_HOLD_DEADLINE_MS) return true;
  if (!holdTripped) {
    holdTripped = true;
    onHoldDeadline();
  }
  return false;
}

/**
 * One batch arrived (null = it failed): fills the window when the epoch still
 * matches, then releases the in-flight guard. A count mismatch is a desync —
 * the batch is dropped whole rather than slotted onto the wrong codes.
 */
export function settlePoseBatch(claimed: ClaimedPoseBatch, poses: AnimatedPose[] | null) {
  if (inFlightEpoch === claimed.epoch) {
    inFlightEpoch = -1;
    // The batch the hold waited on has landed: its deadline is spent.
    holding = false;
  }
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
  // Merge, not replace: the claim deliberately left the codes it already held
  // out of `times`, so replacing would throw the poses ahead of the playhead
  // away.
  claimed.times.forEach((code, slot) => buffered.set(code, poses[slot]!));
}

/** The buffered pose for `code`, consumed by the caller (null on a miss). */
export function takePose(code: number): AnimatedPose | null {
  const pose = buffered.get(code);
  if (!pose) return null;
  buffered.delete(code);
  return pose;
}
