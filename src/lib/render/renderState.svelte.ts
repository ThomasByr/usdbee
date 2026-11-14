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
import type { CameraInfo, MaterialInfo, LightInfo, RenderNode } from "../stage/types";
import { stageState } from "../stage/stageState.svelte";
import { decodeGeometryBatch, decodeMaterialBatch } from "./geometryDecoder";
import { decodeAnimatedPose } from "./poseDecoder";
import {
  claimPoseBatch,
  holdsPoseStep,
  invalidatePoseBuffer,
  settlePoseBatch,
  takePose,
} from "./posePrefetch";
import { loadCachedTexture, clearTextureCache } from "./textureCache";
import { pickTextureLoader } from "./textureLoaders";
import * as frameDiag from "../perf/frameDiag";
import { requestShadowUpdate } from "../three/shadowMapUpdate";
import {
  applyPackedGeometryInPlace,
  applyTransform,
  buildScene,
  disposeScene,
  GEOMETRY_BATCH_SIZE,
  toBufferGeometry,
  type BuildProgress,
  type FallbackDependencies,
  type InstanceContext,
  type SceneFetchers,
  type AnimatedPose,
} from "./sceneBuilder";

let loadGeneration = 0;
// Bumped ONLY where a load begins (loadWork). loadGeneration also moves on
// every playback step and edit refresh, so anything fetched at load time and
// resolved afterwards must be guarded by this instead: playback steps run
// while the scene is ready, racing the load-scoped replies.
let sceneLoadId = 0;
let sceneLoading = false;
let timeStepInFlight = false;
// True while a queue drain calls setStageTime: the drained time was
// optimistically written to this.time when it was queued, so the
// same-time dedupe must not skip the apply.
let drainingQueue = false;
// The in-flight step is either a time step (void) or an edit refresh
// (boolean: true when the caller must fall back to a full rebuild).
let activeTimeStep: Promise<unknown> | null = null;
// Promise covering the whole in-flight load (including its queued refresh);
// resolves even on failure so waiting time steps never hang.
let loadPromise: Promise<void> | null = null;
// A time step coalesced behind a load or an active step, with the policy it
// was requested under (a replay of the queue must hold the same way).
interface QueuedStep {
  time: number;
  holdOnMiss: boolean;
}
let queuedTime: QueuedStep | null = null;
// An edit refresh queued behind a load or an active step (Phase 3 Task 4).
let queuedRefresh: string[] | null = null;
// Coalesced edit-refresh callers await the drain's verdict instead of a
// conservative rebuild: a transform-only second event no longer vanishes
// the whole scene. Plain, like the other queue state — never rendered.
let queuedVerdict: ReturnType<typeof Promise.withResolvers<boolean>> | null = null;

// Reads and clears the queued step in one go: every drain does exactly this.
function takeQueuedTime(): QueuedStep | null {
  const pending = queuedTime;
  queuedTime = null;
  return pending;
}

// Superseded or failed work drops the queued refresh and hands its
// coalesced callers the rebuild they would have asked for.
function dropQueuedRefresh() {
  queuedRefresh = null;
  queuedVerdict?.resolve(true);
  queuedVerdict = null;
}

// The group + path->object index of the last successfully built scene.
// loadRenderScene hands the group to the caller (which integrates it into
// the viewport); setStageTime mutates that same group in place.
let currentGroup: THREE.Group | null = null;
let currentPaths = new Map<string, THREE.Object3D>();
let currentFallbacks: FallbackDependencies = {};

// Per-instance scratch: setMatrixAt copies into the instance buffer right
// away, so one matrix serves every instance of a step (no GC churn).
const scratchInstance = new THREE.Matrix4();

// The open stage's authored time-sample times (unioned, ascending) —
// empty when nothing is time-sampled. Playback/scrubbing snaps to these
// so repeated visits hit the Rust MeshCache.
export function getTimeCodes(stageId: number): Promise<number[]> {
  return invoke<number[]>("get_time_codes", { stageId });
}

// F4: the stage's light prims, one entry per light prim (the list is small and
// its attributes are read at load time). A failed read leaves the caller on the
// studio rig rather than failing the load.
export async function getStageLights(stageId: number): Promise<LightInfo[]> {
  try {
    return (await invoke<LightInfo[]>("get_stage_lights", { stageId })) ?? [];
  } catch (e) {
    console.warn("usdbee: stage lights unavailable; keeping the studio rig:", e);
    return [];
  }
}

// F5: the stage's camera prims (path, name, lens and world transform), read
// once per load like the lights. A failed read leaves the look-through picker
// empty rather than failing the load.
export async function getStageCameras(stageId: number): Promise<CameraInfo[]> {
  try {
    return (await invoke<CameraInfo[]>("get_stage_cameras", { stageId })) ?? [];
  } catch (e) {
    console.warn("usdbee: stage cameras unavailable; the look-through picker is empty:", e);
    return [];
  }
}

// One pose response (stage.rs::frame_pose): the compact binary frame of a
// delta manifest (path + material tables, 80-byte node records, then the
// geometry batch frame). Decoded by poseDecoder (pure, unit-tested apart
// from the invoke).
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
  // Playback pose: one invoke carries the delta manifest AND its
  // animated-geometry slots (two serial round trips per pose dropped frames
  // in dev). Decoded here so the step only applies the result.
  getAnimatedPose: async (time: number) =>
    decodeAnimatedPose(
      await invoke<ArrayBuffer>("get_animated_pose", { stageId: stageState.activeStageId, time }),
    ),
  // Playback prefetch: K poses in ONE invoke, the raw batch payload — the
  // settle splits it into per-code frames and takePose decodes one per step
  // (never all K in one between-frame task). The backend omits out-of-stage
  // times, so the splitter asserts frame_count === times.length.
  getAnimatedPoseBatch: async (times: number[]) =>
    invoke<ArrayBuffer>("get_animated_pose_batch", {
      stageId: stageState.activeStageId,
      times,
    }),
  getMaterial: (path: string) =>
    invoke<MaterialInfo>("get_material_data", {
      stageId: stageState.activeStageId,
      path,
    }).catch(() => null),
  // Load-time material prefill (Phase 2 Task 3): one invoke per slice of
  // GEOMETRY_BATCH_SIZE paths, the material slots decoded here so sceneBuilder
  // only sees per-path results.
  getMaterialBatch: async (paths: string[]) =>
    decodeMaterialBatch(
      await invoke<ArrayBuffer>("get_material_batch", {
        stageId: stageState.activeStageId,
        paths,
      }),
    ),
  // F6: one decode per file — loadCachedTexture loads through the shared
  // loader on the first reference and clones for every later one. The loader
  // is picked by extension (EXR is a data texture, not an image).
  loadTexture: (filePath: string, onError: () => void) =>
    loadCachedTexture(filePath, onError, (onLoad, onImageError) => {
      const url = convertFileSrc(filePath);
      try {
        return pickTextureLoader(filePath).load(url, onLoad, undefined, onImageError);
      } catch {
        return null;
      }
    }),
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

// How many codes a pose may stand for. Nearest-code snapping holds a pose for
// half the gap on either side of its code, so up to a couple of codes is
// sub-frame sampling (< 33 ms at 30 tcps). Past this the authored keys are
// sparse and the hold is the clip standing still: the bike stage has holes of
// 37 and 44 codes, i.e. 616 and 732 ms parked on the code before the hole
// (measured), then a jump across it.
const CODE_HOLD_LIMIT_CODES = 3;

/**
 * The playback driver's query time: the nearest authored code while the
 * playhead sits in a dense run of keys, and the playhead's own time while it
 * crosses a hole in them. USD interpolates between the authored keys, so a
 * sparse stretch keeps moving instead of parking; the driver quantizes that
 * time onto the tcps grid and batches the grid times (posePrefetch).
 *
 * The stage bounds are part of the gap math: a key list that does not reach
 * start_time_code / end_time_code has a hole at that seam, and snapping there
 * would park the head / tail exactly like an interior hole did.
 */
export function snapToPlayableTime(time: number, codes: number[], start: number, end: number): number {
  if (codes.length === 0) return time;
  let index = 0;
  for (let i = 1; i < codes.length; i++) {
    if (Math.abs(codes[i]! - time) < Math.abs(codes[index]! - time)) index = i;
  }
  const previousGap = index > 0 ? codes[index]! - codes[index - 1]! : codes[index]! - start;
  const nextGap = index + 1 < codes.length ? codes[index + 1]! - codes[index]! : end - codes[index]!;
  return Math.max(previousGap, nextGap) > CODE_HOLD_LIMIT_CODES ? time : codes[index]!;
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

// Playback look-ahead (round 4): while any of the K looked-ahead poses is
// missing, ONE background batch fetches the next K times — authored codes, or
// the grid times of the hole the playhead is crossing. Detached on purpose —
// the frame is stepped either way and the fill lands later; a stale or failed
// batch is simply dropped. `includeAnchor` is the wrap branch's claim: it
// carries the playhead's own time as slot 0 (see claimPoseBatch).
export function prefetchPoses(code: number, tcps = 0, includeAnchor = false): Promise<void> {
  const claimed = claimPoseBatch(renderState.timeCodes, code, tcps, includeAnchor);
  if (!claimed) return Promise.resolve();
  return (async () => {
    const startedAt = performance.now();
    try {
      const payload = await fetchers.getAnimatedPoseBatch!(claimed.times);
      // ONE dispatch sample per batch: the invoke's wall time, recorded where
      // the batch resolves. A per-pose sample would hide it (the batch's own
      // ~145 ms is not attributable to any single pose it carries).
      frameDiag.onPoseDispatched(performance.now() - startedAt);
      settlePoseBatch(claimed, payload);
    } catch (e) {
      settlePoseBatch(claimed, null);
      console.warn("usdbee: pose prefetch failed; stepping one pose at a time:", e);
    }
  })();
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

// Shadow-map dirtiness: only a caster that actually moved can change the
// depth target, so every apply reports whether anything did. Compares a raw
// source matrix (the manifest floats, before any composition) against the
// floats the node already carries, so it costs no fetch.
function sameMatrix(bytes: ArrayLike<number>, offset: number, matrix: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (bytes[offset + i] !== matrix[i]) return false;
  return true;
}

// The instance INPUTS last applied to each mesh: the raw per-instance source
// floats plus the accumulated context transform composed into them. The
// composed matrix is never compared: the buffer only holds its rounded f32
// product, so a re-applied pose would never match. Both recorded inputs are
// f64 and the composition is deterministic, so an identical re-apply compares
// bit-equal. The transform is what catches motion inside a prototype subtree:
// a descendant's local transform never appears in the root sources, only in
// the composed matrices.
interface AppliedInstances {
  sources: Float64Array;
  transform: Float64Array;
}

const appliedInstances = new WeakMap<THREE.InstancedMesh, AppliedInstances>();

// Whether any recorded instance input differs from the apply in hand,
// remembering the new inputs either way (skipping the store would desync the
// mesh from its record and over-request forever after). An owned root always
// passes the identity context transform, so its compare is constant.
function instanceInputsMoved(
  mesh: THREE.InstancedMesh,
  sources: number[][],
  transform: ArrayLike<number>,
): boolean {
  const size = sources.length * 16;
  let applied = appliedInstances.get(mesh);
  let moved = applied === undefined || applied.sources.length !== size;
  if (!applied || applied.sources.length !== size) {
    applied = { sources: new Float64Array(size), transform: new Float64Array(16) };
    appliedInstances.set(mesh, applied);
  }
  for (let i = 0; i < 16; i++) {
    if (applied.transform[i] !== transform[i]) moved = true;
    applied.transform[i] = transform[i];
  }
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    for (let j = 0; j < 16; j++) {
      if (applied.sources[i * 16 + j] !== source[j]) moved = true;
      applied.sources[i * 16 + j] = source[j];
    }
  }
  return moved;
}

// Applies the manifest's time state to the integrated scene. Animated
// geometry is rebuilt; instanced prototypes can appear, disappear, or
// change count as invisibleIds changes. Every await is generation-guarded.
// `refreshPaths` (edit refresh) additionally force-refetches geometry for
// the affected prims — an edit can swap geometry on a non-animated node —
// consuming slots from the batched `prefetched` map first. Returns whether
// any caster moved (matrix, visibility or geometry), which is the only thing
// the shadow map cares about.
async function updateNodes(
  nodes: RenderNode[],
  byPath: Map<string, THREE.Object3D>,
  time: number,
  isStale: () => boolean,
  instancing: InstanceContext | null = null,
  refreshPaths: Set<string> | null = null,
  prefetched: Map<string, ArrayBuffer | Uint8Array | null> | null = null,
): Promise<boolean> {
  let moved = false;
  for (const node of nodes) {
    if (isStale()) return moved;
    let object = byPath.get(node.path);
    if (!object && node.instances.length > 0) {
      const parent = byPath.get(node.path.split("/").slice(0, -1).join("/"));
      if (parent) {
        const built = await buildScene([node], fetchers, currentFallbacks, time);
        if (isStale()) {
          disposeScene(built);
          return moved;
        }
        object = built.children[0];
        if (object) {
          parent.add(object);
          object.traverse((child) => {
            if (child.name) byPath.set(child.name, child);
          });
          moved = true; // a caster appeared in the scene
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
      if (!isSubtreeNode) {
        if (!sameMatrix(wrapper.matrix.elements, 0, node.transform)) moved = true;
        applyTransform(wrapper, node.transform);
      }
      if (wrapper.visible !== node.visible) moved = true;
      wrapper.visible = node.visible;
      const refreshing = refreshPaths !== null && refreshPaths.has(node.path);
      if (isDrawable && (node.animated || refreshing)) {
        // Only geometry whose OWN attrs carry time samples changes per
        // step; transform-only animated nodes (the bulk of instanced/
        // xform-driven scenes) keep their load-time geometry forever. An
        // edit refresh refetches the affected prim regardless.
        if (node.geometry_animated || refreshing) {
          if (isStale()) return moved;
          try {
            // Edit refreshes consume the batched slots first (a failed
            // slot keeps the last geometry, fail-soft like playback); the
            // per-path command stays the playback-step path.
            const pre = prefetched?.get(node.path);
            prefetched?.delete(node.path);
            const frame = pre !== undefined ? pre : await fetchers.getGeometry(node.path, time);
            if (isStale()) return moved;
            if (frame) {
              // Layout-compatible frames update the live geometry in
              // place (same GPU buffers); anything else recreates.
              if (!applyPackedGeometryInPlace(drawable.geometry, frame)) {
                const geometry = toBufferGeometry(frame);
                if (isStale()) {
                  geometry.dispose();
                  return moved;
                }
                drawable.geometry.dispose();
                drawable.geometry = geometry;
              }
              moved = true; // a geometry slot was written
            }
          } catch (e) {
            console.warn(`usdbee: keeping last geometry at ${node.path}:`, e);
          }
        }
        let instanced = drawable as THREE.InstancedMesh;
        // Subtree descendants carry no instances of their own: theirs come
        // from the root context, composed with the collapsed wrapper.
        const owned = node.instances.length > 0;
        const sources = owned ? node.instances : isSubtreeNode ? context!.instances : null;
        if (instanced.isInstancedMesh && sources && sources.length > 0) {
          if (sources.length > instanced.instanceMatrix.count) {
            const replacement = new THREE.InstancedMesh(
              instanced.geometry,
              instanced.material,
              sources.length,
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
          if (instanced.count !== sources.length) moved = true;
          instanced.count = sources.length;
          // Compared before composition: a collapsed subtree wrapper carries
          // its motion only in its instance sources and the context transform
          // folded into them.
          if (instanceInputsMoved(instanced, sources, context!.transform.elements)) moved = true;
          for (let i = 0; i < sources.length; i++) {
            scratchInstance.fromArray(sources[i]);
            if (!owned) scratchInstance.multiply(context!.transform);
            instanced.setMatrixAt(i, scratchInstance);
          }
          instanced.instanceMatrix.needsUpdate = true;
        }
      }
    }
    if (await updateNodes(node.children, byPath, time, isStale, context, refreshPaths, prefetched))
      moved = true;
  }
  return moved;
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
  let moved = await updateNodes(nodes, currentPaths, time, isStale, null, refreshPaths, prefetched);
  if (isStale()) return;
  for (const [path, object] of currentPaths) {
    if ((object as THREE.InstancedMesh).isInstancedMesh && !present.has(path)) {
      if (object.parent!.visible) moved = true;
      object.parent!.visible = false;
    }
  }
  if (moved) requestShadowUpdate();
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
  let moved = await updateNodes(nodes, currentPaths, time, isStale, null, null, prefetched);
  if (isStale()) return;
  for (const [path, object] of currentPaths) {
    if ((object as THREE.InstancedMesh).isInstancedMesh && !present.has(path)) {
      const slash = path.lastIndexOf("/");
      const isDirectWrapper = path.slice(slash + 1).startsWith("__proto_");
      if (isDirectWrapper && present.has(path.slice(0, slash))) {
        if (object.parent!.visible) moved = true;
        object.parent!.visible = false;
      }
    }
  }
  // A pose only redraws the shadow map when a caster moved: most poses leave
  // the depth target alone, and the redraw lands a frame late on an already
  // tight frame.
  if (moved) requestShadowUpdate();
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
  // The code the last setStageTime request was HELD on (null when it wrote or
  // was not a playback hold). A hold leaves `time` on the last applied code
  // on purpose; the playback driver reads this to tell that lag apart from an
  // external write it must adopt.
  heldTime: null as number | null,
  // Whether a pose step currently holds the transport. A paused scrub fires
  // one step per drag step, so it is busy even though nothing is playing.
  get isTimeStepInFlight() {
    return timeStepInFlight;
  },

  // Builds the render scene from the manifest of the currently open stage.
  // Returns null when the response was superseded (or the fetch failed) —
  // a superseded scene is disposed, never handed to the viewport.
  async loadRenderScene(
    startTime = 0,
    fallbackColors: FallbackDependencies = {},
    onProgress?: BuildProgress,
  ): Promise<THREE.Group | null> {
    const work = this.loadWork(startTime, fallbackColors, onProgress);
    // Assigned right after the call: the work body runs synchronously up to
    // its first await, so no caller can observe the gap below.
    loadPromise = work.then(() => {});
    return work;
  },

  async loadWork(
    startTime: number,
    fallbackColors: FallbackDependencies,
    onProgress?: BuildProgress,
  ): Promise<THREE.Group | null> {
    const generation = ++loadGeneration;
    const loadId = ++sceneLoadId;
    // F6: the texture memo covers ONE load — the old scene's clones were
    // disposed by whoever dropped it, so the images they shared go too
    // before the new build repopulates the memo.
    clearTextureCache();
    // A new scene invalidates every looked-ahead pose (other stage, other
    // codes): an in-flight batch lands stale and is dropped.
    frameDiag.onInvalidate("load");
    invalidatePoseBuffer();
    sceneLoading = true;
    queuedTime = null;
    // A rebuild supersedes any queued edit refresh (the load re-fetches
    // everything anyway) — drop it like a queued time step.
    dropQueuedRefresh();
    this.time = startTime;
    this.heldTime = null;
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
      // A superseded build keeps running inside buildScene; only a live
      // generation may write the shared loading bar.
      const guardedProgress: BuildProgress | undefined = onProgress
        ? (stage, percent) => {
            if (generation === loadGeneration) onProgress(stage, percent);
          }
        : undefined;
      const group = await buildScene(manifest, fetchers, fallbackColors, startTime, guardedProgress);
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
          if (loadId === sceneLoadId && Array.isArray(codes)) {
            this.timeCodes = codes;
            // Seed the look-ahead window while the stage still sits idle: a
            // play press then starts on a buffered batch instead of paying the
            // transport's first-invoke wake-up on its first frame, which the
            // 250 ms hold deadline cannot absorb.
            void prefetchPoses(this.time ?? codes[0] ?? 0, stageState.stageInfo?.time_codes_per_second ?? 24);
          }
        } catch {
          // Codes unavailable: times stay continuous.
        }
      })();
      sceneLoading = false;
      const pending = takeQueuedTime();
      if (pending !== null) {
        drainingQueue = true;
        try {
          await this.setStageTime(pending.time, pending.holdOnMiss);
        } finally {
          drainingQueue = false;
        }
      }
      await this.drainQueuedRefresh();
      return group;
    } catch (e) {
      if (generation !== loadGeneration) return null;
      sceneLoading = false;
      queuedTime = null;
      // Nothing applied: a queued edit refresh must still hand its callers
      // the rebuild instead of leaving them pending.
      dropQueuedRefresh();
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
  // scene in place: ONE invoke per pose (delta manifest + geometry slots),
  // then updateNodes applies them. One step runs at a time; rapid requests
  // coalesce to the latest queued time. Loads still supersede active work
  // via loadGeneration.
  //
  // `holdOnMiss` is the playback driver's policy: a buffer miss waits for
  // the batch in transit instead of injecting a single-pose fetch (see
  // holdsPoseStep). Every other caller — paused scrub, export frame, edit
  // refresh — fetches, because nothing would retry it.
  setStageTime(time: number, holdOnMiss = false): Promise<void> {
    // Answers this request only: the driver reads it right after the call.
    this.heldTime = null;
    // Same-time dedupe: with time-code snapping the driver re-requests the
    // identical time on most frames (each a full manifest fetch); skip
    // when the state already sits at the requested time.
    if (!drainingQueue && time === this.time) return Promise.resolve();
    // Hold on a buffer miss while the prefetch is alive: no fetch, no apply,
    // and NO time write. The write is what the playback driver's resync
    // adopts, which rewinds its continuous playhead onto the very code it is
    // waiting for (measured: poseMax 765 ms, frozen motion). Leaving the time
    // behind lets the playhead pass the code; once the batch lands, the
    // request for it no longer matches this.time, so the dedupe cannot eat it.
    // heldTime is how the driver tells that deliberate lag from an external
    // write without matching on the time alone.
    if (
      currentGroup &&
      holdOnMiss &&
      !sceneLoading &&
      !timeStepInFlight &&
      holdsPoseStep(this.timeCodes, time)
    ) {
      this.heldTime = time;
      frameDiag.onPoseHeld();
      return Promise.resolve();
    }
    this.time = time;
    this.onTimeChange?.(time);
    if (sceneLoading) {
      queuedTime = { time, holdOnMiss };
      // Resolve only once the load (and its queued refresh) has run.
      return (loadPromise ?? activeTimeStep ?? Promise.resolve()) as Promise<void>;
    }
    if (timeStepInFlight) {
      queuedTime = { time, holdOnMiss };
      return (activeTimeStep as Promise<void>) ?? Promise.resolve();
    }
    const group = currentGroup;
    if (!group) return Promise.resolve();
    const generation = ++loadGeneration;
    timeStepInFlight = true;
    activeTimeStep = (async () => {
      try {
        // Frame-pacing diagnostics: how long one pose costs end to end.
        // Optional-called: a webview without User Timing must lose the
        // diagnostic, not the pose (this try is what keeps the last good
        // scene). Cleared right after measuring so a long playback does not
        // grow the timeline.
        performance.mark?.("usdbee:pose:issued");
        const poseStartedAt = performance.now();
        // A prefetched pose arrives as RAW frame bytes: decode+apply is
        // sub-ms, so the settle stores the batch undecoded and the pose
        // costs one frame's decode here instead of a transport round trip.
        // A miss takes the single-pose path below, unchanged.
        const buffered = takePose(time);
        // An in-hole time is a real USD pose the playhead is crossing, not a
        // fallback: counted apart so singleFallbackTotal keeps meaning starvation.
        // An empty key list is continuous everywhere, not in a hole.
        const inHole = this.timeCodes.length > 0 && frameDiag.codeIndex(this.timeCodes, time) < 0;
        let manifest: RenderNode[];
        let prefetched: AnimatedPose["prefetched"] | null = null;
        if (buffered) {
          // No dispatch sample: the batch's own wall time was recorded at fill
          // time, and a synthetic 0 per pose would flood the ring and dilute it.
          manifest = buffered.manifest;
          prefetched = buffered.prefetched;
        } else {
          // Playback wanted a hold and did not get one: the batch path is
          // dead, nothing is on the wire, or the deadline expired. Scrubs
          // (holdOnMiss false) fetch on purpose, and hole frames are expected.
          if (holdOnMiss && !inHole) frameDiag.onSingleFallback();
          const pose = await fetchers.getAnimatedPose!(time);
          // Dispatch half of the span: the bytes are in hand, decode+apply follow.
          frameDiag.onPoseDispatched(performance.now() - poseStartedAt);
          if (generation !== loadGeneration || currentGroup !== group) return;
          manifest = pose.manifest;
          prefetched = pose.prefetched;
        }
        const isStale = () => generation !== loadGeneration || currentGroup !== group;
        await updateSceneDelta(manifest, time, isStale, prefetched);
        performance.measure?.("usdbee:pose", "usdbee:pose:issued");
        frameDiag.onPoseApplied(performance.now() - poseStartedAt);
        if (inHole) frameDiag.onHoleFrame();
        performance.clearMarks?.("usdbee:pose:issued");
        performance.clearMeasures?.("usdbee:pose");
      } catch (e) {
        if (generation === loadGeneration) {
          // Keep the last good scene on screen; surface why.
          this.error = typeof e === "string" ? e : String(e);
        }
      } finally {
        timeStepInFlight = false;
        activeTimeStep = null;
        if (!sceneLoading) {
          const pending = takeQueuedTime();
          // Detached: awaiting this would extend the caller's promise chain
          // past our own refresh — with a sustained playback driver that
          // chain never ends and loads hung forever. The next step runs on
          // its own; the load's single in-line drain (loadWork) stays
          // awaited so a queued-completion caller still resolves after the
          // load's refresh applied.
          if (pending !== null) {
            drainingQueue = true;
            try {
              void this.setStageTime(pending.time, pending.holdOnMiss);
            } finally {
              drainingQueue = false;
            }
          }
          void this.drainQueuedRefresh();
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
  // changed the scene structure: the caller then falls back to a full
  // rebuild. A caller coalesced behind an in-flight step resolves with the
  // drained refresh's verdict (see drainQueuedRefresh).
  refreshAfterEdit(paths: string[]): Promise<boolean> {
    // Whole-layer imports and their undo/redo can reshape any prim.
    if (paths.includes("/")) return Promise.resolve(true);
    if (sceneLoading || timeStepInFlight) {
      queuedRefresh = queuedRefresh ? Array.from(new Set([...queuedRefresh, ...paths])) : paths;
      if (!queuedVerdict) queuedVerdict = Promise.withResolvers<boolean>();
      return queuedVerdict.promise;
    }
    const generation = ++loadGeneration;
    const group = currentGroup;
    if (!group) return Promise.resolve(false);
    // An edit changes geometry: buffered poses carry the pre-edit prims.
    frameDiag.onInvalidate("edit");
    invalidatePoseBuffer();
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
          const pending = takeQueuedTime();
          if (pending !== null) {
            drainingQueue = true;
            try {
              void this.setStageTime(pending.time, pending.holdOnMiss);
            } finally {
              drainingQueue = false;
            }
          }
          void this.drainQueuedRefresh();
        }
      }
    })();
    return activeTimeStep as Promise<boolean>;
  },

  // Tails every queue drain: runs the queued edit refresh and hands its
  // verdict to the callers it coalesced away. Resolves with that verdict;
  // the load awaits it so a queued-completion caller still resolves after
  // the refresh applied. A re-queue (a time step that restarted mid-drain)
  // goes through the same coalescing branch, so the chained call's own
  // verdict is what those callers finally observe.
  drainQueuedRefresh(): Promise<boolean> {
    const pendingRefresh = queuedRefresh;
    queuedRefresh = null;
    const verdict = queuedVerdict;
    queuedVerdict = null;
    if (pendingRefresh === null) return Promise.resolve(true);
    return this.refreshAfterEdit(pendingRefresh).then(
      (v) => {
        verdict?.resolve(v);
        return v;
      },
      () => {
        verdict?.resolve(true);
        return true;
      },
    );
  },

  // Animated content refresh: a full re-load at the current stage time,
  // keeping the last load's fallback colors (the {} default would wipe them).
  refreshAnimated(): Promise<THREE.Group | null> {
    return this.loadRenderScene(this.time !== null ? this.time : 0, currentFallbacks);
  },
});
