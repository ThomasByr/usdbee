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
import { stageState } from "../stage/stageState.svelte";
import { decodeGeometryBatch } from "./geometryDecoder";
import {
  applyTransform,
  buildScene,
  disposeScene,
  GEOMETRY_BATCH_SIZE,
  toBufferGeometry,
  type FallbackDependencies,
  type InstanceContext,
  type SceneFetchers,
} from "./sceneBuilder";

let loadGeneration = 0;
let sceneLoading = false;
let timeStepInFlight = false;
// The in-flight step is either a time step (void) or an edit refresh
// (boolean: true when the caller must fall back to a full rebuild).
let activeTimeStep: Promise<unknown> | null = null;
// Promise covering the whole in-flight load (including its queued refresh);
// resolves even on failure so waiting time steps never hang.
let loadPromise: Promise<void> | null = null;
let queuedTime: number | null = null;
// An edit refresh queued behind a load or an active step (Phase 3 Task 4).
let queuedRefresh: string[] | null = null;

// The group + path->object index of the last successfully built scene.
// loadRenderScene hands the group to the caller (which integrates it into
// the viewport); setStageTime mutates that same group in place.
let currentGroup: THREE.Group | null = null;
let currentPaths = new Map<string, THREE.Object3D>();
let currentFallbacks: FallbackDependencies = {};

// One shared loader; convertMaterial clears failed maps through onError.
const textureLoader = new THREE.TextureLoader();

// The open stage's authored time-sample times (unioned, ascending) —
// empty when nothing is time-sampled. Playback/scrubbing snaps to these
// so repeated visits hit the Rust MeshCache.
export function getTimeCodes(stageId: number): Promise<number[]> {
  return invoke<number[]>("get_time_codes", { stageId });
}

const fetchers: SceneFetchers = {
  getGeometry: (path: string, time = renderState.time) =>
    invoke<ArrayBuffer>("get_geometry_data", {
      stageId: stageState.activeStageId,
      path,
      time,
    }),
  // Load-time batch prefill: one invoke per slice of GEOMETRY_BATCH_SIZE
  // paths, slots decoded here so sceneBuilder only sees per-path results.
  getGeometryBatch: async (paths: string[], time = renderState.time) =>
    decodeGeometryBatch(
      await invoke<ArrayBuffer>("get_geometry_batch", {
        stageId: stageState.activeStageId,
        paths,
        time,
      }),
    ),
  getMaterial: (path: string) =>
    invoke<MaterialInfo>("get_material_data", {
      stageId: stageState.activeStageId,
      path,
    }).catch(() => null),
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
// in USD time codes. Wraps past `end` back into [start, end], then snaps
// to the nearest authored time code from `codes` (empty list → the
// continuous time unchanged; the Rust MeshCache keys by exact f64 bits,
// so fractional times never hit it).
export function snapToTimeCodes(time: number, codes: number[]): number {
  if (codes.length === 0) return time;
  let best = codes[0]!;
  for (const code of codes) {
    if (Math.abs(code - time) < Math.abs(best - time)) best = code;
  }
  return best;
}

export function advanceStageTime(
  current: number,
  deltaSeconds: number,
  timeCodesPerSecond: number,
  start: number,
  end: number,
  codes: number[] = [],
): number {
  const span = end - start;
  if (span <= 0) return start;
  const next = current + deltaSeconds * timeCodesPerSecond;
  const wrapped = next > end ? start + ((next - start) % span) : next;
  return Math.min(Math.max(snapToTimeCodes(wrapped, codes), start), end);
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
// `refreshPaths` (edit refresh) additionally force-refetches geometry for
// the affected prims — an edit can swap geometry on a non-animated node —
// consuming slots from the batched `prefetched` map first.
async function updateNodes(
  nodes: RenderNode[],
  byPath: Map<string, THREE.Object3D>,
  time: number,
  isStale: () => boolean,
  instancing: InstanceContext | null = null,
  refreshPaths: Set<string> | null = null,
  prefetched: Map<string, ArrayBuffer | Uint8Array | null> | null = null,
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
      const refreshing = refreshPaths !== null && refreshPaths.has(node.path);
      if (isDrawable && (node.animated || refreshing)) {
        // Only geometry whose OWN attrs carry time samples changes per
        // step; transform-only animated nodes (the bulk of instanced/
        // xform-driven scenes) keep their load-time geometry forever. An
        // edit refresh refetches the affected prim regardless.
        if (node.geometry_animated || refreshing) {
          if (isStale()) return;
          try {
            // Edit refreshes consume the batched slots first (a failed
            // slot keeps the last geometry, fail-soft like playback); the
            // per-path command stays the playback-step path.
            const pre = prefetched?.get(node.path);
            prefetched?.delete(node.path);
            const frame = pre !== undefined ? pre : await fetchers.getGeometry(node.path, time);
            if (isStale()) return;
            if (frame) {
              const geometry = toBufferGeometry(frame);
              if (isStale()) {
                geometry.dispose();
                return;
              }
              drawable.geometry.dispose();
              drawable.geometry = geometry;
            }
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
    await updateNodes(node.children, byPath, time, isStale, context, refreshPaths, prefetched);
  }
}

async function updateScene(
  nodes: RenderNode[],
  time: number,
  isStale: () => boolean,
  refreshPaths: Set<string> | null = null,
  prefetched: Map<string, ArrayBuffer | Uint8Array | null> | null = null,
): Promise<void> {
  const present = new Set<string>();
  const collect = (entries: RenderNode[]) => {
    for (const node of entries) {
      present.add(node.path);
      collect(node.children);
    }
  };
  collect(nodes);
  await updateNodes(nodes, currentPaths, time, isStale, null, refreshPaths, prefetched);
  if (isStale()) return;
  for (const [path, object] of currentPaths) {
    if ((object as THREE.InstancedMesh).isInstancedMesh && !present.has(path)) {
      object.parent!.visible = false;
    }
  }
}

// Time-delta update (playback/scrub): the delta manifest carries ONLY
// the time-dependent nodes plus connector ancestors, so static nodes —
// including whole static InstancedMeshes — are absent BY DESIGN and must
// stay untouched.
//
// Backend invariant (pinned by animation_tests): whenever a delta
// manifest contains a PointInstancer node, it also contains a synthetic
// child wrapper for EVERY prototype — zero-instance ones included,
// emitted with `instances: []` and `visible: false`, so the normal
// per-node update hides a count that dropped to zero (three.js cascades
// the wrapper's invisibility to threaded descendants). The hide rule
// below is the safety net for the one shape the invariant rules out:
// an absent DIRECT synthetic-root wrapper (path ending in `__proto_N`)
// under a present instancer. Anything else absent — a static threaded
// descendant of a present connector wrapper — is filtered by design and
// must NOT be hidden. Every await is generation-guarded like updateScene.
async function updateSceneDelta(
  nodes: RenderNode[],
  time: number,
  isStale: () => boolean,
): Promise<void> {
  const present = new Set<string>();
  const collect = (entries: RenderNode[]) => {
    for (const node of entries) {
      present.add(node.path);
      collect(node.children);
    }
  };
  collect(nodes);
  await updateNodes(nodes, currentPaths, time, isStale, null, null, null);
  if (isStale()) return;
  for (const [path, object] of currentPaths) {
    if ((object as THREE.InstancedMesh).isInstancedMesh && !present.has(path)) {
      const slash = path.lastIndexOf("/");
      const isDirectWrapper = path.slice(slash + 1).startsWith("__proto_");
      if (isDirectWrapper && present.has(path.slice(0, slash)))
        object.parent!.visible = false;
    }
  }
}

// Geometry for the edit-refreshed prims, fetched through the BATCH
// command (ruling: a single-path refresh is a 1-element batch) in
// bounded sequential slices. A failed batch command leaves the map
// unfilled and updateNodes falls back to per-path fetches, fail-soft.
async function prefetchEditGeometry(
  manifest: RenderNode[],
  refreshPaths: Set<string>,
  time: number,
): Promise<Map<string, ArrayBuffer | Uint8Array | null>> {
  const prefetched = new Map<string, ArrayBuffer | Uint8Array | null>();
  const paths: string[] = [];
  const walk = (nodes: RenderNode[]) => {
    for (const node of nodes) {
      if (node.has_geometry && refreshPaths.has(node.path)) paths.push(node.path);
      walk(node.children);
    }
  };
  walk(manifest);
  for (let start = 0; start < paths.length; start += GEOMETRY_BATCH_SIZE) {
    const slice = paths.slice(start, start + GEOMETRY_BATCH_SIZE);
    try {
      const slots = await fetchers.getGeometryBatch!(slice, time);
      slice.forEach((path, slot) => prefetched.set(path, slots[slot] ?? null));
    } catch (e) {
      console.warn("usdbee: edit-refresh geometry batch failed; fetching per path:", e);
      break;
    }
  }
  return prefetched;
}

// Whether an edit changed the scene STRUCTURE below any affected path:
// prims appearing or vanishing (variant swaps, edits that add children)
// cannot be patched in place — the caller must rebuild the scene. Bounded
// to the affected subtrees, not the whole manifest.
function structureChanged(
  manifest: RenderNode[],
  refreshPaths: Set<string>,
  byPath: Map<string, THREE.Object3D>,
): boolean {
  const manifestNodes = new Map<string, RenderNode>();
  const walk = (nodes: RenderNode[]) => {
    for (const node of nodes) {
      manifestNodes.set(node.path, node);
      walk(node.children);
    }
  };
  walk(manifest);
  for (const path of refreshPaths) {
    const node = manifestNodes.get(path);
    // The path index maps a prim with geometry to its MESH (it shadows
    // the wrapper); the wrapper carries the subtree, so compare from it.
    let object = byPath.get(path);
    if (object && (object as THREE.Mesh).isMesh && object.parent && object.parent.name === path) {
      object = object.parent;
    }
    if (!node && object) return true; // prim vanished from the stage
    // shortcut: non-render edits rebuild the whole scene; upgrade to targeted
    // material dependency invalidation if incremental material updates matter.
    if (!node && !object) return true;
    if (node && !object) return true; // prim appeared — needs a build
    const sceneNames = new Set<string>();
    object!.traverse((child) => {
      if (child.name) sceneNames.add(child.name);
    });
    let missing = false;
    const walkSubtree = (entry: RenderNode) => {
      if (!sceneNames.has(entry.path)) {
        missing = true;
        return;
      }
      entry.children.forEach(walkSubtree);
    };
    walkSubtree(node!);
    if (missing) return true;
    const subtree = new Set<string>();
    const collect = (entry: RenderNode) => {
      subtree.add(entry.path);
      entry.children.forEach(collect);
    };
    collect(node!);
    for (const name of sceneNames) {
      if (!subtree.has(name)) return true; // stale object below the prim
    }
  }
  return false;
}

export const renderState = $state({
  // Queried USD stage time. Loads reset it to the new stage's start.
  time: null as number | null,
  onTimeChange: null as ((time: number) => void) | null,
  // Whether the loaded manifest contains any animated node (drives the
  // timeline's visibility).
  hasAnimated: false,
  // Authored time-sample times of the open stage, refetched per load;
  // empty until the fetch lands (times stay continuous until then).
  timeCodes: [] as number[],
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

  async loadWork(startTime: number, fallbackColors: FallbackDependencies): Promise<THREE.Group | null> {
    const generation = ++loadGeneration;
    sceneLoading = true;
    queuedTime = null;
    // A rebuild supersedes any queued edit refresh (the load re-fetches
    // everything anyway) — drop it like a queued time step.
    queuedRefresh = null;
    this.time = startTime;
    this.timeCodes = [];
    this.onTimeChange?.(startTime);
    this.status = "loading";
    this.error = null;
    try {
      const manifest = await invoke<RenderNode[]>("get_scene_manifest", {
        stageId: stageState.activeStageId,
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
      // Non-blocking: playback stays continuous if it starts before the
      // codes arrive; a superseding load discards the stale reply, and a
      // failed fetch leaves the list empty (continuous times).
      void (async () => {
        try {
          const codes = await getTimeCodes(stageState.activeStageId);
          if (generation === loadGeneration && Array.isArray(codes)) this.timeCodes = codes;
        } catch {
          // Codes unavailable: times stay continuous.
        }
      })();
      sceneLoading = false;
      const pendingTime = queuedTime;
      queuedTime = null;
      if (pendingTime !== null) await this.setStageTime(pendingTime);
      const pendingRefresh = queuedRefresh;
      queuedRefresh = null;
      if (pendingRefresh !== null) await this.refreshAfterEdit(pendingRefresh);
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
  // scene in place: ONE time-delta manifest fetch (only the animated
  // nodes), then per-animated-node geometry fetches. One step runs at a
  // time; rapid requests coalesce to the latest queued time. Loads still
  // supersede active work via loadGeneration.
  setStageTime(time: number): Promise<void> {
    this.time = time;
    this.onTimeChange?.(time);
    if (sceneLoading) {
      queuedTime = time;
      // Resolve only once the load (and its queued refresh) has run.
      return (loadPromise ?? activeTimeStep ?? Promise.resolve()) as Promise<void>;
    }
    if (timeStepInFlight) {
      queuedTime = time;
      return (activeTimeStep as Promise<void>) ?? Promise.resolve();
    }
    const generation = ++loadGeneration;
    const group = currentGroup;
    if (!group) return Promise.resolve();
    timeStepInFlight = true;
    activeTimeStep = (async () => {
      try {
        const manifest = await invoke<RenderNode[]>("get_animated_manifest", {
          stageId: stageState.activeStageId,
          time,
        });
        if (generation !== loadGeneration || currentGroup !== group) return;
        await updateSceneDelta(manifest, time, () => generation !== loadGeneration || currentGroup !== group);
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
          const pendingRefresh = queuedRefresh;
          queuedRefresh = null;
          if (pendingRefresh !== null) void this.refreshAfterEdit(pendingRefresh);
        }
      }
    })();
    return activeTimeStep as Promise<void>;
  },

  // Edit refresh (Phase 3 Task 4): after usd-stage-changed, re-fetch the
  // affected prims' node transforms + geometry IN PLACE — one manifest
  // fetch plus one batched geometry fetch for the affected paths — through
  // the same generation-guard/coalescing machinery as playback steps, so
  // refreshes never fight the bounded drain. Resolves true when the edit
  // changed the scene structure (or the refresh was coalesced away and
  // the verdict is unknown): the caller then falls back to a full rebuild.
  refreshAfterEdit(paths: string[]): Promise<boolean> {
    // Whole-layer imports and their undo/redo can reshape any prim.
    if (paths.includes("/")) return Promise.resolve(true);
    if (sceneLoading || timeStepInFlight) {
      queuedRefresh = paths;
      // shortcut: the coalesced drain loses the rebuild verdict, so a
      // coalesced caller conservatively rebuilds the whole scene.
      return Promise.resolve(true);
    }
    const generation = ++loadGeneration;
    const group = currentGroup;
    if (!group) return Promise.resolve(false);
    timeStepInFlight = true;
    activeTimeStep = (async (): Promise<boolean> => {
      try {
        const time = this.time ?? 0;
        const manifest = await invoke<RenderNode[]>("get_scene_manifest", {
          stageId: stageState.activeStageId,
          time,
        });
        if (generation !== loadGeneration || currentGroup !== group) return true;
        const refreshPaths = new Set(paths);
        const prefetched = await prefetchEditGeometry(manifest, refreshPaths, time);
        if (generation !== loadGeneration || currentGroup !== group) return true;
        const structural = structureChanged(manifest, refreshPaths, currentPaths);
        const isStale = () => generation !== loadGeneration || currentGroup !== group;
        await updateScene(manifest, time, isStale, refreshPaths, prefetched);
        if (isStale()) return true;
        return structural;
      } catch (e) {
        // Keep the last good scene on screen; surface why. A failed
        // refresh is not known to have applied — caller rebuilds.
        if (generation === loadGeneration) {
          this.error = typeof e === "string" ? e : String(e);
        }
        return true;
      } finally {
        timeStepInFlight = false;
        activeTimeStep = null;
        if (!sceneLoading) {
          const pendingTime = queuedTime;
          queuedTime = null;
          if (pendingTime !== null) void this.setStageTime(pendingTime);
          const pendingRefresh = queuedRefresh;
          queuedRefresh = null;
          if (pendingRefresh !== null) void this.refreshAfterEdit(pendingRefresh);
        }
      }
    })();
    return activeTimeStep as Promise<boolean>;
  },

  // Animated content refresh: a full re-load at the current stage time,
  // keeping the last load's fallback colors (the {} default would wipe them).
  refreshAnimated(): Promise<THREE.Group | null> {
    return this.loadRenderScene(this.time !== null ? this.time : 0, currentFallbacks);
  },
});
