// Test-only writer for the binary pose frame (stage.rs::frame_pose), the
// counterpart of the decoder in poseDecoder.ts. The suites that need pose
// bytes (poseDecoder, renderState, sceneIntegration) share this builder so a
// layout change breaks one file instead of three.
//
// Frame layout, little-endian:
//   [u32 path count][per path: u32 len + utf8][pad to 4]
//   [u32 material count][per material: u32 len + utf8][pad to 4]
//   [u32 node count][per node, pre-order]
//   [geometry batch]
// and node =
//   [u32 path id][u32 first child id (0xFFFF_FFFF for a leaf)][u16 child
//   count][u8 flags][u8 visible][u32 material id (0xFFFF_FFFF for none)]
//   [16 x f32 matrix]
//   [u32 instance count][instance count x 16 f32]   // only when flags bit2
// flags: bit0 has_geometry, bit1 geometry_animated, bit2 has_instances,
// bit3 is_points, bit4 animated.
import type { RenderNode } from "../stage/types";

const POSE_LEAF = 0xffffffff;
const POSE_NO_MATERIAL = 0xffffffff;
const POSE_FLAG_HAS_GEOMETRY = 1 << 0;
const POSE_FLAG_GEOMETRY_ANIMATED = 1 << 1;
const POSE_FLAG_INSTANCES = 1 << 2;
const POSE_FLAG_IS_POINTS = 1 << 3;
const POSE_FLAG_ANIMATED = 1 << 4;

export interface PoseFixtureNode {
  path: string;
  children?: PoseFixtureNode[];
  transform?: number[];
  visible?: boolean;
  has_geometry?: boolean;
  geometry_animated?: boolean;
  animated?: boolean;
  type_name?: string;
  material?: string | null;
  instances?: number[][];
}

const encoder = new TextEncoder();

export function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/// The tree the old JSON decode produced for the same fixture, so a test can
/// deep-compare the decoded frame against it. `name` is the path's last
/// segment, `animated` defaults to `geometry_animated` (a deforming node always
/// moves) and `type_name` defaults to "" because the frame carries only the one
/// type fact the pose path tests for: Points.
export function asRenderNodes(nodes: PoseFixtureNode[]): RenderNode[] {
  return nodes.map((node) => {
    const slash = node.path.lastIndexOf("/");
    return {
      path: node.path,
      name: slash < 0 ? node.path : node.path.slice(slash + 1),
      type_name: node.type_name ?? "",
      has_geometry: node.has_geometry ?? false,
      animated: node.animated ?? node.geometry_animated ?? false,
      geometry_animated: node.geometry_animated ?? false,
      material: node.material ?? null,
      instances: node.instances ?? [],
      transform: node.transform ?? identityMatrix(),
      visible: node.visible ?? true,
      children: asRenderNodes(node.children ?? []),
    };
  });
}

/// An empty geometry batch: the tail of every frame that ships no slots.
export function emptyPoseBatch(): ArrayBuffer {
  const out = new Writer();
  out.u32(0x55534247);
  out.u32(1);
  out.u32(0);
  return out.finish();
}

/// One pose frame with `batch` as its geometry tail (an empty batch default).
export function encodePoseFrame(nodes: PoseFixtureNode[], batch = emptyPoseBatch()): ArrayBuffer {
  const flat: PoseFixtureNode[] = [];
  const flatten = (entries: PoseFixtureNode[]) => {
    for (const entry of entries) {
      flat.push(entry);
      flatten(entry.children ?? []);
    }
  };
  flatten(nodes);

  const pathIds = new Map<string, number>();
  for (const node of flat) if (!pathIds.has(node.path)) pathIds.set(node.path, pathIds.size);
  const materialIds = new Map<string, number>();
  for (const node of flat) {
    if (node.material != null && !materialIds.has(node.material)) {
      materialIds.set(node.material, materialIds.size);
    }
  }

  const out = new Writer();
  out.u32(pathIds.size);
  for (const path of pathIds.keys()) out.text(path);
  out.align();
  out.u32(materialIds.size);
  for (const binding of materialIds.keys()) {
    out.text(binding);
    out.align();
  }
  out.u32(flat.length);
  flat.forEach((node, index) => {
    const children = (node.children ?? []).length;
    let flags = 0;
    if (node.has_geometry) flags |= POSE_FLAG_HAS_GEOMETRY;
    if (node.geometry_animated) flags |= POSE_FLAG_GEOMETRY_ANIMATED;
    if ((node.instances ?? []).length > 0) flags |= POSE_FLAG_INSTANCES;
    if (node.type_name === "Points") flags |= POSE_FLAG_IS_POINTS;
    if (node.animated ?? node.geometry_animated) flags |= POSE_FLAG_ANIMATED;
    out.u32(pathIds.get(node.path)!);
    out.u32(children === 0 ? POSE_LEAF : index + 1);
    out.u16(children);
    out.u8(flags);
    out.u8(node.visible === false ? 0 : 1);
    out.u32(node.material != null ? materialIds.get(node.material)! : POSE_NO_MATERIAL);
    for (const value of node.transform ?? identityMatrix()) out.f32(value);
    const instances = node.instances ?? [];
    if (instances.length > 0) {
      out.u32(instances.length);
      for (const instance of instances) for (const value of instance) out.f32(value);
    }
  });
  const head = out.finish();
  const frame = new Uint8Array(head.byteLength + batch.byteLength);
  frame.set(new Uint8Array(head));
  frame.set(new Uint8Array(batch), head.byteLength);
  return frame.buffer;
}

/// The batch response: a u32 frame count, then the frames back to back.
export function encodePoseBatch(frames: ArrayBuffer[]): ArrayBuffer {
  const total = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const out = new Uint8Array(4 + total);
  new DataView(out.buffer).setUint32(0, frames.length, true);
  let offset = 4;
  for (const frame of frames) {
    out.set(new Uint8Array(frame), offset);
    offset += frame.byteLength;
  }
  return out.buffer;
}

/// Little-endian byte writer; the tables have no fixed size up front.
class Writer {
  private bytes: number[] = [];
  private scratch = new DataView(new ArrayBuffer(4));

  u8(value: number) {
    this.bytes.push(value & 0xff);
  }

  u16(value: number) {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  u32(value: number) {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  f32(value: number) {
    this.scratch.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) this.bytes.push(this.scratch.getUint8(i));
  }

  text(value: string) {
    const encoded = encoder.encode(value);
    this.u32(encoded.length);
    for (const byte of encoded) this.bytes.push(byte);
  }

  align() {
    while (this.bytes.length % 4 !== 0) this.bytes.push(0);
  }

  finish(): ArrayBuffer {
    return new Uint8Array(this.bytes).buffer;
  }
}
