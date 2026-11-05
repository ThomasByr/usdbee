import { describe, expect, it } from "vitest";
import { decodeGeometry, decodeGeometryBatch, decodeMaterialBatch, GEOMETRY_MAGIC, GEOMETRY_VERSION } from "./geometryDecoder";

// Hand-build the binary layout the Rust side emits (little-endian):
// magic u32, version u32, vertex_count u32, index_count u32, flags u32
// (bit0 normals, bit1 uvs, bit2 colors), then positions f32x3, normals
// f32x3, uvs f32x2, colors f32x3 in flag order, then indices u32.
function buildPayload(opts: {
  magic?: number;
  version?: number;
  flags: number;
  positions: number[][];
  normals?: number[][];
  uvs?: number[][];
  colors?: number[][];
  indices: number[];
}): ArrayBuffer {
  const { positions, normals, uvs, colors, indices } = opts;
  const size =
    20 +
    positions.length * 12 +
    (normals?.length ?? 0) * 12 +
    (uvs?.length ?? 0) * 8 +
    (colors?.length ?? 0) * 12 +
    indices.length * 4;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint32(0, opts.magic ?? GEOMETRY_MAGIC, true);
  view.setUint32(4, opts.version ?? GEOMETRY_VERSION, true);
  view.setUint32(8, positions.length, true);
  view.setUint32(12, indices.length, true);
  view.setUint32(16, opts.flags, true);
  let offset = 20;
  const put = (rows: number[][], width: number) => {
    for (const row of rows) {
      for (const value of row) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
    }
  };
  put(positions, 3);
  put(normals ?? [], 3);
  put(uvs ?? [], 2);
  put(colors ?? [], 3);
  for (const index of indices) {
    view.setUint32(offset, index, true);
    offset += 4;
  }
  return buffer;
}

describe("decodeGeometry", () => {
  it("decodes all sections in flag order", () => {
    const buffer = buildPayload({
      flags: 0b111,
      positions: [
        [-1, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      normals: [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ],
      uvs: [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ],
      colors: [
        [0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5],
      ],
      indices: [0, 1, 2],
    });

    const geometry = decodeGeometry(buffer);
    expect(Array.from(geometry.positions)).toEqual([-1, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(geometry.normals!)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(Array.from(geometry.uvs!)).toEqual([0, 0, 1, 0, 0.5, 1]);
    expect(Array.from(geometry.colors!)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(Array.from(geometry.indices)).toEqual([0, 1, 2]);
  });

  it("returns null for absent sections", () => {
    const buffer = buildPayload({
      flags: 0b001,
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      normals: [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ],
      indices: [0, 1, 2],
    });

    const geometry = decodeGeometry(buffer);
    expect(geometry.normals).toBeInstanceOf(Float32Array);
    expect(geometry.uvs).toBeNull();
    expect(geometry.colors).toBeNull();
  });

  it("throws on bad magic", () => {
    const buffer = buildPayload({
      magic: 0xdeadbeef,
      flags: 0,
      positions: [[0, 0, 0]],
      indices: [0],
    });
    expect(() => decodeGeometry(buffer)).toThrow(/magic/i);
  });

  it("throws on version mismatch", () => {
    const buffer = buildPayload({
      version: 2,
      flags: 0,
      positions: [[0, 0, 0]],
      indices: [0],
    });
    expect(() => decodeGeometry(buffer)).toThrow(/version/i);
  });

  it("throws on truncated payload", () => {
    const buffer = buildPayload({
      flags: 0,
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      indices: [0, 1, 2],
    });
    expect(() => decodeGeometry(buffer.slice(0, 30))).toThrow(/truncated|short/i);
  });
});

describe("decodeGeometryBatch", () => {
  // Mirrors Rust stage.rs::frame_batch: magic "USBG", version 1, slot
  // count, then per slot status (0 ok / 1 err) + length + bytes, padded to
  // a 4-byte multiple so slot boundaries stay aligned.
  function buildBatch(slots: (ArrayBuffer | string)[]): ArrayBuffer {
    const body = slots.map((slot) => {
      if (slot instanceof ArrayBuffer) {
        return { status: 0, bytes: slot };
      }
      return { status: 1, bytes: new TextEncoder().encode(slot) };
    });
    const size = 12 + body.reduce((sum, slot) => sum + 8 + ((slot.bytes.byteLength + 3) & ~3), 0);
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    view.setUint32(0, 0x55534247, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, slots.length, true);
    let offset = 12;
    for (const slot of body) {
      view.setUint32(offset, slot.status, true);
      view.setUint32(offset + 4, slot.bytes.byteLength, true);
      new Uint8Array(buffer, offset + 8).set(new Uint8Array(slot.bytes));
      offset += 8 + ((slot.bytes.byteLength + 3) & ~3);
    }
    return buffer;
  }

  it("slices ok slots decode identically to per-path payloads", () => {
    const frame = buildPayload({
      flags: 0,
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      indices: [0, 1, 2],
    });
    const slots = decodeGeometryBatch(buildBatch([frame, "no geometry at /World"]));

    expect(slots).toHaveLength(2);
    expect(slots[0]).toBeTruthy();
    expect(slots[1]).toBe(null);
    const decoded = decodeGeometry(slots[0]!);
    expect(Array.from(decoded.positions)).toEqual(Array.from(decodeGeometry(frame).positions));
    expect(Array.from(decoded.indices)).toEqual([0, 1, 2]);
  });

  it("decodes an ok slot that follows an unaligned error slot", () => {
    // I1: "prim not found: /World/Nope" is 27 bytes, so the padding contract
    // is what keeps this ok slot's byteOffset a multiple of 4; without it
    // decodeGeometry throws RangeError on the typed-array view.
    const frame = buildPayload({
      flags: 0,
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      indices: [0, 1, 2],
    });
    const slots = decodeGeometryBatch(buildBatch(["prim not found: /World/Nope", frame]));

    expect(slots).toHaveLength(2);
    expect(slots[0]).toBe(null);
    expect(slots[1]).toBeTruthy();
    const decoded = decodeGeometry(slots[1]!);
    expect(Array.from(decoded.positions)).toEqual(Array.from(decodeGeometry(frame).positions));
    expect(Array.from(decoded.indices)).toEqual([0, 1, 2]);
  });

  it("throws on bad magic and on trailing bytes (material JSON slots share the frame)", () => {
    const frame = buildPayload({ flags: 0, positions: [[0, 0, 0]], indices: [0] });
    const batch = buildBatch([frame]);
    const view = new DataView(batch);
    view.setUint32(0, 0x12345678, true);
    expect(() => decodeGeometryBatch(batch)).toThrow(/magic/i);

    const tooLong = new ArrayBuffer(64);
    new Uint8Array(tooLong).set(new Uint8Array(buildBatch([frame])));
    expect(() => decodeGeometryBatch(tooLong)).toThrow(/trailing/i);
  });

  // Material slots carry UTF-8 JSON (MaterialInfo) instead of a USDB frame;
  // the decode is per-slot JSON.parse over the same frame.
  function jsonSlot(value: unknown): ArrayBuffer {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  it("decodes material slots as parsed JSON and error slots as null", () => {
    const info = { name: "Plastic", surface: { diffuse_color: null, roughness: 0.35 } };
    const slots = decodeMaterialBatch(buildBatch([jsonSlot(info), "prim not found: /World/Nope"]));

    expect(slots).toHaveLength(2);
    expect(slots[0]).toEqual(info);
    expect(slots[1]).toBe(null);
  });
});
