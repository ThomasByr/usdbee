// poseDecoder tests: the binary pose frame (stage.rs::frame_pose) and the
// batch response framing. Pure decoders — bytes in, poses out. The fixtures
// come from poseFrameFixture, the in-test writer that mirrors the Rust one.

import { describe, expect, it } from "vitest";
import { decodeAnimatedPose, decodeAnimatedPoseBatch } from "./poseDecoder";
import {
  asRenderNodes,
  encodePoseBatch,
  encodePoseFrame,
  emptyPoseBatch,
  identityMatrix,
  type PoseFixtureNode,
} from "./poseFrameFixture";

const translate = (x: number, y: number, z: number) => {
  const matrix = identityMatrix();
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
};

// A batch tail with one ok slot per payload (geometryDecoder framing).
function slotBatch(payloads: number[][]): ArrayBuffer {
  const padded = payloads.map((payload) => (payload.length + 3) & ~3);
  const buffer = new ArrayBuffer(12 + padded.reduce((sum, length) => sum + 8 + length, 0));
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534247, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, payloads.length, true);
  let offset = 12;
  payloads.forEach((payload, slot) => {
    view.setUint32(offset + 4, payload.length, true);
    new Uint8Array(buffer, offset + 8, payload.length).set(payload);
    offset += 8 + padded[slot]!;
  });
  return buffer;
}

const TREE: PoseFixtureNode[] = [
  {
    path: "/Scene",
    transform: translate(0.5, -2, 3.25),
    children: [
      {
        path: "/Scene/Ground",
        has_geometry: true,
        geometry_animated: true,
        material: "/Looks/Stone",
        transform: translate(1, 0, 0),
      },
      {
        path: "/Scene/Sparks",
        has_geometry: true,
        geometry_animated: true,
        type_name: "Points",
        material: "/Looks/Spark",
      },
      { path: "/Scene/Hidden", has_geometry: true, visible: false },
      {
        path: "/Scene/Swarm",
        has_geometry: true,
        geometry_animated: true,
        material: "/Looks/Stone",
        instances: [translate(1, 2, 3), translate(4, 5, 6)],
        children: [{ path: "/Scene/Swarm/Shape", has_geometry: true, visible: false }],
      },
    ],
  },
  { path: "/Empty" },
];

// The deforming slots of TREE: pre-order, has_geometry && geometry_animated,
// deduped by path.
const SLOTS = ["/Scene/Ground", "/Scene/Sparks", "/Scene/Swarm"];

function treeFrame(): ArrayBuffer {
  return encodePoseFrame(TREE, slotBatch([[1], [2, 2], [3, 3, 3]]));
}

// The node table's first record, walked from the two string tables.
function nodeTableOffset(frame: ArrayBuffer): number {
  const view = new DataView(frame);
  let at = 4;
  for (let count = view.getUint32(0, true); count > 0; count--) at += 4 + view.getUint32(at, true);
  at = (at + 3) & ~3;
  const materials = view.getUint32(at, true);
  at += 4;
  for (let count = materials; count > 0; count--) {
    at += 4 + view.getUint32(at, true);
    at = (at + 3) & ~3;
  }
  return at + 4;
}

function corrupt(frame: ArrayBuffer, patch: (view: DataView, nodes: number) => void): ArrayBuffer {
  const copy = frame.slice(0);
  patch(new DataView(copy), nodeTableOffset(copy));
  return copy;
}

describe("decodeAnimatedPose", () => {
  it("rebuilds the node table as the tree the JSON decode produced", () => {
    const pose = decodeAnimatedPose(treeFrame());

    expect(pose.manifest).toEqual(asRenderNodes(TREE));
  });

  it("carries materials, is_points and instance matrices through", () => {
    const [scene] = decodeAnimatedPose(treeFrame()).manifest;
    const byPath = new Map((scene?.children ?? []).map((child) => [child.path, child]));

    expect(byPath.get("/Scene/Ground")?.material).toBe("/Looks/Stone");
    expect(byPath.get("/Scene/Sparks")?.material).toBe("/Looks/Spark");
    expect(byPath.get("/Scene/Sparks")?.type_name).toBe("Points");
    expect(byPath.get("/Scene/Ground")?.type_name).toBe("");
    expect(byPath.get("/Scene/Hidden")?.material).toBeNull();
    expect(byPath.get("/Scene/Hidden")?.visible).toBe(false);
    const swarm = byPath.get("/Scene/Swarm")!;
    expect(swarm.instances).toEqual([translate(1, 2, 3), translate(4, 5, 6)]);
    expect(swarm.children[0]?.instances).toEqual([]);
  });

  it("keys the geometry slots by the deforming paths, in pre-order", () => {
    const pose = decodeAnimatedPose(treeFrame());

    expect([...pose.prefetched.keys()]).toEqual(SLOTS);
    expect(new Uint8Array(pose.prefetched.get("/Scene/Ground")!)).toEqual(new Uint8Array([1]));
    expect(new Uint8Array(pose.prefetched.get("/Scene/Sparks")!)).toEqual(new Uint8Array([2, 2]));
    expect(new Uint8Array(pose.prefetched.get("/Scene/Swarm")!)).toEqual(new Uint8Array([3, 3, 3]));
  });

  it("keeps one slot for a path repeated in the frame", () => {
    const repeated: PoseFixtureNode[] = [
      {
        path: "/A",
        has_geometry: true,
        geometry_animated: true,
        children: [
          { path: "/B", has_geometry: true, geometry_animated: true },
          { path: "/B", has_geometry: true, geometry_animated: true },
          { path: "/C", has_geometry: true, geometry_animated: true },
        ],
      },
    ];
    const pose = decodeAnimatedPose(encodePoseFrame(repeated, slotBatch([[7], [8], [9]])));

    // Four deforming nodes, three distinct paths: one slot per path.
    expect([...pose.prefetched.keys()]).toEqual(["/A", "/B", "/C"]);
    expect(new Uint8Array(pose.prefetched.get("/B")!)).toEqual(new Uint8Array([8]));
  });

  it("decodes an empty frame", () => {
    const pose = decodeAnimatedPose(encodePoseFrame([], emptyPoseBatch()));

    expect(pose.manifest).toEqual([]);
    expect(pose.prefetched.size).toBe(0);
  });

  it("rejects a slot count that disagrees with the deforming paths", () => {
    const frame = encodePoseFrame(TREE, slotBatch([[1], [2]]));

    expect(() => decodeAnimatedPose(frame)).toThrow(/slot count 2 .* 3/);
  });

  it("rejects a node path id outside the table", () => {
    const frame = corrupt(treeFrame(), (view, nodes) => view.setUint32(nodes, 99, true));

    expect(() => decodeAnimatedPose(frame)).toThrow(/path id 99/);
  });

  it("rejects a material id outside the table", () => {
    const frame = corrupt(treeFrame(), (view, nodes) => view.setUint32(nodes + 12, 99, true));

    expect(() => decodeAnimatedPose(frame)).toThrow(/material id 99/);
  });

  it("rejects a visibility byte that is not 0 or 1", () => {
    const frame = corrupt(treeFrame(), (view, nodes) => view.setUint8(nodes + 11, 2));

    expect(() => decodeAnimatedPose(frame)).toThrow(/visibility byte 2/);
  });

  it("rejects a truncated frame", () => {
    const frame = treeFrame().slice(0, 60);

    expect(() => decodeAnimatedPose(frame)).toThrow(/truncated/);
  });

  it("rejects trailing bytes after the frame", () => {
    const frame = treeFrame();
    const payload = new ArrayBuffer(frame.byteLength + 4);
    new Uint8Array(payload).set(new Uint8Array(frame));

    expect(() => decodeAnimatedPose(payload)).toThrow(/trailing bytes/);
  });
});

describe("decodeAnimatedPoseBatch", () => {
  it("decodes K frames exactly like K single decodes", () => {
    const frames = [
      treeFrame(),
      encodePoseFrame([{ path: "/Moved", has_geometry: true, geometry_animated: true }], slotBatch([[9]])),
      encodePoseFrame([], emptyPoseBatch()),
    ];

    const batch = decodeAnimatedPoseBatch(encodePoseBatch(frames), [1, 2, 3]);
    const singles = frames.map((frame) => decodeAnimatedPose(frame));

    expect(batch).toEqual(singles);
    expect(batch[1]!.manifest).toEqual([
      asRenderNodes([{ path: "/Moved", has_geometry: true, geometry_animated: true }])[0],
    ]);
  });

  it("throws when the frame count does not match the requested codes", () => {
    const payload = encodePoseBatch([treeFrame(), treeFrame()]);

    expect(() => decodeAnimatedPoseBatch(payload, [1, 2, 3])).toThrow(/2 frames for 3/);
    expect(() => decodeAnimatedPoseBatch(payload, [1])).toThrow(/2 frames for 1/);
  });

  it("decodes an empty batch", () => {
    expect(decodeAnimatedPoseBatch(encodePoseBatch([]), [])).toEqual([]);
  });

  it("rejects trailing bytes after the last frame", () => {
    const frame = treeFrame();
    const payload = new ArrayBuffer(4 + frame.byteLength + 4);
    new DataView(payload).setUint32(0, 1, true);
    new Uint8Array(payload, 4, frame.byteLength).set(new Uint8Array(frame));

    expect(() => decodeAnimatedPoseBatch(payload, [1])).toThrow(/trailing bytes/);
  });
});
