// Rust render-backend state (Phase 2, Task 4): loads the render manifest
// from the open stage and builds the Three.js scene from it. House pattern
// from stageState.svelte.ts: a generation counter discards responses from
// superseded loads (the Phase 1 stale-response lesson).
//
// Task 6 adds time codes end-to-end: setStageTime(t) re-fetches the
// manifest and updates the ALREADY-integrated group in place — transforms
// and visibility for every node, geometry only for `geometry_animated`
// ones (whose own geometry attrs carry time samples); transform-only
// animated nodes keep their load-time geometry, and the scene is not
// rebuilt.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import type { MaterialInfo, RenderNode } from "../stage/types";
import { decodeGeometryBatch } from "./geometryDecoder";
import {
  applyTransform,
  buildScene,
  disposeScene,
  toBufferGeometry,
  type FallbackDependencies,
  type InstanceContext,
  type SceneFetchers,
} from "./sceneBuilder";

let loadGeneration = 0;
let sceneLoading = false;
let timeStepInFlight = false;
let activeTimeStep: Promise<void> | null = null;
// Promise covering the whole in-flight load (including its queued refresh);
// resolves even on failure so waiting time steps never hang.
let loadPromise: Promise<void> | null = null;
let queuedTime: number | null = null;

// The group + path->object index of the last successfully built scene.
// loadRenderScene hands the group to the caller (which integrates it into
// the viewport); setStageTime mutates that same group in place.
let currentGroup: THREE.Group | null = null;
let currentPaths = new Map<string, THREE.Object3D>();
let currentFallbacks: FallbackDependencies = {};

// One shared loader; convertMaterial clears failed maps through onError.
const textureLoader = new THREE.TextureLoader();

const fetchers: SceneFetchers = {
  getGeometry: (path: string, time = renderState.time) =>
    invoke<ArrayBuffer>("get_geometry_data", { path, time }),
  // Load-time batch prefill: one invoke per slice of GEOMETRY_BATCH_SIZE
  // paths, slots decoded here so sceneBuilder only sees per-path results.
  getGeometryBatch: async (paths: string[], time = renderState.time) =>
    decodeGeometryBatch(
      await invoke<ArrayBuffer>("get_geometry_batch", { paths, time }),
    ),
  getMaterial: (path: string) => invoke<MaterialInfo>("get_material_data", { path }).catch(() => null),
  loadTexture: (filePath: string, onError: () => void) => {
    try {
      return textureLoader.load(convertFileSrc(filePath), undefined, undefined, onError);
    } catch {
      return null;
    }
  },
};

// Spec §8 pin: the seconds -> time-code conversion lives ONLY in this
// helper (and the exporter's per-frame stepping) — everywhere else works
// in USD time codes. Wraps past `end` back into [start, end].
export function advanceStageTime(
  current: number,
  deltaSeconds: number,
  timeCodesPerSecond: number,
  start: number,
  end: number,
): number {
  const span = end - start;
  if (span <= 0) return start;
  const next = current + deltaSeconds * timeCodesPerSecond;
  return next > end ? start + ((next - start) % span) : next;
}

// Playhead-unit convention (review fix): the UI layer — timeline slider,
// progress display, ExportModal range inputs — works in 0..(end-start)
// OFFSETS, regardless of start_time_code. These two helpers are the only
// boundary between offsets and the absolute USD time codes that
// setStageTime (and everything renderState-side) speaks.
export function toAbsoluteTime(offset: number, start: number): number {
  return offset + start;
}

export function toPlayheadOffset(time: number, start: number): number {
  return time - start;
}

function anyAnimated(nodes: RenderNode[]): boolean {
  return nodes.some((node) => node.animated || anyAnimated(node.children));
}

function indexByPath(group: THREE.Group): Map<string, THREE.Object3D> {
  // Object names are exact prim paths; the mesh/points named like its
  // wrapper Group overwrites the wrapper entry (traverse is preorder),
  // so updateNodes finds the drawable first and its parent wrapper via
  // .parent.
  const byPath = new Map<string, THREE.Object3D>();
  group.traverse((object) => {
    if (object.name) byPath.set(object.name, object);
  });
  return byPath;
}

// Applies the manifest's time state to the integrated scene. Animated
// geometry is rebuilt; instanced prototypes can appear, disappear, or
// change count as invisibleIds changes. Every await is generation-guarded.
async function updateNodes(
  nodes: RenderNode[],
  byPath: Map<string, THREE.Object3D>,
  time: number,
  isStale: () => boolean,
  instancing: InstanceContext | null = null,
): Promise<void> {
  for (const node of nodes) {
    if (isStale()) return;
    let object = byPath.get(node.path);
    if (!object && node.instances.length > 0) {
      const parent = byPath.get(node.path.split("/").slice(0, -1).join("/"));
      if (parent) {
        const built = await buildScene([node], fetchers, currentFallbacks, time);
        if (isStale()) {
          disposeScene(built);
          return;
        }
        object = built.children[0];
        if (object) {
          parent.add(object);
          object.traverse((child) => {
            if (child.name) byPath.set(child.name, child);
          });
        }
      }
      continue;
    }
    const context: InstanceContext | null =
      node.instances.length > 0
        ? { instances: node.instances, transform: new THREE.Matrix4() }
        : instancing
          ? {
              instances: instancing.instances,
              transform: instancing.transform.clone().multiply(new THREE.Matrix4().fromArray(node.transform)),
            }
          : null;
    if (object) {
      // Thread the instancing context exactly like buildNode: a node with
      // its own instances roots a synthetic subtree (wrapper keeps its
      // transform, which is identity per the manifest), while a node under
      // one had its wrapper collapsed to identity with the transform folded
      // into the per-instance matrices. So for a subtree descendant the
      // wrapper stays collapsed and count/matrices re-derive from the root
      // context — applying node.transform or reading the descendant's own
      // (empty) node.instances here would hide or drift every child.
      const isSubtreeNode = instancing !== null && node.instances.length === 0;
      const drawable = object as THREE.Mesh | THREE.Points;
      const isDrawable = object instanceof THREE.Mesh || (drawable as THREE.Points).isPoints;
      const wrapper = isDrawable ? object.parent! : object;
      if (!isSubtreeNode) applyTransform(wrapper, node.transform);
      wrapper.visible = node.visible;
      if (node.animated && isDrawable) {
        // Only geometry whose OWN attrs carry time samples changes per
        // step; transform-only animated nodes (the bulk of instanced/
        // xform-driven scenes) keep their load-time geometry forever.
        if (node.geometry_animated) {
          if (isStale()) return;
          try {
            const geometry = toBufferGeometry(await fetchers.getGeometry(node.path, time));
            if (isStale()) return;
            drawable.geometry.dispose();
            drawable.geometry = geometry;
          } catch (e) {
            console.warn(`usdbee: keeping last geometry at ${node.path}:`, e);
          }
        }
        let instanced = drawable as THREE.InstancedMesh;
        const matrices =
          node.instances.length > 0
            ? node.instances.map((instance) => new THREE.Matrix4().fromArray(instance))
            : isSubtreeNode
              ? context!.instances.map((instance) =>
                  new THREE.Matrix4().fromArray(instance).multiply(context!.transform),
                )
              : null;
        if (instanced.isInstancedMesh && matrices && matrices.length > 0) {
          if (matrices.length > instanced.instanceMatrix.count) {
            const replacement = new THREE.InstancedMesh(
              instanced.geometry,
              instanced.material,
              matrices.length,
            );
            replacement.name = instanced.name;
            replacement.castShadow = instanced.castShadow;
            replacement.receiveShadow = instanced.receiveShadow;
            wrapper.add(replacement);
            wrapper.remove(instanced);
            instanced.dispose();
            byPath.set(node.path, replacement);
            instanced = replacement;
          }
          instanced.count = matrices.length;
          matrices.forEach((matrix, i) => instanced.setMatrixAt(i, matrix));
          instanced.instanceMatrix.needsUpdate = true;
        }
      }
    }
    await updateNodes(node.children, byPath, time, isStale, context);
  }
}

async function updateScene(nodes: RenderNode[], time: number, isStale: () => boolean): Promise<void> {
  const present = new Set<string>();
  const collect = (entries: RenderNode[]) => {
    for (const node of entries) {
      present.add(node.path);
      collect(node.children);
    }
  };
  collect(nodes);
  await updateNodes(nodes, currentPaths, time, isStale);
  if (isStale()) return;
  for (const [path, object] of currentPaths) {
    if ((object as THREE.InstancedMesh).isInstancedMesh && !present.has(path)) {
      object.parent!.visible = false;
    }
  }
}

export const renderState = $state({
  // Queried USD stage time. Loads reset it to the new stage's start.
  time: null as number | null,
  onTimeChange: null as ((time: number) => void) | null,
  // Whether the loaded manifest contains any animated node (drives the
  // timeline's visibility).
  hasAnimated: false,
  status: "idle" as "idle" | "loading" | "ready" | "error",
  error: null as string | null,

  // Builds the render scene from the manifest of the currently open stage.
  // Returns null when the response was superseded (or the fetch failed) —
  // a superseded scene is disposed, never handed to the viewport.
  async loadRenderScene(
    startTime = 0,
    fallbackColors: FallbackDependencies = {},
  ): Promise<THREE.Group | null> {
    const work = this.loadWork(startTime, fallbackColors);
    // Assigned right after the call: the work body runs synchronously up to
    // its first await, so no caller can observe the gap below.
    loadPromise = work.then(() => {});
    return work;
  },

  async loadWork(
    startTime: number,
    fallbackColors: FallbackDependencies,
  ): Promise<THREE.Group | null> {
    const generation = ++loadGeneration;
    sceneLoading = true;
    queuedTime = null;
    this.time = startTime;
    this.onTimeChange?.(startTime);
    this.status = "loading";
    this.error = null;
    try {
      const manifest = await invoke<RenderNode[]>("get_scene_manifest", {
        time: startTime,
      });
      if (generation !== loadGeneration) return null;
      this.hasAnimated = anyAnimated(manifest);
      currentFallbacks = fallbackColors;
      const group = await buildScene(manifest, fetchers, fallbackColors, startTime);
      if (generation !== loadGeneration) {
        disposeScene(group);
        return null;
      }
      currentGroup = group;
      currentPaths = indexByPath(group);
      this.status = "ready";
      sceneLoading = false;
      const pendingTime = queuedTime;
      queuedTime = null;
      if (pendingTime !== null) await this.setStageTime(pendingTime);
      return group;
    } catch (e) {
      if (generation !== loadGeneration) return null;
      sceneLoading = false;
      queuedTime = null;
      // A failed load leaves no integrated scene to step: release the old
      // group so setStageTime cannot mutate a dead scene.
      currentGroup = null;
      currentPaths = new Map();
      currentFallbacks = {};
      this.status = "error";
      this.error = typeof e === "string" ? e : String(e);
      console.warn("usdbee: scene load failed; released the old scene:", this.error);
      return null;
    }
  },

  // Steps the stage time (USD time codes) and updates the integrated
  // scene in place: one manifest fetch, then per-animated-node geometry
  // fetches. One step runs at a time; rapid requests coalesce to the
  // latest queued time. Loads still supersede active work via loadGeneration.
  setStageTime(time: number): Promise<void> {
    this.time = time;
    this.onTimeChange?.(time);
    if (sceneLoading) {
      queuedTime = time;
      // Resolve only once the load (and its queued refresh) has run.
      return loadPromise ?? activeTimeStep ?? Promise.resolve();
    }
    if (timeStepInFlight) {
      queuedTime = time;
      return activeTimeStep ?? Promise.resolve();
    }
    const generation = ++loadGeneration;
    const group = currentGroup;
    if (!group) return Promise.resolve();
    timeStepInFlight = true;
    activeTimeStep = (async () => {
      try {
        const manifest = await invoke<RenderNode[]>("get_scene_manifest", { time });
        if (generation !== loadGeneration || currentGroup !== group) return;
        await updateScene(manifest, time, () => generation !== loadGeneration || currentGroup !== group);
      } catch (e) {
        if (generation === loadGeneration) {
          // Keep the last good scene on screen; surface why.
          this.error = typeof e === "string" ? e : String(e);
        }
      } finally {
        timeStepInFlight = false;
        activeTimeStep = null;
        if (!sceneLoading) {
          const pendingTime = queuedTime;
          queuedTime = null;
          // Detached: awaiting this would extend the caller's promise chain
          // past our own refresh — with a sustained playback driver that
          // chain never ends and loads hung forever. The next step runs on
          // its own; the load's single in-line drain (loadWork) stays
          // awaited so a queued-completion caller still resolves after the
          // load's refresh applied.
          if (pendingTime !== null) void this.setStageTime(pendingTime);
        }
      }
    })();
    return activeTimeStep;
  },

  // Animated content refresh: a full re-load at the current stage time,
  // keeping the last load's fallback colors (the {} default would wipe them).
  refreshAnimated(): Promise<THREE.Group | null> {
    return this.loadRenderScene(this.time !== null ? this.time : 0, currentFallbacks);
  },
});
