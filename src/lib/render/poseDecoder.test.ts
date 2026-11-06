// poseDecoder tests: the single pose frame and the batch response framing
// (stage.rs::frame_pose / frame_poses). Pure decoders — bytes in, poses out.

import { describe, expect, it } from "vitest";
import { decodeAnimatedPose, decodeAnimatedPoseBatch } from "./poseDecoder";
import { geometryBatchLength } from "./geometryDecoder";

const encoder = new TextEncoder();
const aligned = (length: number) => (length + 3) & ~3;

// One pose frame, same layout the backend writes: manifest length + JSON,
// path count + length-prefixed paths, both 4-byte padded, then the geometry
// batch whose slot i belongs to path i.
function poseFrame(
  nodes: unknown,
  paths: string[],
  slotBytes = [1, 2, 3],
  slotCount = paths.length,
): ArrayBuffer {
  const manifest = encoder.encode(JSON.stringify(nodes));
  const encoded = paths.map((path) => encoder.encode(path));
  const slots = Array.from({ length: slotCount }, () => new Uint8Array(slotBytes));
  const slotsLength = slots.reduce((sum, slot) => sum + 8 + aligned(slot.length), 0);
  const pathsLength = encoded.reduce((sum, path) => sum + 4 + path.length, 0);
  const head = 4 + aligned(manifest.length) + 4 + aligned(pathsLength);
  const buffer = new ArrayBuffer(head + 12 + slotsLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, manifest.length, true);
  bytes.set(manifest, 4);
  let offset = 4 + aligned(manifest.length);
  view.setUint32(offset, encoded.length, true);
  offset += 4;
  for (const path of encoded) {
    view.setUint32(offset, path.length, true);
    bytes.set(path, offset + 4);
    offset += 4 + path.length;
  }
  offset = head;
  view.setUint32(offset, 0x55534247, true);
  view.setUint32(offset + 4, 1, true);
  view.setUint32(offset + 8, slots.length, true);
  offset += 12;
  for (const slot of slots) {
    view.setUint32(offset, 0, true);
    view.setUint32(offset + 4, slot.length, true);
    bytes.set(slot, offset + 8);
    offset += 8 + aligned(slot.length);
  }
  return buffer;
}

// The batch response frame: u32 count then the frames back to back.
function poseBatch(frames: ArrayBuffer[]): ArrayBuffer {
  const buffer = new ArrayBuffer(4 + frames.reduce((sum, frame) => sum + frame.byteLength, 0));
  const view = new DataView(buffer);
  view.setUint32(0, frames.length, true);
  let offset = 4;
  for (const frame of frames) {
    new Uint8Array(buffer, offset, frame.byteLength).set(new Uint8Array(frame));
    offset += frame.byteLength;
  }
  return buffer;
}

const MANIFEST = [{ path: "/Scene/Wobble", animated: true }];

describe("decodeAnimatedPose", () => {
  it("decodes the manifest and keys the geometry slots by path", () => {
    const pose = decodeAnimatedPose(poseFrame(MANIFEST, ["/Scen/Wobble", "/Scene/Tail"]));

    expect(pose.manifest).toEqual(MANIFEST);
    expect([...pose.prefetched.keys()]).toEqual(["/Scen/Wobble", "/Scene/Tail"]);
    expect(new Uint8Array(pose.prefetched.get("/Scen/Wobble")!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects a path list that disagrees with the geometry slots", () => {
    expect(() => decodeAnimatedPose(poseFrame(MANIFEST, ["/A"], [1, 2, 3], 2))).toThrow(/slot count/);
  });
});

describe("decodeAnimatedPoseBatch", () => {
  it("decodes K frames exactly like K single decodes", () => {
    const frames = [
      poseFrame(MANIFEST, ["/A", "/B"], [1]),
      poseFrame([{ path: "/Moved" }], ["/C"], [9, 9, 9, 9]),
      poseFrame([], []),
    ];
    const codes = [1, 2, 3];

    const batch = decodeAnimatedPoseBatch(poseBatch(frames), codes);
    const singles = frames.map((frame) => decodeAnimatedPose(frame));

    expect(batch).toEqual(singles);
    expect(batch[1]!.manifest).toEqual([{ path: "/Moved" }]);
  });

  it("throws when the frame count does not match the requested codes", () => {
    const payload = poseBatch([poseFrame(MANIFEST, []), poseFrame(MANIFEST, [])]);

    expect(() => decodeAnimatedPoseBatch(payload, [1, 2, 3])).toThrow(/2 frames for 3/);
    expect(() => decodeAnimatedPoseBatch(payload, [1])).toThrow(/2 frames for 1/);
  });

  it("decodes a clamped tail of fewer frames than K", () => {
    const frames = [poseFrame(MANIFEST, ["/A"], [4]), poseFrame(MANIFEST, ["/B"], [5, 6])];

    const batch = decodeAnimatedPoseBatch(poseBatch(frames), [38, 39]);

    expect(batch).toHaveLength(2);
    expect(new Uint8Array(batch[1]!.prefetched.get("/B")!)).toEqual(new Uint8Array([5, 6]));
  });

  it("decodes an empty batch", () => {
    expect(decodeAnimatedPoseBatch(poseBatch([]), [])).toEqual([]);
  });

  it("rejects trailing bytes after the last frame", () => {
    const frame = poseFrame(MANIFEST, []);
    const payload = new ArrayBuffer(4 + frame.byteLength + 4);
    new DataView(payload).setUint32(0, 1, true);
    new Uint8Array(payload, 4, frame.byteLength).set(new Uint8Array(frame));

    expect(() => decodeAnimatedPoseBatch(payload, [1])).toThrow(/trailing bytes/);
  });
});

describe("geometryBatchLength", () => {
  it("walks the slot headers past padded slots", () => {
    const paths = ["/A", "/B"];
    const frame = poseFrame(MANIFEST, paths, [1, 2, 3]);
    const manifestLength = encoder.encode(JSON.stringify(MANIFEST)).length;
    const pathsLength = paths.reduce((sum, path) => sum + 4 + encoder.encode(path).length, 0);
    const batchStart = 4 + aligned(manifestLength) + 4 + aligned(pathsLength);

    // Header plus two 3-byte slots, each 8-byte header + 4 padded bytes: the
    // frame's own length, not the sum of the raw payload bytes.
    expect(geometryBatchLength(frame, batchStart)).toBe(12 + 2 * 12);
    expect(geometryBatchLength(new Uint8Array(frame).subarray(batchStart))).toBe(12 + 2 * 12);
  });
});
