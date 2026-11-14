// sceneBuilder tests (Phase 2, Task 4): a manifest fixture builds an
// Object3D hierarchy named by prim path, InstancedMeshes carry per-prototype
// instance matrices, visibility flags are honored, and fetch failures fail
// soft (fallback material; mesh skipped, node kept, scene returned).

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  applyPackedGeometryInPlace,
  buildScene,
  disposeScene,
  isLayoutCompatible,
  toBufferGeometry,
} from "./sceneBuilder";
import * as materialConverter from "./materialConverter";
import type { MaterialInfo, RenderNode } from "../stage/types";

// A valid packed geometry payload for one triangle (layout: geometryDecoder).
// `y` parameterizes the third vertex's height so tests can tell payloads apart.
function packedGeometry(y = 1): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + 9 * 4 + 3 * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true); // magic
  view.setUint32(4, 1, true); // version
  view.setUint32(8, 3, true); // vertex_count
  view.setUint32(12, 3, true); // index_count
  view.setUint32(16, 0, true); // flags
  new Float32Array(buffer, 20, 9).set([-1, 0, 0, 1, 0, 0, 0, y, 0]);
  new Uint32Array(buffer, 20 + 36, 3).set([0, 1, 2]);
  return buffer;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Textures attach on a promise chain; one macrotask flushes it.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// One triangle carrying per-vertex colors (constant displayColor replicated
// by tessellation): flag bit2 set, colors section between positions and indices.
function packedColoredGeometry(): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + 9 * 4 + 9 * 4 + 3 * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true); // magic
  view.setUint32(4, 1, true); // version
  view.setUint32(8, 3, true); // vertex_count
  view.setUint32(12, 3, true); // index_count
  view.setUint32(16, 0b100, true); // has_colors
  new Float32Array(buffer, 20, 9).set([-1, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Float32Array(buffer, 20 + 36, 9).set([0.25, 0.5, 0.75, 0.25, 0.5, 0.75, 0.25, 0.5, 0.75]);
  new Uint32Array(buffer, 20 + 72, 3).set([0, 1, 2]);
  return buffer;
}

function node(overrides: Partial<RenderNode>): RenderNode {
  return {
    path: "/World",
    name: "World",
    type_name: "Xform",
    has_geometry: false,
    animated: false,
    geometry_animated: false,
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
    loadTexture: vi.fn(async () => new THREE.Texture()),
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
    // Matrix4.fromArray, including its translation row.
    expect(world.matrix.elements.slice(12, 15)).toEqual([0, 0, 0]);
    const ball = world.getObjectByName("/World/Ball")!;
    expect(ball).toBeTruthy();
    expect(ball.matrix.elements.slice(12, 15)).toEqual([3, 4, 5]);
  });

  it("preserves a shear-bearing manifest matrix instead of reducing it to TRS", async () => {
    const shear = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1];
    const group = await buildScene(
      [node({ path: "/World/Sheared", name: "Sheared", transform: shear })],
      fetchers(),
    );

    const object = group.getObjectByName("/World/Sheared")!;
    expect(object.matrixAutoUpdate).toBe(false);
    expect(object.matrix.elements).toEqual(shear);
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

  it("renders Xform-rooted prototype children one InstancedMesh per geometry child", async () => {
    const translate = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
    const manifest = [
      node({
        path: "/World/Instancer",
        name: "Instancer",
        type_name: "PointInstancer",
        children: [
          node({
            path: "/World/Instancer/__proto_0",
            name: "__proto_0",
            type_name: "Xform",
            instances: [translate(10, 0, 0), translate(0, 20, 0), translate(0, 0, 30)],
            children: [
              node({
                path: "/World/Instancer/__proto_0/Shape",
                name: "Shape",
                type_name: "Mesh",
                has_geometry: true,
                material: "/World/Looks/Blue",
                transform: translate(2, 3, 4),
              }),
            ],
          }),
        ],
      }),
    ];
    const getGeometry = vi.fn(async () => packedGeometry());
    const getMaterial = vi.fn(async () => ({ name: "Blue", surface: null }));
    const group = await buildScene(manifest, { ...fetchers(), getGeometry, getMaterial });

    // Geometry is fetched per real subtree path (manifest child), the
    // child's material binding applies, and one InstancedMesh carries all 3
    // instances of the child geometry — no phantom origin Mesh.
    expect(getGeometry).toHaveBeenCalledWith("/World/Instancer/__proto_0/Shape", undefined);
    expect(getMaterial).toHaveBeenCalledWith("/World/Looks/Blue");
    const proto = group.getObjectByName("/World/Instancer/__proto_0")!;
    const meshes = proto.children.find((child) => child.name === "/World/Instancer/__proto_0/Shape")!
      .children[0] as THREE.InstancedMesh;
    expect(meshes.isInstancedMesh).toBe(true);
    expect(meshes.count).toBe(3);
    expect((meshes.material as THREE.Material).type).toBe("MeshPhysicalMaterial");
    expect(
      group
        .getObjectByName("/World/Instancer/__proto_0")!
        .children.some((child) => (child as THREE.Mesh).isMesh),
    ).toBe(false);

    // Instance matrix (row-major, folded proto xform) x child local
    // transform: instance 0 = translate(10,0,0) x translate(2,3,4).
    const matrix = new THREE.Matrix4();
    meshes.getMatrixAt(0, matrix);
    expect(matrix.elements.slice(12, 15)).toEqual([12, 3, 4]);
    meshes.getMatrixAt(1, matrix);
    expect(matrix.elements.slice(12, 15)).toEqual([2, 23, 4]);
  });

  it("renders constant displayColor on unbound meshes as vertex colors", async () => {
    // Kitchen_set shape: no bound material, displayColor arrives as a
    // per-vertex "color" attribute; the material must opt into it or
    // three.js ignores the attribute and the mesh renders default gray.
    const manifest = [node({ path: "/World/Panel", name: "Panel", type_name: "Mesh", has_geometry: true })];
    const group = await buildScene(
      manifest,
      fetchers({ getGeometry: vi.fn(async () => packedColoredGeometry()) }),
    );

    const mesh = group.getObjectByName("/World/Panel")!.children[0] as THREE.Mesh;
    expect((mesh.geometry.getAttribute("color") as THREE.BufferAttribute).array).toEqual(
      new Float32Array([0.25, 0.5, 0.75, 0.25, 0.5, 0.75, 0.25, 0.5, 0.75]),
    );
    const material = mesh.material as THREE.MeshPhysicalMaterial;
    expect(material.vertexColors).toBe(true);
    // No bound surface: the diffuse color stays neutral so the vertex
    // colors show unmultiplied.
    expect(material.color.getHex()).toBe(0xffffff);
    // Instanced meshes share the same material path per prototype child.
    material.dispose();
  });

  it("keeps a bound diffuse texture over per-vertex colors", async () => {
    // A bound material wins over displayColor: a diffuse map must not be
    // tinted by the mesh's vertex colors.
    const manifest = [
      node({
        path: "/World/Floor",
        name: "Floor",
        type_name: "Mesh",
        has_geometry: true,
        material: "/World/Looks/Floor",
      }),
    ];
    const group = await buildScene(
      manifest,
      fetchers({
        getGeometry: vi.fn(async () => packedColoredGeometry()),
        getMaterial: vi.fn(async () => ({
          name: "Floor",
          surface: {
            diffuse_color: null,
            roughness: null,
            metallic: null,
            opacity: null,
            normal: null,
            textures: [{ input: "diffuseColor", file_path: "/cache/checker.png", st_primvar: "st" }],
          },
        })),
        loadTexture: vi.fn(async () => new THREE.Texture()),
      }),
    );

    const mesh = group.getObjectByName("/World/Floor")!.children[0] as THREE.Mesh;
    expect((mesh.material as THREE.MeshPhysicalMaterial).vertexColors).toBe(false);
  });

  it("upgrades a built mesh's material in place when its texture lands later", async () => {
    // buildScene finishes before the decodes do: the mesh must already render
    // with the authored constant, then take the map on the SAME material.
    let land!: (texture: THREE.Texture) => void;
    const group = await buildScene(
      [
        node({
          path: "/World/Floor",
          name: "Floor",
          type_name: "Mesh",
          has_geometry: true,
          material: "/World/Looks/Floor",
        }),
      ],
      fetchers({
        getMaterial: vi.fn(async () => ({
          name: "Floor",
          surface: {
            diffuse_color: { type: "color3f", data: [0.5, 0.25, 0.125] },
            roughness: null,
            metallic: null,
            opacity: null,
            normal: null,
            textures: [{ input: "diffuseColor", file_path: "/cache/checker.png", st_primvar: "st" }],
          },
        })),
        loadTexture: vi.fn(
          () =>
            new Promise<THREE.Texture>((resolve) => {
              land = resolve;
            }),
        ),
      }),
    );

    const mesh = group.getObjectByName("/World/Floor")!.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshPhysicalMaterial;
    expect(material.map).toBeNull();
    expect(material.color.r).toBeCloseTo(0.5); // the authored constant

    const texture = new THREE.Texture();
    land(texture);
    await flush();

    expect(mesh.material).toBe(material); // upgraded, not replaced
    expect(material.map).toBe(texture);
    expect(material.color.r).toBeCloseTo(1); // map wins over the constant
  });

  it("keeps a bound untextured material's diffuse color over per-vertex colors", async () => {
    // A bound material wins even without a diffuse map: a constant
    // diffuse_color must not be multiplied by the mesh's vertex colors
    // (green x red would render black).
    const manifest = [
      node({
        path: "/World/Panel",
        name: "Panel",
        type_name: "Mesh",
        has_geometry: true,
        material: "/World/Looks/Green",
      }),
    ];
    const group = await buildScene(
      manifest,
      fetchers({
        getGeometry: vi.fn(async () => packedColoredGeometry()),
        getMaterial: vi.fn(async () => ({
          name: "Green",
          surface: {
            diffuse_color: { type: "color3f", data: [0, 1, 0] },
            roughness: null,
            metallic: null,
            opacity: null,
            normal: null,
            textures: [],
          },
        })),
      }),
    );

    const mesh = group.getObjectByName("/World/Panel")!.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshPhysicalMaterial;
    expect(material.vertexColors).toBe(false);
    expect(material.color.getHex()).toBe(new THREE.Color(0, 1, 0).getHex());
    material.dispose();
  });

  it("honors visible=false on the node's Object3D", async () => {
    const manifest = [node({ path: "/World/Hidden", name: "Hidden", visible: false, has_geometry: true })];
    const group = await buildScene(manifest, fetchers());

    expect(group.getObjectByName("/World/Hidden")!.visible).toBe(false);
  });

  it("fails soft on material fetch failure: mesh built with fallback material", async () => {
    const manifest = [
      node({
        path: "/World/Ball",
        name: "Ball",
        type_name: "Mesh",
        has_geometry: true,
        material: "/World/Looks/Missing",
      }),
    ];
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

  it("builds THREE.Points for Points nodes and a Mesh for BasisCurves", async () => {
    const manifest = [
      node({ path: "/World/Dust", name: "Dust", type_name: "Points", has_geometry: true }),
      node({ path: "/World/Stroke", name: "Stroke", type_name: "BasisCurves", has_geometry: true }),
    ];
    const group = await buildScene(manifest, fetchers());

    // Points render as THREE.Points — every decoded vertex is a point.
    const points = group.getObjectByName("/World/Dust")!.children[0] as THREE.Points;
    expect(points.isPoints).toBe(true);
    expect((points.material as THREE.PointsMaterial).type).toBe("PointsMaterial");
    expect(points.geometry.getAttribute("position").count).toBe(3);

    // BasisCurves tube geometry is a real mesh: the existing Mesh path applies.
    const mesh = group.getObjectByName("/World/Stroke")!.children[0] as THREE.Mesh;
    expect(mesh.isMesh).toBe(true);
    expect((mesh.material as THREE.MeshPhysicalMaterial).type).toBe("MeshPhysicalMaterial");
  });

  it("prefetches geometry in bounded sequential batches and decodes per path identically", async () => {
    const paths = Array.from({ length: 70 }, (_, i) => `/World/M${i}`);
    const manifest = [
      node({
        path: "/World",
        children: paths.map((path) =>
          node({ path, name: path.slice("/World/".length), type_name: "Mesh", has_geometry: true }),
        ),
      }),
    ];
    const getGeometry = vi.fn(async () => packedGeometry());
    const getGeometryBatch = vi.fn(async (slice: string[], time?: number | null) => {
      expect(time).toBe(5);
      return slice.map(() => packedGeometry());
    });
    const group = await buildScene(manifest, { ...fetchers(), getGeometry, getGeometryBatch }, {}, 5);

    // ceil(70 / 32) invokes — the batching pin.
    expect(getGeometryBatch).toHaveBeenCalledTimes(3);
    expect(getGeometry).not.toHaveBeenCalled();
    const calledPaths = getGeometryBatch.mock.calls.flatMap((call) => call[0]);
    expect(calledPaths).toEqual(paths);

    // Per-path decode parity: a batch slot builds the same geometry as the
    // frame fetch path does.
    const mesh = group.getObjectByName("/World/M0")!.children[0] as THREE.Mesh;
    const perPath = toBufferGeometry(packedGeometry());
    expect(mesh.geometry.getAttribute("position").count).toBe(
      (perPath.getAttribute("position") as THREE.BufferAttribute).count,
    );
    expect(Array.from((mesh.geometry.getAttribute("position") as THREE.BufferAttribute).array)).toEqual(
      Array.from((perPath.getAttribute("position") as THREE.BufferAttribute).array),
    );
  });

  it("serves a failed batch slot fail-soft: node kept, no per-path retry", async () => {
    const manifest = [
      node({
        path: "/World",
        children: [
          node({ path: "/World/Ok", name: "Ok", type_name: "Mesh", has_geometry: true }),
          node({ path: "/World/Bad", name: "Bad", type_name: "Mesh", has_geometry: true }),
        ],
      }),
    ];
    const getGeometry = vi.fn(async (path: string) => packedGeometry());
    const getGeometryBatch = vi.fn(async (slice: string[]) =>
      slice.map((path) => (path === "/World/Ok" ? packedGeometry() : null)),
    );
    const group = await buildScene(manifest, { ...fetchers(), getGeometry, getGeometryBatch });

    expect(group.getObjectByName("/World/Ok")!.children[0]).toBeTruthy();
    const bad = group.getObjectByName("/World/Bad")!;
    expect(bad).toBeTruthy();
    expect(bad.children.filter((child) => (child as THREE.Mesh).isMesh)).toHaveLength(0);
    expect(getGeometry, "failed slots stay failed — no per-path retry").not.toHaveBeenCalled();
  });

  it("reports bounded per-slice progress for the loading bar", async () => {
    const paths = Array.from({ length: 70 }, (_, i) => `/World/M${i}`);
    const manifest = [
      node({
        path: "/World",
        children: paths.map((path) =>
          node({
            path,
            name: path.slice("/World/".length),
            type_name: "Mesh",
            has_geometry: true,
            material: `/World/Looks/${path}`,
          }),
        ),
      }),
    ];
    const getGeometryBatch = vi.fn(async (slice: string[]) => slice.map(() => packedGeometry()));
    const getMaterialBatch = vi.fn(async (slice: string[]) => slice.map(() => null));
    const onProgress = vi.fn();

    await buildScene(manifest, { ...fetchers(), getGeometryBatch, getMaterialBatch }, {}, 0, onProgress);

    // Geometry owns 55..80, materials 80..90, assembly 95: the whole build
    // stays under the ceiling the caller reserves for scene-ready.
    expect(onProgress.mock.calls).toEqual([
      ["Loading Geometry 32/70", 66],
      ["Loading Geometry 64/70", 78],
      ["Loading Geometry 70/70", 80],
      ["Loading Materials 32/70", 85],
      ["Loading Materials 64/70", 89],
      ["Loading Materials 70/70", 90],
      ["Assembling Scene", 95],
    ]);
  });

  it("falls back to per-path fetches when the whole batch command fails", async () => {
    const manifest = [
      node({
        path: "/World",
        children: [
          node({ path: "/World/A", name: "A", type_name: "Mesh", has_geometry: true }),
          node({ path: "/World/B", name: "B", type_name: "Mesh", has_geometry: true }),
        ],
      }),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getGeometry = vi.fn(async () => packedGeometry());
    const getGeometryBatch = vi.fn(async () => {
      throw new Error("no stage open");
    });
    const group = await buildScene(manifest, { ...fetchers(), getGeometry, getGeometryBatch });

    expect(getGeometry).toHaveBeenCalledTimes(2);
    expect(getGeometry).toHaveBeenCalledWith("/World/A", undefined);
    expect(group.getObjectByName("/World/A")!.children[0]).toBeTruthy();
    expect(group.getObjectByName("/World/B")!.children[0]).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("prefetches materials in bounded sequential batches and consumes the prefill", async () => {
    // Load-time material batching pin: one invoke per 32-binding slice, and
    // the build reads the prefill instead of calling the per-binding fetcher.
    const paths = Array.from({ length: 70 }, (_, i) => `/World/M${i}`);
    const bindings = paths.map((path) => `/World/Looks/${path}`);
    const manifest = [
      node({
        path: "/World",
        children: bindings.map((binding, i) =>
          node({
            path: paths[i],
            name: paths[i].slice("/World/".length),
            type_name: "Mesh",
            has_geometry: true,
            material: binding,
          }),
        ),
      }),
    ];
    const getMaterial = vi.fn(async () => ({ name: "Mat", surface: null }));
    const getMaterialBatch = vi.fn(async (slice: string[]) =>
      slice.map((path) => ({
        name: path.slice("/World/Looks/".length),
        surface: {
          diffuse_color: { type: "color3f", data: [0, 1, 0] },
          roughness: null,
          metallic: null,
          opacity: null,
          normal: null,
          textures: [],
        },
      })),
    );
    const group = await buildScene(manifest, { ...fetchers(), getMaterial, getMaterialBatch });

    // ceil(70 / 32) invokes — the batching pin.
    expect(getMaterialBatch).toHaveBeenCalledTimes(3);
    expect(getMaterialBatch.mock.calls.map((call) => call[0].length)).toEqual([32, 32, 6]);
    expect(getMaterialBatch.mock.calls.flatMap((call) => call[0])).toEqual(bindings);
    expect(getMaterial, "prefill served every node").not.toHaveBeenCalled();

    // The prefilled JSON reached convertMaterial: green from the batch.
    const mesh = group.getObjectByName("/World/M0")!.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshPhysicalMaterial;
    expect(material.color.getHex()).toBe(new THREE.Color(0, 1, 0).getHex());
    material.dispose();
  });

  it("skips the material lookup entirely for unbound prims", async () => {
    // Kitchen_set shape: every geometry prim has material: null, and the
    // backend's answer for them is exactly the surface-less fallback the
    // builder now builds locally — no round trip.
    const manifest = [
      node({
        path: "/World",
        children: [
          node({ path: "/World/A", name: "A", type_name: "Mesh", has_geometry: true }),
          node({ path: "/World/B", name: "B", type_name: "Mesh", has_geometry: true }),
        ],
      }),
    ];
    const getMaterial = vi.fn(async () => ({ name: "Mat", surface: null }));
    const getMaterialBatch = vi.fn(async (slice: string[]) => slice.map(() => null));
    const group = await buildScene(manifest, { ...fetchers(), getMaterial, getMaterialBatch });

    expect(getMaterialBatch).not.toHaveBeenCalled();
    expect(getMaterial).not.toHaveBeenCalled();
    const mesh = group.getObjectByName("/World/A")!.children[0] as THREE.Mesh;
    expect((mesh.material as THREE.MeshPhysicalMaterial).type).toBe("MeshPhysicalMaterial");
  });

  it("retries an unresolvable prototype binding on the node's own path once", async () => {
    // A PointInstancer prototype root's binding can only resolve on the
    // prototype stage; the backend still resolves the node's own path.
    const manifest = [
      node({
        path: "/World/Instancer/__proto_0",
        name: "__proto_0",
        type_name: "Mesh",
        has_geometry: true,
        material: "/World/Prototypes/Ball/Looks/Ball",
      }),
    ];
    const getMaterial = vi.fn(async (path: string): Promise<MaterialInfo | null> =>
      path === "/World/Instancer/__proto_0"
        ? {
            name: "Ball",
            surface: {
              diffuse_color: { type: "color3f", data: [0, 1, 0] },
              roughness: null,
              metallic: null,
              opacity: null,
              normal: null,
              textures: [],
            },
          }
        : null,
    );
    const group = await buildScene(manifest, fetchers({ getMaterial }));

    expect(getMaterial.mock.calls.map(([path]) => path)).toEqual([
      "/World/Prototypes/Ball/Looks/Ball",
      "/World/Instancer/__proto_0",
    ]);
    const mesh = group.getObjectByName("/World/Instancer/__proto_0")!.children[0] as THREE.Mesh;
    expect((mesh.material as THREE.MeshPhysicalMaterial).color.getHex()).toBe(
      new THREE.Color(0, 1, 0).getHex(),
    );
  });

  it("looks up each distinct binding once and shares it across prims", async () => {
    // Bike shape: 331 prim lookups collapse to one per distinct binding.
    const manifest = [
      node({
        path: "/World",
        children: ["/World/A", "/World/B", "/World/C"].map((path, i) =>
          node({
            path,
            name: `P${i}`,
            type_name: "Mesh",
            has_geometry: true,
            material: i === 2 ? "/World/Looks/Odd" : "/World/Looks/Shared",
          }),
        ),
      }),
    ];
    const getMaterial = vi.fn(async () => null);
    const getMaterialBatch = vi.fn(async (slice: string[]) =>
      slice.map(() => ({
        name: "Shared",
        surface: {
          diffuse_color: { type: "color3f", data: [0, 1, 0] },
          roughness: null,
          metallic: null,
          opacity: null,
          normal: null,
          textures: [],
        },
      })),
    );
    const group = await buildScene(manifest, { ...fetchers(), getMaterial, getMaterialBatch });

    expect(getMaterialBatch).toHaveBeenCalledTimes(1);
    expect(getMaterialBatch.mock.calls[0][0]).toEqual(["/World/Looks/Shared", "/World/Looks/Odd"]);
    expect(getMaterial, "bindings only: never per prim").not.toHaveBeenCalled();
    for (const path of ["/World/A", "/World/B", "/World/C"]) {
      const mesh = group.getObjectByName(path)!.children[0] as THREE.Mesh;
      expect((mesh.material as THREE.MeshPhysicalMaterial).color.getHex()).toBe(
        new THREE.Color(0, 1, 0).getHex(),
      );
    }
  });

  it("falls back to a failed material slot's per-binding fetch", async () => {
    const manifest = [
      node({
        path: "/World",
        children: [
          node({
            path: "/World/Ok",
            name: "Ok",
            type_name: "Mesh",
            has_geometry: true,
            material: "/World/Looks/Ok",
          }),
          node({
            path: "/World/Bad",
            name: "Bad",
            type_name: "Mesh",
            has_geometry: true,
            material: "/World/Looks/Bad",
          }),
        ],
      }),
    ];
    const getMaterial = vi.fn(async () => ({ name: "Fallback", surface: null }));
    const getMaterialBatch = vi.fn(async (slice: string[]) =>
      slice.map((path) => (path === "/World/Looks/Ok" ? { name: "Ok", surface: null } : null)),
    );
    await buildScene(manifest, { ...fetchers(), getMaterial, getMaterialBatch });

    expect(getMaterial).toHaveBeenCalledTimes(1);
    expect(getMaterial).toHaveBeenCalledWith("/World/Looks/Bad");
  });

  it("falls back to per-binding material fetches when the whole batch command fails", async () => {
    const manifest = [
      node({
        path: "/World",
        children: [
          node({
            path: "/World/A",
            name: "A",
            type_name: "Mesh",
            has_geometry: true,
            material: "/World/Looks/A",
          }),
          node({
            path: "/World/B",
            name: "B",
            type_name: "Mesh",
            has_geometry: true,
            material: "/World/Looks/B",
          }),
        ],
      }),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getMaterial = vi.fn(async () => ({ name: "Mat", surface: null }));
    const getMaterialBatch = vi.fn(async () => {
      throw new Error("no stage open");
    });
    const group = await buildScene(manifest, { ...fetchers(), getMaterial, getMaterialBatch });

    expect(getMaterial).toHaveBeenCalledTimes(2);
    expect(getMaterial).toHaveBeenCalledWith("/World/Looks/A");
    expect(group.getObjectByName("/World/A")!.children[0]).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("applies saved dependency fallback colors while building materials", async () => {
    const manifest = [
      node({
        path: "/World/Floor",
        name: "Floor",
        type_name: "Mesh",
        has_geometry: true,
        material: "/World/Looks/CheckerFloor",
      }),
    ];
    const group = await buildScene(
      manifest,
      fetchers({
        getMaterial: vi.fn(async () => ({
          name: "CheckerFloor",
          surface: {
            diffuse_color: null,
            roughness: null,
            metallic: null,
            opacity: null,
            normal: null,
            textures: [{ input: "diffuseColor", file_path: "/cache/checker.png", st_primvar: "st" }],
          },
        })),
      }),
      { "/cache/checker.png": { fallback_color: "#ff0000" } },
    );

    const mesh = group.getObjectByName("/World/Floor")!.children[0] as THREE.Mesh;
    expect((mesh.material as THREE.MeshPhysicalMaterial).color.g).toBe(0);
  });

  it("disposes every material-owned texture with the scene", () => {
    const textures = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
    const spies = textures.map((texture) => vi.spyOn(texture, "dispose"));
    const material = new THREE.MeshPhysicalMaterial({
      map: textures[0],
      roughnessMap: textures[1],
      alphaMap: textures[2],
    });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), material));

    disposeScene(root);

    expect(spies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
  });

  it("disposes the fetched material and its textures that Points nodes drop", async () => {
    const texture = new THREE.Texture();
    const textureDispose = vi.spyOn(texture, "dispose");
    const manifest = [node({ path: "/World/Dust", name: "Dust", type_name: "Points", has_geometry: true })];
    const original = materialConverter.convertMaterial;
    const convertSpy = vi
      .spyOn(materialConverter, "convertMaterial")
      .mockImplementation((info, fallbackColor, loadTexture) => {
        const material = original(info, fallbackColor, loadTexture);
        vi.spyOn(material, "dispose");
        material.map = texture;
        return material;
      });

    await buildScene(manifest, fetchers());

    const material = convertSpy.mock.results[0].value;
    expect(vi.mocked(material.dispose)).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });
});

// One triangle payload with a custom vertex/index count (positions zeroed,
// indices sequential) — layout differs from packedGeometry's 3/3.
function packedGeometryCounts(vertexCount: number, indexCount: number, flags = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + vertexCount * 9 * 4 + indexCount * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true); // magic
  view.setUint32(4, 1, true); // version
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, indexCount, true);
  view.setUint32(16, flags, true);
  new Uint32Array(buffer, 20 + vertexCount * 12, indexCount).set(
    Array.from({ length: indexCount }, (_, i) => i % vertexCount),
  );
  return buffer;
}

describe("applyPackedGeometryInPlace", () => {
  it("writes a compatible payload into the same geometry and index attribute", () => {
    const geometry = toBufferGeometry(packedGeometry());
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = geometry.getIndex()!;
    const positionVersion = position.version;
    const indexVersion = index.version;

    expect(applyPackedGeometryInPlace(geometry, packedGeometry(5))).toBe(true);

    expect(geometry.getAttribute("position")).toBe(position);
    expect(geometry.getIndex()).toBe(index);
    expect(position.getY(2)).toBe(5);
    // needsUpdate is setter-only in this three version: setting it bumps
    // the attribute version, which is what signals the GPU re-upload.
    expect(position.version).toBe(positionVersion + 1);
    expect(index.version).toBe(indexVersion + 1);
    // The sphere reflects the NEW positions: center y is the midpoint of
    // the y extents [0, 5].
    expect(geometry.boundingSphere!.center.y).toBe(2.5);
  });

  it("rejects a changed vertex count", () => {
    const geometry = toBufferGeometry(packedGeometry());
    const positionVersion = (geometry.getAttribute("position") as THREE.BufferAttribute).version;

    expect(applyPackedGeometryInPlace(geometry, packedGeometryCounts(4, 3))).toBe(false);
    expect((geometry.getAttribute("position") as THREE.BufferAttribute).version).toBe(positionVersion);
  });

  it("rejects a changed index count", () => {
    const geometry = toBufferGeometry(packedGeometry());
    expect(applyPackedGeometryInPlace(geometry, packedGeometryCounts(3, 6))).toBe(false);
  });

  it("rejects an appearing attribute", () => {
    const geometry = toBufferGeometry(packedGeometry());
    expect(applyPackedGeometryInPlace(geometry, packedColoredGeometry())).toBe(false);
  });

  it("rejects a disappearing attribute", () => {
    const geometry = toBufferGeometry(packedColoredGeometry());
    expect(applyPackedGeometryInPlace(geometry, packedGeometry())).toBe(false);
  });

  it("isLayoutCompatible is pure: no mutation on rejection", () => {
    const geometry = toBufferGeometry(packedGeometry());
    const decoded = {
      positions: new Float32Array(12),
      indices: new Uint32Array(3),
      normals: null,
      uvs: null,
      colors: null,
    };
    expect(isLayoutCompatible(geometry, decoded)).toBe(false);
    expect(geometry.getAttribute("position").count).toBe(3);
  });
});
