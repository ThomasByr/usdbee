// sceneBuilder tests (Phase 2, Task 4): a manifest fixture builds an
// Object3D hierarchy named by prim path, InstancedMeshes carry per-prototype
// instance matrices, visibility flags are honored, and fetch failures fail
// soft (fallback material; mesh skipped, node kept, scene returned).

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { buildScene } from "./sceneBuilder";
import type { RenderNode } from "../stage/types";

// A valid packed geometry payload for one triangle (layout: geometryDecoder).
function packedGeometry(): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + 9 * 4 + 3 * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true); // magic
  view.setUint32(4, 1, true); // version
  view.setUint32(8, 3, true); // vertex_count
  view.setUint32(12, 3, true); // index_count
  view.setUint32(16, 0, true); // flags
  new Float32Array(buffer, 20, 9).set([-1, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint32Array(buffer, 20 + 36, 3).set([0, 1, 2]);
  return buffer;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function node(overrides: Partial<RenderNode>): RenderNode {
  return {
    path: "/World",
    name: "World",
    type_name: "Xform",
    has_geometry: false,
    animated: false,
    material: null,
    instances: [],
    transform: IDENTITY,
    visible: true,
    children: [],
    ...overrides,
  };
}

function fetchers(overrides: Partial<Parameters<typeof buildScene>[1]> = {}) {
  return {
    getGeometry: vi.fn(async () => packedGeometry()),
    getMaterial: vi.fn(async () => ({ name: "Mat", surface: null })),
    loadTexture: vi.fn(() => null),
    ...overrides,
  };
}

describe("buildScene", () => {
  it("builds the hierarchy named by prim path with transforms applied", async () => {
    const manifest = [
      node({
        path: "/World",
        children: [
          node({
            path: "/World/Ball",
            name: "Ball",
            type_name: "Mesh",
            has_geometry: true,
            material: "/World/Looks/Red",
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
          }),
        ],
      }),
    ];
    const group = await buildScene(manifest, fetchers());

    expect(group.children.map((child) => child.name)).toEqual(["/World"]);
    const world = group.children[0];
    expect(world.children.map((child) => child.name)).toEqual(["/World/Ball"]);

    // The USD row-major row-vector matrix maps straight onto three.js
    // Matrix4.fromArray, so decomposed position is the translation row.
    expect(world.position.toArray()).toEqual([0, 0, 0]);
    const ball = world.getObjectByName("/World/Ball")!;
    expect(ball).toBeTruthy();
    expect(ball.position.toArray()).toEqual([3, 4, 5]);
  });

  it("builds one InstancedMesh per prototype child with count and matrices from instances", async () => {
    const manifest = [
      node({
        path: "/World/Instancer",
        name: "Instancer",
        type_name: "PointInstancer",
        children: [
          node({
            path: "/World/Instancer/__proto_0",
            name: "__proto_0",
            type_name: "Mesh",
            has_geometry: true,
            instances: [IDENTITY, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 8, 7, 1]],
          }),
        ],
      }),
    ];
    const group = await buildScene(manifest, fetchers());

    const instanced = group.getObjectByName("/World/Instancer/__proto_0")!.children[0];
    expect((instanced as THREE.InstancedMesh).isInstancedMesh).toBe(true);
    expect((instanced as THREE.InstancedMesh).count).toBe(2);
    const matrix = new THREE.Matrix4();
    (instanced as THREE.InstancedMesh).getMatrixAt(1, matrix);
    expect(matrix.elements[12]).toBe(9);
    expect(matrix.elements[13]).toBe(8);
    expect(matrix.elements[14]).toBe(7);
  });

  it("honors visible=false on the node's Object3D", async () => {
    const manifest = [node({ path: "/World/Hidden", name: "Hidden", visible: false, has_geometry: true })];
    const group = await buildScene(manifest, fetchers());

    expect(group.getObjectByName("/World/Hidden")!.visible).toBe(false);
  });

  it("fails soft on material fetch failure: mesh built with fallback material", async () => {
    const manifest = [node({ path: "/World/Ball", name: "Ball", type_name: "Mesh", has_geometry: true })];
    const group = await buildScene(manifest, fetchers({ getMaterial: vi.fn(async () => null) }));

    const ball = group.getObjectByName("/World/Ball")!;
    const mesh = ball.children.find((child) => (child as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(mesh).toBeTruthy();
    expect((mesh.material as THREE.Material).type).toBe("MeshPhysicalMaterial");
  });

  it("fails soft on geometry fetch failure: node kept without a mesh, scene returned", async () => {
    const manifest = [
      node({
        path: "/World",
        children: [
          node({ path: "/World/Broken", name: "Broken", type_name: "Mesh", has_geometry: true }),
          node({ path: "/World/Ok", name: "Ok", type_name: "Mesh", has_geometry: true }),
        ],
      }),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const group = await buildScene(
      manifest,
      fetchers({
        getGeometry: vi.fn(async (path: string) => {
          if (path === "/World/Broken") throw new Error("no geometry");
          return packedGeometry();
        }),
      }),
    );

    const broken = group.getObjectByName("/World/Broken")!;
    expect(broken).toBeTruthy();
    expect(broken.children.filter((child) => (child as THREE.Mesh).isMesh)).toHaveLength(0);
    expect(group.getObjectByName("/World/Ok")!.children[0]).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
