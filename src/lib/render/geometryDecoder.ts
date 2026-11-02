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

// Batched fetch (Phase 2.5 Task 3) header, little-endian, mirrored by
// src-tauri/src/stage.rs::frame_batch: batch magic "USBG" (0x55534247),
// version u32, slot_count u32, then per slot status u32 (0 ok / 1 error),
// length u32, bytes (the per-path USDB frame, or a UTF-8 error message),
// zero-padded to a 4-byte multiple. The padding keeps every slot payload
// view aligned; the decoder skips it via the aligned slot stride.
export const GEOMETRY_BATCH_MAGIC = 0x55534247;
export const GEOMETRY_BATCH_VERSION = 1;

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

export function decodeGeometry(buffer: ArrayBuffer | Uint8Array): DecodedGeometry {
  // Batch slots arrive zero-copy as positioned Uint8Array views into the
  // batch payload; a plain ArrayBuffer starts at offset 0.
  const based = buffer instanceof Uint8Array;
  const baseOffset = based ? buffer.byteOffset : 0;
  const baseBuffer = based ? (buffer.buffer as ArrayBuffer) : (buffer as ArrayBuffer);
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`geometry payload truncated: ${buffer.byteLength} bytes, header needs ${HEADER_BYTES}`);
  }
  const view = new DataView(baseBuffer, baseOffset, buffer.byteLength);
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
    const out = new Float32Array(baseBuffer, baseOffset + offset, count * width);
    offset += bytes;
    return out;
  };

  const positions = readF32xN(header.vertex_count, 3);
  const normals = header.flags & FLAG_HAS_NORMALS ? readF32xN(header.vertex_count, 3) : null;
  const uvs = header.flags & FLAG_HAS_UVS ? readF32xN(header.vertex_count, 2) : null;
  const colors = header.flags & FLAG_HAS_COLORS ? readF32xN(header.vertex_count, 3) : null;
  need(header.index_count * 4, "indices");
  const indices = new Uint32Array(baseBuffer, baseOffset + offset, header.index_count);
  offset += header.index_count * 4;

  return { positions, normals, uvs, colors, indices };
}

// One batched response -> per-slot bytes: a positioned USDB-frame view per
// ok slot (decodable with decodeGeometry), null for an error slot. The
// views share the batch payload; keep it alive while slots are in use.
export function decodeGeometryBatch(buffer: ArrayBuffer): (Uint8Array | null)[] {
  if (buffer.byteLength < 12) {
    throw new Error(`geometry batch payload truncated: ${buffer.byteLength} bytes, header needs 12`);
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== GEOMETRY_BATCH_MAGIC) {
    throw new Error(
      `bad geometry batch magic: 0x${magic.toString(16)}, expected 0x${GEOMETRY_BATCH_MAGIC.toString(16)}`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== GEOMETRY_BATCH_VERSION) {
    throw new Error(
      `unsupported geometry batch version: ${version}, expected ${GEOMETRY_BATCH_VERSION}`,
    );
  }
  const slotCount = view.getUint32(8, true);

  let offset = 12;
  const slots: (Uint8Array | null)[] = [];
  for (let slot = 0; slot < slotCount; slot++) {
    if (offset + 8 > buffer.byteLength) {
      throw new Error(`geometry batch payload truncated in slot ${slot} header`);
    }
    const status = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    if (offset + 8 + length > buffer.byteLength) {
      throw new Error(
        `geometry batch payload truncated in slot ${slot}: needs ${offset + 8 + length} bytes, got ${buffer.byteLength}`,
      );
    }
    slots.push(status === 0 ? new Uint8Array(buffer, offset + 8, length) : null);
    // The frame pads each payload to a 4-byte multiple so the next slot's
    // header and view stay aligned; the length field is the real size.
    offset += 8 + ((length + 3) & ~3);
  }
  if (offset !== buffer.byteLength) {
    throw new Error(`geometry batch payload has ${buffer.byteLength - offset} trailing bytes`);
  }
  return slots;
}
