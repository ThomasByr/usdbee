// Rust render-backend state (Phase 2, Task 4): loads the render manifest
// from the open stage and builds the Three.js scene from it. House pattern
// from stageState.svelte.ts: a generation counter discards responses from
// superseded loads (the Phase 1 stale-response lesson).
//
// Task 6 adds time codes end-to-end: setStageTime(t) re-fetches the
// manifest and updates the ALREADY-integrated group in place — transforms
// and visibility for every node, geometry only for `animated: true` ones
// (static meshes are never touched, and the scene is not rebuilt).
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import type { MaterialInfo, RenderNode } from "../stage/types";
import {
  applyTransform,
  buildScene,
  disposeScene,
  toBufferGeometry,
  type FallbackDependencies,
  type SceneFetchers,
} from "./sceneBuilder";

let loadGeneration = 0;
let sceneLoading = false;
let timeStepInFlight = false;
let queuedTime: number | null = null;

// The group + path->object index of the last successfully built scene.
// loadRenderScene hands the group to the caller (which integrates it into
// the viewport); setStageTime mutates that same group in place.
let currentGroup: THREE.Group | null = null;
let currentPaths = new Map<string, THREE.Object3D>();

// One shared loader; convertMaterial clears failed maps through onError.
const textureLoader = new THREE.TextureLoader();

const fetchers: SceneFetchers = {
  getGeometry: (path: string, time = renderState.time) =>
    invoke<ArrayBuffer>("get_geometry_data", { path, time }),
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

// Applies the manifest's time state to the integrated scene:
// transform + visibility for every present node, and for animated nodes
// a geometry rebuild (the simpler correct option: dispose the old
// BufferGeometry and assign a fresh one — counts and attribute sets may
// change across time, and in-place attribute surgery cannot). Nodes the
// scene does not have (topology appearing only at this time) are skipped.
// `isStale` is checked per node — before each geometry fetch and again
// before applying — so a superseded time step cannot land older geometry
// over a newer step's result (scrub storms interleave the per-node awaits).
async function updateNodes(
  nodes: RenderNode[],
  byPath: Map<string, THREE.Object3D>,
  time: number,
  isStale: () => boolean,
): Promise<void> {
  for (const node of nodes) {
    if (isStale()) return;
    const object = byPath.get(node.path);
    if (object) {
      const drawable = object as THREE.Mesh | THREE.Points;
      const isDrawable = object instanceof THREE.Mesh || (drawable as THREE.Points).isPoints;
      const wrapper = isDrawable ? object.parent! : object;
      applyTransform(wrapper, node.transform);
      wrapper.visible = node.visible;
      if (node.animated && isDrawable) {
        if (isStale()) return;
        try {
          const geometry = toBufferGeometry(await fetchers.getGeometry(node.path, time));
          if (isStale()) return;
          drawable.geometry.dispose();
          drawable.geometry = geometry;
        } catch (e) {
          console.warn(`usdbee: keeping last geometry at ${node.path}:`, e);
        }
        const instanced = drawable as THREE.InstancedMesh;
        if (instanced.isInstancedMesh && instanced.count === node.instances.length) {
          const matrix = new THREE.Matrix4();
          node.instances.forEach((instance, i) => instanced.setMatrixAt(i, matrix.fromArray(instance)));
          instanced.instanceMatrix.needsUpdate = true;
        }
      }
    }
    await updateNodes(node.children, byPath, time, isStale);
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
      const group = await buildScene(manifest, fetchers, fallbackColors);
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
      this.status = "error";
      this.error = typeof e === "string" ? e : String(e);
      return null;
    }
  },

  // Steps the stage time (USD time codes) and updates the integrated
  // scene in place: one manifest fetch, then per-animated-node geometry
  // fetches. One step runs at a time; rapid requests coalesce to the
  // latest queued time. Loads still supersede active work via loadGeneration.
  async setStageTime(time: number): Promise<void> {
    this.time = time;
    this.onTimeChange?.(time);
    if (sceneLoading || timeStepInFlight) {
      queuedTime = time;
      return;
    }
    const generation = ++loadGeneration;
    const group = currentGroup;
    if (!group) return;
    timeStepInFlight = true;
    try {
      const manifest = await invoke<RenderNode[]>("get_scene_manifest", { time });
      if (generation !== loadGeneration || currentGroup !== group) return;
      await updateNodes(
        manifest,
        currentPaths,
        time,
        () => generation !== loadGeneration || currentGroup !== group,
      );
    } catch (e) {
      if (generation === loadGeneration) {
        // Keep the last good scene on screen; surface why.
        this.error = typeof e === "string" ? e : String(e);
      }
    } finally {
      timeStepInFlight = false;
      if (!sceneLoading) {
        const pendingTime = queuedTime;
        queuedTime = null;
        if (pendingTime !== null) await this.setStageTime(pendingTime);
      }
    }
  },

  // Animated content refresh: a full re-load at the current time.
  refreshAnimated(): Promise<THREE.Group | null> {
    return this.loadRenderScene();
  },
});
