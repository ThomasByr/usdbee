// Pure decoders for the playback pose payloads — no invoke, no Svelte: bytes
// in, poses out. The invoke wiring lives in renderState.svelte.ts.
//
// Layout (stage.rs::frame_pose): `[u32 LE manifest JSON length][manifest
// JSON][4-byte pad][u32 LE path count][per path: u32 LE length + utf8][4-byte
// pad][geometry batch]`. Prefixes carry the true byte lengths and the padding
// is implicit, so decode with a cursor rather than typed-array views.
//
// The batch variant wraps K of those frames: `[u32 LE frame count][frames...]`.
// Frames carry no length prefix of their own — the geometry batch's slot
// headers are the only self-describing tail — hence the cursor reader below.
import type { RenderNode } from "../stage/types";
import { decodeGeometryBatch, geometryBatchLength } from "./geometryDecoder";
import type { AnimatedPose } from "./sceneBuilder";

const poseText = new TextDecoder();

/** One pose frame at `start`, plus the offset just past it. */
function readAnimatedPose(payload: ArrayBuffer, start: number): { pose: AnimatedPose; end: number } {
  const view = new DataView(payload);
  const u32 = (at: number) => view.getUint32(at, true);
  const text = (at: number, length: number) => poseText.decode(new Uint8Array(payload, at, length));
  let offset = start;
  const manifestLength = u32(offset);
  const manifest = JSON.parse(text(offset + 4, manifestLength)) as RenderNode[];
  offset = (offset + 4 + manifestLength + 3) & ~3;
  const paths: string[] = [];
  let pathCount = u32(offset);
  offset += 4;
  for (; pathCount > 0; pathCount--) {
    const length = u32(offset);
    paths.push(text(offset + 4, length));
    offset += 4 + length;
  }
  offset = (offset + 3) & ~3;
  const batchLength = geometryBatchLength(payload, offset);
  const slots = decodeGeometryBatch(new Uint8Array(payload, offset, batchLength));
  if (slots.length !== paths.length) {
    throw new Error(`pose slot count ${slots.length} does not match path count ${paths.length}`);
  }
  const prefetched: AnimatedPose["prefetched"] = new Map();
  paths.forEach((path, slot) => prefetched.set(path, slots[slot] ?? null));
  return { pose: { manifest, prefetched }, end: offset + batchLength };
}

// shortcut: the merged pose batches ALL geometry_animated prims with no slot cap (the old 32-slice batching is gone), upgrade to a capped batch + per-prim fallback when a stage with more than ~32 deforming prims appears.
export function decodeAnimatedPose(payload: ArrayBuffer): AnimatedPose {
  return readAnimatedPose(payload, 0).pose;
}

/**
 * A batch pose response, one pose per requested `codes` entry. A frame count
 * that disagrees with the request means the response desynced from it (the
 * backend omits out-of-range times), so this throws rather than slotting poses
 * onto the wrong codes — the caller drops the batch and steps per pose.
 */
export function decodeAnimatedPoseBatch(payload: ArrayBuffer, codes: readonly number[]): AnimatedPose[] {
  const view = new DataView(payload);
  const count = view.getUint32(0, true);
  if (count !== codes.length) {
    throw new Error(`pose batch carried ${count} frames for ${codes.length} requested codes`);
  }
  const poses: AnimatedPose[] = [];
  let offset = 4;
  for (let frame = 0; frame < count; frame++) {
    const read = readAnimatedPose(payload, offset);
    poses.push(read.pose);
    offset = read.end;
  }
  if (offset !== payload.byteLength) {
    throw new Error(`pose batch has ${payload.byteLength - offset} trailing bytes`);
  }
  return poses;
}
