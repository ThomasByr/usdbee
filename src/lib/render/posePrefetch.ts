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
import { decodeBufferedPose, splitAnimatedPoseBatch, type PoseStringTables } from "./poseDecoder";
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
// Set when a wrap invalidated the window while a batch was still on the wire.
// That batch's remaining wall is the one wait a wrap cannot avoid, but queueing
// a second batch behind it would pay two: the next claim adopts the wire
// instead, taking over the guard (inFlightEpoch) while the abandoned batch's
// own settle lands stale and finds a guard that is no longer its own.
let adoptInFlight = false;
// A failed batch keeps prefetch off for the rest of its own generation:
// retrying at frame rate would spend one ~145 ms invoke per frame while it is
// broken. Only a failure of the current generation lands here.
let failedEpoch = -1;
// The look-ahead window, RAW frame bytes keyed by code: a settle only splits
// the batch (no decode), and takePose decodes the one frame it hands out, so
// the 12-frame task amortizes into 12 sub-millisecond decodes (C5). Entries
// behind the playhead are pruned on the next claim, which bounds the map at
// 2K - 1.
let buffered = new Map<number, ArrayBuffer>();
// The stage generation's decoded path/material string tables: byte-identical
// across one stage's frames, so the first takePose decodes them and the rest
// reuse the arrays. Cleared exactly where the buffer invalidates.
let tableCache: PoseStringTables | null = null;
// The times the batch in flight carries. The hold decision needs them: an
// in-hole time is worth waiting for only when the hole claim computed exactly
// that grid key.
let inFlightTimes: readonly number[] = [];
// Whether a hold is running and when it started. The clock measures time spent
// IN the holding state, not time on one code: during a hold the playhead still
// advances to a new code every ~1.4 frames at 24 tcps / 60 fps, so a per-code
// stamp would restart on every frame and never trip. Cleared by every path
// that stops holding (buffer covers the code, batch settles, invalidation,
// failed generation), so the next hold starts from zero instead of inheriting
// a spent deadline.
let holding = false;
let holdStartedAt = 0;
// The playhead the window was last claimed from. A resync onto exactly that
// code does not make the window stale — that is the cold-start seed meeting
// the first play tick — and dropping it there would pay the transport's
// first-invoke wake-up on the frame the user asked for.
let anchoredAt: number | null = null;
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

/**
 * Clears the look-ahead; an in-flight batch lands stale and is dropped.
 *
 * `kind` decides what happens to a batch still on the wire. An edit or a load
 * invalidates for content: its poses are wrong, not merely late, so the batch
 * is abandoned and the next claim waits it out. A wrap only moves the playhead
 * back to the stage start, and the abandoned tail batch holds nothing that can
 * serve there — waiting for it costs a whole batch wall before the first
 * post-wrap pose, so the wrap arms adoption for the next claim.
 */
export function invalidatePoseBuffer(kind: "edit" | "wrap" = "edit") {
  epoch++;
  adoptInFlight = kind === "wrap" && inFlightEpoch !== -1;
  buffered = new Map();
  // The string tables belong to the invalidated generation: a new stage (or
  // an edit) ships different ones, and the blob compare would re-decode on
  // mismatch anyway — dropping them keeps one generation from borrowing
  // another's paths even if a frame slipped past the epoch guard.
  tableCache = null;
  // The abandoned batch's times go with it: they are not what the next batch
  // carries, and holding on them would wait for poses that will be dropped.
  inFlightTimes = [];
  // The hold deadline restarts: it has to bound the claim the wrap is about to
  // issue (waiting behind the abandoned tail batch's remaining wall), not the
  // wait an abandoned batch has already spent.
  holding = false;
  anchoredAt = null;
}

/** True when the window was claimed from `code` and still serves it. */
export function poseBufferAnchoredAt(code: number | null): boolean {
  return anchoredAt !== null && anchoredAt === code;
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

/** Index of the first authored code strictly after `time` (codes.length when none). */
function firstCodeAfter(codes: readonly number[], time: number): number {
  let lo = 0;
  let hi = codes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (codes[mid]! <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The query time for a playhead inside a code hole: its own time on the tcps
 * grid. Hole times are wall-clock derived, so unquantized every frame is a new
 * f64 and the backend pose-frame cache (keyed by the exact f64) never hits;
 * on the grid the same key repeats on every loop pass. The pose at a grid time
 * is whatever USD evaluates there — no values are interpolated here. Clamped
 * at the hole's exit code, so a rounded step cannot land past the authored key
 * and then snap back onto it, which the driver reads as a loop wrap.
 */
export function holeQueryTime(time: number, codes: readonly number[], tcps: number): number {
  if (codes.length === 0 || tcps <= 0) return time;
  const quantized = Math.round(time * tcps) / tcps;
  const exitCode = codes[firstCodeAfter(codes, time)];
  return exitCode !== undefined && quantized >= exitCode ? exitCode : quantized;
}

/**
 * The next K times after `code` that the buffer does not already hold, to fetch
 * in ONE background batch, or null while a batch runs or when there is nothing
 * to carry. On an authored `code` those are authored codes, clamped at the
 * stage's last code (the request never wraps; the batch after the wrap refills).
 * Inside a hole they are the grid times `holeQueryTime` produces, clamped at
 * the hole's exit code so one batch never spans the hole and the authored range
 * after it.
 *
 * `includeAnchor` adds the playhead's own time as slot 0. The wrap branch claims
 * the post-wrap window BEFORE stepping, and that frame's pose is the wrap
 * target itself: without it the frame is a miss, and `holdsPoseStep` refuses to
 * wait for a time the batch does not carry, so it single-fetches the pose the
 * batch could have carried. Every other claim starts strictly after the
 * playhead, whose own pose is either held already or is being fetched as a
 * single by the step that asked.
 */
export function claimPoseBatch(
  codes: readonly number[],
  code: number,
  tcps = 0,
  includeAnchor = false,
): ClaimedPoseBatch | null {
  // The guard is global, not epoch-scoped: invalidation abandons the batch it
  // interrupts but that batch is still on the serialized transport, so a second
  // claim would queue behind it (a wrap then waits two batch walls for its
  // first pose). Trade-off: a wedged invoke blocks prefetch until it settles —
  // the same exposure the non-invalidated path already has. The wrap's
  // abandoned tail batch is the one exception (see adoptInFlight): the claim
  // still waits its remaining wall, but adoption takes over the guard, so a
  // second claim is not refused and that batch's stale settle cannot release
  // the new claim's guard.
  if ((inFlightEpoch !== -1 && !adoptInFlight) || failedEpoch === epoch) return null;
  // Poses the playhead has passed can never be consumed again: never fetch
  // them, and never let them sit in the map. Both branches prune: in a hole the
  // authored codes behind the playhead would otherwise linger to the exit.
  for (const bufferedCode of buffered.keys()) if (bufferedCode <= code) buffered.delete(bufferedCode);

  const times: number[] = [];
  const index = codeIndex(codes, code);
  if (index >= 0) {
    // Continuous top-up: any consumed pose re-claims, so a batch is in transit
    // for the whole of playback. A half-full window was shorter than the batch's
    // own wall time (~190 ms of buffer against a ~260 ms invoke), which dried
    // the buffer out every cycle.
    if (poseCoverage(code) >= POSE_PREFETCH) return null;
    // Only the wrap claim carries the playhead's own time (see includeAnchor).
    if (includeAnchor) times.push(code);
    // Only what is missing: a sliding window re-sent 6-11 poses that were
    // already decoded (~2x the transfer at a high batch duty cycle, real cost on
    // the serialized transport). Empty means the playhead sits on the stage's
    // tail and every code there is held: nothing to fetch.
    for (let slot = index + 1; slot < codes.length && times.length < POSE_PREFETCH; slot++) {
      const time = codes[slot]!;
      if (!buffered.has(time)) times.push(time);
    }
  } else {
    if (codes.length === 0 || tcps <= 0) return null;
    // No authored code past the playhead (the wrap window past the stage's
    // tail): the hole has no exit ahead of it, so it is bounded by the last
    // authored code. Claiming past it asks the backend for times it drops
    // positionally, and that count mismatch fails the batch for the generation.
    const exitCode = codes[firstCodeAfter(codes, code)] ?? codes[codes.length - 1]!;
    // Coverage relative to the hole only: the authored codes past the exit are
    // still ahead but cannot serve a hole time, and letting them mask the hole
    // window would starve it for the length of the hole.
    let ahead = 0;
    for (const bufferedCode of buffered.keys()) {
      if (bufferedCode > code && bufferedCode < exitCode) ahead++;
    }
    if (ahead >= POSE_PREFETCH) return null;
    // Only the wrap claim carries the playhead's own time (see includeAnchor).
    if (includeAnchor) times.push(code);
    for (let slot = Math.floor(code * tcps) + 1; times.length < POSE_PREFETCH; slot++) {
      const time = slot / tcps;
      if (time >= exitCode) break;
      // The slot arithmetic can land on the playhead's own time by a float ulp:
      // a batch never carries the time the frame is already asking for.
      if (time > code && !buffered.has(time)) times.push(time);
    }
  }
  if (times.length === 0) return null;
  inFlightEpoch = epoch;
  inFlightTimes = times;
  adoptInFlight = false;
  anchoredAt = code;
  return { epoch, times };
}

/**
 * True when a playback step must WAIT for the prefetch instead of fetching
 * that one pose: the pipeline is alive (authored codes, no failure in this
 * generation) and a batch is in flight for it. The ipc transport serializes
 * requests, so a single fetch queues in front of the batch that would have
 * delivered the pose (measured: 260 ms -> > 2 s per batch). With nothing on
 * the wire there is nothing to queue behind, so a pure cold start (first frame,
 * the load-time seed) fetches that one pose directly (~145 ms) instead of
 * waiting ~260 ms for a claim. The frame after a wrap is not cold: it claims
 * the post-wrap window before stepping and holds for that batch.
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
  // A hold is only worth its deadline when the batch in transit can deliver
  // the time: an authored code is what a claim carries, and an in-hole time is
  // carried only when the hole claim computed that exact grid key. A time no
  // batch can carry never holds — waiting would spend the whole deadline on a
  // pose that is not coming.
  const carried = codeIndex(codes, code) >= 0 || inFlightTimes.includes(code);
  if (buffered.has(code) || !carried || failedEpoch === epoch || inFlightEpoch !== epoch) {
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
 * One batch arrived (null = it failed): splits the payload into per-code raw
 * frames and fills the window when the epoch still matches, then releases the
 * in-flight guard. NO decode happens here — each frame decodes at takePose.
 * A payload that will not split (desynced count, truncated frame, trailing
 * bytes) is the same verdict as a failed batch: the generation is marked
 * failed and the step path single-fetches, never erroring the scene.
 */
export function settlePoseBatch(claimed: ClaimedPoseBatch, payload: ArrayBuffer | null) {
  if (inFlightEpoch === claimed.epoch) {
    inFlightEpoch = -1;
    inFlightTimes = [];
    adoptInFlight = false;
    // The batch the hold waited on has landed: its deadline is spent.
    holding = false;
  }
  // Epoch first: a batch that failed before an invalidation says nothing about
  // the generation that replaced it, and marking the new one failed would turn
  // prefetch off for the rest of the session.
  if (claimed.epoch !== epoch) return;
  if (payload === null) {
    failedEpoch = epoch;
    // The anchor must not outlive a batch that carried nothing: the resync
    // onto its own code would skip the invalidation, which is the only cheap
    // epoch bump left, and prefetch would stay off for the rest of the
    // session.
    anchoredAt = null;
    return;
  }
  let frames: ArrayBuffer[];
  try {
    frames = splitAnimatedPoseBatch(payload, claimed.times);
  } catch (e) {
    console.warn("usdbee: pose prefetch dropped; stepping one pose at a time:", e);
    failedEpoch = epoch;
    anchoredAt = null;
    return;
  }
  // Merge, not replace: the claim deliberately left the codes it already held
  // out of `times`, so replacing would throw the frames ahead of the playhead
  // away.
  claimed.times.forEach((code, slot) => buffered.set(code, frames[slot]!));
}

/** The buffered pose for `code`, decoded here and consumed by the caller
 * (null on a miss). A frame that will not decode is the same verdict as a
 * batch that failed: the generation is marked failed, the window is dropped
 * whole, and the null lands the caller in the single-fetch fallback — the
 * corrupt bytes must never surface as a scene error. */
export function takePose(code: number): AnimatedPose | null {
  const frame = buffered.get(code);
  if (!frame) return null;
  buffered.delete(code);
  try {
    const decoded = decodeBufferedPose(frame, tableCache);
    tableCache = decoded.tables;
    return decoded.pose;
  } catch (e) {
    console.warn("usdbee: buffered pose failed to decode; stepping one pose at a time:", e);
    failedEpoch = epoch;
    buffered = new Map();
    anchoredAt = null;
    holding = false;
    return null;
  }
}
