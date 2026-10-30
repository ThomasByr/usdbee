import { describe, expect, it } from "vitest";
import { decodeGeometry, GEOMETRY_MAGIC, GEOMETRY_VERSION } from "./geometryDecoder";

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
