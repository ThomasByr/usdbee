// Scene assembly (Phase 2, Task 4): a Rust render manifest -> a THREE.Group
// of Object3Ds named by prim path (exact selection sync), meshes with
// decoded geometry + converted materials, InstancedMeshes for prototype
// children, visibility flags honored. Pure builder: geometry/material
// fetchers and the texture loader are injected — the invoke wiring lives in
// renderState.svelte.ts, tests pass mocks. Fail-soft: a material the
// fetcher cannot resolve falls back to a plain MeshPhysicalMaterial; a
// geometry the fetcher cannot resolve skips the mesh but keeps the node's
// Object3D so selection and branch toggles still find it.
import * as THREE from "three";
import type { MaterialInfo, RenderNode } from "../stage/types";
import { decodeGeometry } from "./geometryDecoder";
import { convertMaterial, type MaterialTextureLoader } from "./materialConverter";

export interface FallbackDependency {
  fallback_color?: string | null;
}

export type FallbackDependencies = Record<string, FallbackDependency>;

export interface SceneFetchers {
  getGeometry: (path: string, time?: number | null) => Promise<ArrayBuffer>;
  // null = fetch failed; the builder falls back to a plain material.
  getMaterial: (path: string) => Promise<MaterialInfo | null>;
  loadTexture: MaterialTextureLoader;
}

// USD row-major row-vector matrices and three.js column-major column-vector
// matrices store the same 16 numbers in the same order (translation at
// indices 12-14), so fromArray is a direct copy. Exported for renderState's
// in-place time updates (Task 6).
export function applyTransform(object: THREE.Object3D, matrix: number[]): void {
  object.matrixAutoUpdate = false;
  object.matrix.fromArray(matrix);
  object.matrixWorldNeedsUpdate = true;
}

// Exported for renderState's in-place geometry rebuilds (Task 6).
export function toBufferGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const decoded = decodeGeometry(buffer);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
  if (decoded.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(decoded.normals, 3));
  if (decoded.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(decoded.uvs, 2));
  if (decoded.colors) geometry.setAttribute("color", new THREE.BufferAttribute(decoded.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
  return geometry;
}

async function fetchGeometry(
  node: RenderNode,
  fetchers: SceneFetchers,
  time?: number | null,
): Promise<THREE.BufferGeometry | null> {
  try {
    return toBufferGeometry(await fetchers.getGeometry(node.path, time));
  } catch (e) {
    console.warn(`usdbee: skipping geometry at ${node.path}:`, e);
    return null;
  }
}

function fallbackColorFor(info: MaterialInfo, dependencies: FallbackDependencies): string | null {
  const entries = Object.entries(dependencies).filter((entry) => entry[1].fallback_color);
  const materialName = info.name.toLowerCase();
  const stem = (path: string) => (path.split(/[\\/]/).pop() ?? "").split(".")[0]?.toLowerCase() ?? "";
  const match = entries.find(([path]) => {
    const dependencyStem = stem(path);
    return (
      dependencyStem !== "" &&
      (materialName.includes(dependencyStem) ||
        (info.surface?.textures ?? []).some((texture) => stem(texture.file_path) === dependencyStem))
    );
  });
  return (match ?? entries[0])?.[1].fallback_color ?? null;
}

async function fetchMaterial(
  node: RenderNode,
  fetchers: SceneFetchers,
  dependencies: FallbackDependencies,
): Promise<THREE.MeshPhysicalMaterial> {
  const info = await fetchers.getMaterial(node.path).catch(() => null);
  const materialInfo = info ?? { name: node.name, surface: null };
  return convertMaterial(materialInfo, fallbackColorFor(materialInfo, dependencies), fetchers.loadTexture);
}

// Per-instance drawing below an instanced prototype root: `instances` are
// the synthetic prototype node's row-major matrices, `transform` the
// accumulated subtree transform from the node holding them to the child
// being built (instance matrix x accumulated transform per geometry child).
// Exported for renderState's in-place time updates, which thread the same
// context through the manifest walk.
export interface InstanceContext {
  instances: number[][];
  transform: THREE.Matrix4;
}

async function buildNode(
  node: RenderNode,
  fetchers: SceneFetchers,
  dependencies: FallbackDependencies,
  time?: number | null,
  instancing: InstanceContext | null = null,
): Promise<THREE.Object3D> {
  const object = new THREE.Group();
  object.name = node.path;
  applyTransform(object, node.transform);

  const local = new THREE.Matrix4().fromArray(node.transform);
  // Matrices for this node's own geometry when it draws per instance.
  let own: THREE.Matrix4[] | null = null;
  // The instancing context handed to children: the synthetic prototype
  // root's transform is already folded into its instance matrices, so the
  // subtree starts at the identity; a descendant folds its own transform
  // into the accumulated one and sits at the origin.
  let childContext: InstanceContext | null = null;
  if (node.instances.length > 0) {
    own = node.instances.map((instance) => new THREE.Matrix4().fromArray(instance));
    childContext = { instances: node.instances, transform: new THREE.Matrix4() };
  } else if (instancing) {
    const context = {
      instances: instancing.instances,
      transform: instancing.transform.clone().multiply(local),
    };
    childContext = context;
    own = context.instances.map((instance) =>
      new THREE.Matrix4().fromArray(instance).multiply(context.transform),
    );
    object.matrix.identity();
  }
  object.visible = node.visible;

  if (node.has_geometry) {
    const geometry = await fetchGeometry(node, fetchers, time);
    if (geometry) {
      if (node.type_name === "Points") {
        // Point clouds: a size-based PointsMaterial colored by the vertex
        // colors when present, else the bound material's diffuse/fallback
        // color.
        const material = await fetchMaterial(node, fetchers, dependencies);
        const vertexColors = geometry.getAttribute("color") != null;
        const points = new THREE.Points(
          geometry,
          new THREE.PointsMaterial({
            size: 0.1,
            sizeAttenuation: true,
            vertexColors,
            color: vertexColors ? 0xffffff : material.color,
          }),
        );
        points.name = node.path;
        // The fetched material is only used for its color here; Material
        // dispose() does not cascade to textures, so drop those too.
        disposeMaterial(material);
        object.add(points);
      } else {
        const material = await fetchMaterial(node, fetchers, dependencies);
        let mesh: THREE.Mesh | THREE.InstancedMesh;
        if (own) {
          const instanced = new THREE.InstancedMesh(geometry, material, own.length);
          own.forEach((matrix, i) => {
            instanced.setMatrixAt(i, matrix);
          });
          instanced.instanceMatrix.needsUpdate = true;
          mesh = instanced;
        } else {
          mesh = new THREE.Mesh(geometry, material);
        }
        mesh.name = node.path;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        object.add(mesh);
      }
    }
  }

  for (const child of node.children) {
    object.add(await buildNode(child, fetchers, dependencies, time, childContext));
  }
  return object;
}

export async function buildScene(
  manifest: RenderNode[],
  fetchers: SceneFetchers,
  dependencies: FallbackDependencies = {},
  time?: number | null,
): Promise<THREE.Group> {
  const root = new THREE.Group();
  for (const node of manifest) {
    root.add(await buildNode(node, fetchers, dependencies, time));
  }
  return root;
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

// Disposes a scene built by buildScene (geometry, materials, instanced
// buffers) so a reload can drop the previous render objects.
export function disposeScene(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh & { isPoints?: boolean };
    if (mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || mesh.isPoints) {
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) if (material) disposeMaterial(material);
    }
  });
  root.clear();
}
