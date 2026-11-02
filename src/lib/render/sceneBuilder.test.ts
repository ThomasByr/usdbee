// sceneBuilder tests (Phase 2, Task 4): a manifest fixture builds an
// Object3D hierarchy named by prim path, InstancedMeshes carry per-prototype
// instance matrices, visibility flags are honored, and fetch failures fail
// soft (fallback material; mesh skipped, node kept, scene returned).

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { buildScene, disposeScene } from "./sceneBuilder";
import * as materialConverter from "./materialConverter";
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
    // child's material applies, and one InstancedMesh carries all 3
    // instances of the child geometry — no phantom origin Mesh.
    expect(getGeometry).toHaveBeenCalledWith("/World/Instancer/__proto_0/Shape", undefined);
    expect(getMaterial).toHaveBeenCalledWith("/World/Instancer/__proto_0/Shape");
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
        loadTexture: vi.fn(() => new THREE.Texture()),
      }),
    );

    const mesh = group.getObjectByName("/World/Floor")!.children[0] as THREE.Mesh;
    expect((mesh.material as THREE.MeshPhysicalMaterial).vertexColors).toBe(false);
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

  it("applies saved dependency fallback colors while building materials", async () => {
    const manifest = [node({ path: "/World/Floor", name: "Floor", type_name: "Mesh", has_geometry: true })];
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
