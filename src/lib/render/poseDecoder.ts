// Pure decoders for the playback pose payloads — no invoke, no Svelte: bytes
// in, poses out. The invoke wiring lives in renderState.svelte.ts.
//
// Frame layout (stage.rs::frame_pose), little-endian:
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
//
// Prefixes carry the true byte lengths and the padding is implicit, so decode
// with a cursor rather than typed-array views. The geometry tail's slot order
// is not shipped: like the Rust reader, re-derive it from the node table
// (pre-order, has_geometry && geometry_animated, deduped by path).
//
// The batch variant wraps K frames: `[u32 LE frame count][frames...]`. Frames
// carry no length prefix of their own — the geometry batch's slot headers are
// the only self-describing tail — hence the cursor reader below.
import type { RenderNode } from "../stage/types";
import { decodeGeometryBatch, geometryBatchLength } from "./geometryDecoder";
import type { AnimatedPose } from "./sceneBuilder";

const poseText = new TextDecoder();

const POSE_LEAF = 0xffffffff;
const POSE_NO_MATERIAL = 0xffffffff;
const POSE_FLAG_HAS_GEOMETRY = 1 << 0;
const POSE_FLAG_GEOMETRY_ANIMATED = 1 << 1;
const POSE_FLAG_INSTANCES = 1 << 2;
const POSE_FLAG_IS_POINTS = 1 << 3;
const POSE_FLAG_ANIMATED = 1 << 4;

/** One node of the flat table, before the tree is rebuilt from the ids. */
interface FlatNode {
  path: string;
  firstChild: number;
  childCount: number;
  has_geometry: boolean;
  geometry_animated: boolean;
  animated: boolean;
  is_points: boolean;
  visible: boolean;
  material: string | null;
  transform: number[];
  instances: number[][];
}

/** One pose frame at `start`, plus the offset just past it. */
function readAnimatedPose(payload: ArrayBuffer, start: number): { pose: AnimatedPose; end: number } {
  const view = new DataView(payload);
  const limit = payload.byteLength;
  let offset = start;
  const need = (bytes: number, what: string) => {
    if (offset + bytes > limit) {
      throw new Error(`pose frame truncated reading ${what}: needs ${offset + bytes} bytes, got ${limit}`);
    }
  };
  const u8 = (what: string) => {
    need(1, what);
    const value = view.getUint8(offset);
    offset += 1;
    return value;
  };
  const u16 = (what: string) => {
    need(2, what);
    const value = view.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const u32 = (what: string) => {
    need(4, what);
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const matrix = () => {
    need(64, "node matrix");
    const out: number[] = new Array(16);
    for (let element = 0; element < 16; element++) {
      out[element] = view.getFloat32(offset, true);
      offset += 4;
    }
    return out;
  };
  const text = (what: string) => {
    const length = u32(`${what} length`);
    need(length, what);
    const value = poseText.decode(new Uint8Array(payload, offset, length));
    offset += length;
    return value;
  };
  const align = () => {
    offset = (offset + 3) & ~3;
    need(0, "section padding");
  };

  const paths: string[] = [];
  for (let count = u32("path count"); count > 0; count--) paths.push(text("path"));
  align();
  const materials: string[] = [];
  for (let count = u32("material count"); count > 0; count--) {
    materials.push(text("material"));
    align();
  }

  const flat: FlatNode[] = [];
  const nodeCount = u32("node count");
  for (let index = 0; index < nodeCount; index++) {
    const pathId = u32("node path id");
    const path = paths[pathId];
    if (path === undefined) {
      throw new Error(`pose node ${index} path id ${pathId} is outside the ${paths.length} paths`);
    }
    const firstChild = u32("node first child id");
    const childCount = u16("node child count");
    const flags = u8("node flags");
    const visible = u8("node visibility");
    if (visible > 1) {
      throw new Error(`pose node ${index} visibility byte ${visible}`);
    }
    const materialId = u32("node material id");
    let material: string | null = null;
    if (materialId !== POSE_NO_MATERIAL) {
      material = materials[materialId] ?? null;
      if (material === null) {
        throw new Error(
          `pose node ${index} material id ${materialId} is outside the ${materials.length} materials`,
        );
      }
    }
    const transform = matrix();
    const instances: number[][] = [];
    if (flags & POSE_FLAG_INSTANCES) {
      for (let count = u32("instance count"); count > 0; count--) instances.push(matrix());
    }
    flat.push({
      path,
      firstChild,
      childCount,
      has_geometry: (flags & POSE_FLAG_HAS_GEOMETRY) !== 0,
      geometry_animated: (flags & POSE_FLAG_GEOMETRY_ANIMATED) !== 0,
      animated: (flags & POSE_FLAG_ANIMATED) !== 0,
      is_points: (flags & POSE_FLAG_IS_POINTS) !== 0,
      visible: visible === 1,
      material,
      transform,
      instances,
    });
  }

  // Pre-order: a node's children follow it directly, so first_child_id is
  // index + 1 whenever there are children and the leaf sentinel otherwise.
  // Any other value is a desynced frame, not a tree.
  const build = (id: number): { node: RenderNode; next: number } => {
    const entry = flat[id];
    if (entry === undefined) {
      throw new Error(`pose node ${id} is outside the ${flat.length} nodes`);
    }
    if (entry.childCount === 0 && entry.firstChild !== POSE_LEAF) {
      throw new Error(`pose leaf ${entry.path} points at child ${entry.firstChild}`);
    }
    if (entry.childCount > 0 && entry.firstChild !== id + 1) {
      throw new Error(
        `pose node ${entry.path} first child ${entry.firstChild} is not the next index ${id + 1}`,
      );
    }
    const children: RenderNode[] = [];
    let next = id + 1;
    for (let child = 0; child < entry.childCount; child++) {
      const built = build(next);
      children.push(built.node);
      next = built.next;
    }
    return { node: toRenderNode(entry, children), next };
  };
  const manifest: RenderNode[] = [];
  let cursor = 0;
  while (cursor < flat.length) {
    const root = build(cursor);
    manifest.push(root.node);
    cursor = root.next;
  }

  const slotPaths: string[] = [];
  const seen = new Set<string>();
  const collectSlots = (nodes: RenderNode[]) => {
    for (const node of nodes) {
      if (node.has_geometry && node.geometry_animated && !seen.has(node.path)) {
        seen.add(node.path);
        slotPaths.push(node.path);
      }
      collectSlots(node.children);
    }
  };
  collectSlots(manifest);

  const batchLength = geometryBatchLength(payload, offset);
  const slots = decodeGeometryBatch(new Uint8Array(payload, offset, batchLength));
  if (slots.length !== slotPaths.length) {
    throw new Error(`pose slot count ${slots.length} does not match ${slotPaths.length} deforming paths`);
  }
  const prefetched: AnimatedPose["prefetched"] = new Map();
  slotPaths.forEach((path, slot) => prefetched.set(path, slots[slot] ?? null));
  return { pose: { manifest, prefetched }, end: offset + batchLength };
}

/** The decoded node, in the shape the JSON manifest produced for it. */
function toRenderNode(entry: FlatNode, children: RenderNode[]): RenderNode {
  const slash = entry.path.lastIndexOf("/");
  return {
    path: entry.path,
    name: slash < 0 ? entry.path : entry.path.slice(slash + 1),
    // The frame ships the one type fact the pose path reads instead of the
    // whole type name.
    type_name: entry.is_points ? "Points" : "",
    has_geometry: entry.has_geometry,
    animated: entry.animated,
    geometry_animated: entry.geometry_animated,
    material: entry.material,
    instances: entry.instances,
    transform: entry.transform,
    visible: entry.visible,
    children,
  };
}

// shortcut: the merged pose batches ALL geometry_animated prims with no slot cap (the old 32-slice batching is gone), upgrade to a capped batch + per-prim fallback when a stage with more than ~32 deforming prims appears.
export function decodeAnimatedPose(payload: ArrayBuffer): AnimatedPose {
  const { pose, end } = readAnimatedPose(payload, 0);
  if (end !== payload.byteLength) {
    throw new Error(`pose frame has ${payload.byteLength - end} trailing bytes`);
  }
  return pose;
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
