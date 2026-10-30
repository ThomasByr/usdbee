// Pure decoder for the Rust `get_geometry_data` binary payload — no Svelte,
// no invoke: ArrayBuffer in, typed arrays out. Any invoke/Response
// conversion wiring belongs to the +page layer (Task 4). The returned
// arrays are zero-copy views into `buffer`, so the caller must keep the
// payload alive while they are in use. Layout (little-endian) mirrors
// tessellation.rs::pack_geometry: magic u32, version u32, vertex_count u32,
// index_count u32, flags u32 (bit0 normals, bit1 uvs, bit2 colors); then
// positions f32x3, normals f32x3, uvs f32x2, colors f32x3 in flag order,
// then indices u32.
import type { GeometryHeader } from "../stage/types";

export const GEOMETRY_MAGIC = 0x55534442;
export const GEOMETRY_VERSION = 1;

export const FLAG_HAS_NORMALS = 1 << 0;
export const FLAG_HAS_UVS = 1 << 1;
export const FLAG_HAS_COLORS = 1 << 2;

export interface DecodedGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array;
}

const HEADER_BYTES = 20;

export function decodeGeometry(buffer: ArrayBuffer): DecodedGeometry {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`geometry payload truncated: ${buffer.byteLength} bytes, header needs ${HEADER_BYTES}`);
  }
  const view = new DataView(buffer);
  const header: GeometryHeader = {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    vertex_count: view.getUint32(8, true),
    index_count: view.getUint32(12, true),
    flags: view.getUint32(16, true),
  };
  if (header.magic !== GEOMETRY_MAGIC) {
    throw new Error(
      `bad geometry magic: 0x${header.magic.toString(16)}, expected 0x${GEOMETRY_MAGIC.toString(16)}`,
    );
  }
  if (header.version !== GEOMETRY_VERSION) {
    throw new Error(`unsupported geometry version: ${header.version}, expected ${GEOMETRY_VERSION}`);
  }

  let offset = HEADER_BYTES;
  const need = (bytes: number, what: string) => {
    if (offset + bytes > buffer.byteLength) {
      throw new Error(
        `geometry payload truncated in ${what}: needs ${offset + bytes} bytes, got ${buffer.byteLength}`,
      );
    }
  };
  const readF32xN = (count: number, width: number): Float32Array => {
    const bytes = count * width * 4;
    need(bytes, "vertex data");
    const out = new Float32Array(buffer, offset, count * width);
    offset += bytes;
    return out;
  };

  const positions = readF32xN(header.vertex_count, 3);
  const normals = header.flags & FLAG_HAS_NORMALS ? readF32xN(header.vertex_count, 3) : null;
  const uvs = header.flags & FLAG_HAS_UVS ? readF32xN(header.vertex_count, 2) : null;
  const colors = header.flags & FLAG_HAS_COLORS ? readF32xN(header.vertex_count, 3) : null;
  need(header.index_count * 4, "indices");
  const indices = new Uint32Array(buffer, offset, header.index_count);
  offset += header.index_count * 4;

  return { positions, normals, uvs, colors, indices };
}
