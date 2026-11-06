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
import { decodeGeometry, type DecodedGeometry } from "./geometryDecoder";
import { convertMaterial, type MaterialTextureLoader } from "./materialConverter";

export interface FallbackDependency {
  fallback_color?: string | null;
}

export type FallbackDependencies = Record<string, FallbackDependency>;

export interface SceneFetchers {
  getGeometry: (path: string, time?: number | null) => Promise<ArrayBuffer>;
  // Optional load-time prefill (Phase 2.5 Task 3): one batched backend call
  // per slice of GEOMETRY_BATCH_SIZE paths; a slot value is the geometry
  // frame bytes, null when that slot failed (fail-soft per path). Throws
  // when the whole batch command fails; the builder then falls back to the
  // per-path fetches, which stay the step-refetch path either way.
  getGeometryBatch?: (paths: string[], time?: number | null) => Promise<(ArrayBuffer | Uint8Array | null)[]>;
  // `path` is a `material:binding` target (a Material prim), which the
  // backend serializes directly; null = fetch failed, the builder falls
  // back to a plain material.
  getMaterial: (path: string) => Promise<MaterialInfo | null>;
  // Optional load-time prefill (Phase 2 Task 3), mirroring getGeometryBatch:
  // one batched backend call per slice of GEOMETRY_BATCH_SIZE binding paths;
  // a slot value is that binding's MaterialInfo, null when the slot failed
  // (fail-soft per path). Throws when the whole batch command fails; the
  // builder then falls back to getMaterial, which stays the single-binding
  // refetch path.
  getMaterialBatch?: (paths: string[]) => Promise<(MaterialInfo | null)[]>;
  loadTexture: MaterialTextureLoader;
}

// Bounded batch size: sequential batches keep the actor fed and memory flat
// (the brief's ruling), and 32 keeps one response comfortably inside the
// ~1 MB ipc::soft threshold per slot average.
export const GEOMETRY_BATCH_SIZE = 32;

// Managed "path -> fetch outcome" the builder allocates from load time:
// geometry frame bytes (a batch slot) or null (that slot failed).
type PrefetchedGeometry = Map<string, ArrayBuffer | Uint8Array | null>;

// The material twin, keyed by `material:binding` target instead of prim: one
// slot serves every prim bound to that material, and null marks a slot that
// failed (the per-binding fetch runs instead).
type PrefetchedMaterials = Map<string, MaterialInfo | null>;

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

// In-place update (steady-state playback): when a fetched frame's layout
// matches the live geometry, write the payload INTO the existing
// BufferAttributes (array mutation + needsUpdate) — no reallocation, no
// GPU buffer churn. Returns false when incompatible; the caller falls
// back to full recreation.
export function applyPackedGeometryInPlace(
  geometry: THREE.BufferGeometry,
  buffer: ArrayBuffer | Uint8Array,
): boolean {
  const decoded = decodeGeometry(buffer);
  if (!isLayoutCompatible(geometry, decoded)) return false;
  // Attributes are never interleaved here (toBufferGeometry builds plain
  // BufferAttributes); getAttribute's union type needs the cast.
  const attr = (name: string) => geometry.getAttribute(name) as THREE.BufferAttribute;
  const write = (attribute: THREE.BufferAttribute, array: Float32Array | Uint32Array) => {
    (attribute.array as typeof array).set(array);
    attribute.needsUpdate = true;
  };
  write(attr("position"), decoded.positions);
  if (decoded.normals) write(attr("normal"), decoded.normals);
  if (decoded.uvs) write(attr("uv"), decoded.uvs);
  if (decoded.colors) write(attr("color"), decoded.colors);
  write(geometry.getIndex()!, decoded.indices); // same counts, values may differ
  geometry.boundingBox = null; // stale bounds would mislead raycasts/framing
  geometry.computeBoundingSphere();
  return true;
}

// Compatible when vertex/index counts and the present attribute set match
// (positions always; normals/uv/colors may come and go). The decoder always
// yields Uint32 indices and toBufferGeometry always builds Uint32 index
// attributes, so the index type is constant by construction. Exported for
// tests.
export function isLayoutCompatible(geometry: THREE.BufferGeometry, decoded: DecodedGeometry): boolean {
  const position = geometry.getAttribute("position");
  if (
    !position ||
    position.itemSize !== 3 ||
    !(position.array instanceof Float32Array) ||
    position.count !== decoded.positions.length / 3
  )
    return false;
  const index = geometry.getIndex();
  if (!index || !(index.array instanceof Uint32Array) || index.count !== decoded.indices.length) return false;
  const optional: [string, Float32Array | null, number][] = [
    ["normal", decoded.normals, 3],
    ["uv", decoded.uvs, 2],
    ["color", decoded.colors, 3],
  ];
  for (const [name, array, itemSize] of optional) {
    const attribute = geometry.getAttribute(name);
    if (!array) {
      if (attribute) return false; // attribute disappeared from the payload
      continue;
    }
    if (!attribute || attribute.itemSize !== itemSize || attribute.count !== array.length / itemSize)
      return false;
  }
  return true;
}

async function fetchGeometry(
  node: RenderNode,
  fetchers: SceneFetchers,
  time?: number | null,
  prefetched: PrefetchedGeometry = new Map(),
): Promise<THREE.BufferGeometry | null> {
  const prefill = prefetched.get(node.path);
  if (prefill !== undefined) {
    prefetched.delete(node.path);
    if (prefill === null) return null; // failed batch slot; already warn-free
    try {
      return toBufferGeometry(prefill);
    } catch (e) {
      console.warn(`usdbee: skipping geometry at ${node.path}:`, e);
      return null;
    }
  }
  try {
    return toBufferGeometry(await fetchers.getGeometry(node.path, time));
  } catch (e) {
    console.warn(`usdbee: skipping geometry at ${node.path}:`, e);
    return null;
  }
}

// Distinct walk-order paths the builder prefetches in bounded sequential
// batches before building nodes: geometry keys by prim path, materials by
// `material:binding` target (null = nothing to fetch for this node).
function uniquePaths(manifest: RenderNode[], pick: (node: RenderNode) => string | null): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const walk = (nodes: RenderNode[]) => {
    for (const node of nodes) {
      const path = pick(node);
      if (path !== null && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
      walk(node.children);
    }
  };
  walk(manifest);
  return paths;
}

async function preloadGeometry(
  manifest: RenderNode[],
  fetchers: SceneFetchers,
  time?: number | null,
  onProgress?: BuildProgress,
): Promise<PrefetchedGeometry> {
  const prefetched: PrefetchedGeometry = new Map();
  const paths = uniquePaths(manifest, (node) => (node.has_geometry ? node.path : null));
  const getGeometryBatch = fetchers.getGeometryBatch;
  if (!getGeometryBatch) return prefetched;
  for (let start = 0; start < paths.length; start += GEOMETRY_BATCH_SIZE) {
    const slice = paths.slice(start, start + GEOMETRY_BATCH_SIZE);
    try {
      const slots = await getGeometryBatch(slice, time);
      slice.forEach((path, slot) => prefetched.set(path, slots[slot] ?? null));
      reportSliceProgress(onProgress, "Loading Geometry", start, slice.length, paths.length, 55, 25);
    } catch (e) {
      // Whole batch failed: leave unfetched so the per-path fetches still
      // run fail-soft inside buildNode.
      console.warn("usdbee: geometry batch failed; fetching per path:", e);
      break;
    }
  }
  return prefetched;
}

async function preloadMaterials(
  manifest: RenderNode[],
  fetchers: SceneFetchers,
  onProgress?: BuildProgress,
): Promise<PrefetchedMaterials> {
  const prefetched: PrefetchedMaterials = new Map();
  const getMaterialBatch = fetchers.getMaterialBatch;
  if (!getMaterialBatch) return prefetched;
  // One lookup per DISTINCT binding: get_material_data resolves a Material
  // prim directly, so every prim sharing a binding shares one answer. Prims
  // without a binding are skipped entirely — the backend's answer for them
  // is the surface-less fallback fetchMaterial builds locally.
  const paths = uniquePaths(manifest, (node) => (node.has_geometry ? node.material : null));
  for (let start = 0; start < paths.length; start += GEOMETRY_BATCH_SIZE) {
    const slice = paths.slice(start, start + GEOMETRY_BATCH_SIZE);
    try {
      const slots = await getMaterialBatch(slice);
      slice.forEach((path, slot) => prefetched.set(path, slots[slot] ?? null));
      reportSliceProgress(onProgress, "Loading Materials", start, slice.length, paths.length, 80, 10);
    } catch (e) {
      // Whole batch failed: leave unfetched so the per-binding fetches still
      // run fail-soft inside fetchMaterial.
      console.warn("usdbee: material batch failed; fetching per binding:", e);
      break;
    }
  }
  return prefetched;
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
  prefetched: PrefetchedMaterials = new Map(),
): Promise<THREE.MeshPhysicalMaterial> {
  // An unbound prim needs no round trip: the backend answers exactly this
  // surface-less fallback for it.
  const binding = node.material;
  let info: MaterialInfo | null = null;
  if (binding !== null) {
    // Shared by every prim bound to this material, so the prefill is read,
    // never consumed; a null slot falls through to the per-binding fetch,
    // which stays fail-soft.
    const prefill = prefetched.get(binding);
    info = prefill ?? (await fetchers.getMaterial(binding).catch(() => null));
    // A PointInstancer prototype root can carry a binding that only
    // resolves on the prototype stage; the backend still resolves the
    // node's own path, so retry once there before the local fallback.
    if (info === null) info = await fetchers.getMaterial(node.path).catch(() => null);
  }
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
  prefetched: PrefetchedGeometry = new Map(),
  prefetchedMaterials: PrefetchedMaterials = new Map(),
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
    const geometry = await fetchGeometry(node, fetchers, time, prefetched);
    if (geometry) {
      if (node.type_name === "Points") {
        // Point clouds: a size-based PointsMaterial colored by the vertex
        // colors when present, else the bound material's diffuse/fallback
        // color.
        const material = await fetchMaterial(node, fetchers, dependencies, prefetchedMaterials);
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
        const material = await fetchMaterial(node, fetchers, dependencies, prefetchedMaterials);
        // displayColor primvars arrive as a per-vertex "color" attribute;
        // three.js reads them only when the material opts in. A bound
        // material wins over displayColor, which stays off there (a bound
        // diffuse map would be untinted anyway, and a constant diffuse
        // color would multiply with the vertex colors).
        if (node.material === null && geometry.getAttribute("color") != null) {
          material.vertexColors = true;
        }
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
    object.add(
      await buildNode(child, fetchers, dependencies, time, childContext, prefetched, prefetchedMaterials),
    );
  }
  return object;
}

// Load-time progress for the loading bar: the caller owns the scale (the
// Rust stream ends at 45 %, scene-ready clears it), the builder reports the
// stages only it can see.
export type BuildProgress = (stage: string, percent: number) => void;

// One report per batch slice, spread over the stage's [base, base + span]
// band so a long build advances instead of parking.
function reportSliceProgress(
  onProgress: BuildProgress | undefined,
  label: string,
  start: number,
  count: number,
  total: number,
  base: number,
  span: number,
): void {
  if (!onProgress) return;
  const done = Math.min(start + count, total);
  onProgress(`${label} ${done}/${total}`, base + Math.round((done / total) * span));
}

export async function buildScene(
  manifest: RenderNode[],
  fetchers: SceneFetchers,
  dependencies: FallbackDependencies = {},
  time?: number | null,
  onProgress?: BuildProgress,
): Promise<THREE.Group> {
  const prefetched = await preloadGeometry(manifest, fetchers, time, onProgress);
  const prefetchedMaterials = await preloadMaterials(manifest, fetchers, onProgress);
  onProgress?.("Assembling Scene", 95);
  const root = new THREE.Group();
  for (const node of manifest) {
    root.add(await buildNode(node, fetchers, dependencies, time, null, prefetched, prefetchedMaterials));
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
