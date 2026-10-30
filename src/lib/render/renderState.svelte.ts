// Rust render-backend state (Phase 2, Task 4): loads the render manifest
// from the open stage and builds the Three.js scene from it. House pattern
// from stageState.svelte.ts: a generation counter discards responses from
// superseded loads (the Phase 1 stale-response lesson).
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import type { MaterialInfo, RenderNode } from "../stage/types";
import { buildScene, disposeScene, type SceneFetchers } from "./sceneBuilder";

let loadGeneration = 0;

// shortcut: textures load through a single shared TextureLoader with no
// per-load error handling — a texture that fails to fetch simply never
// reaches the material (convertMaterial already fails soft)
const textureLoader = new THREE.TextureLoader();

const fetchers: SceneFetchers = {
  getGeometry: (path: string) => invoke<ArrayBuffer>("get_geometry_data", { path, time: renderState.time }),
  getMaterial: (path: string) => invoke<MaterialInfo>("get_material_data", { path }).catch(() => null),
  loadTexture: (filePath: string) => {
    try {
      return textureLoader.load(convertFileSrc(filePath));
    } catch {
      return null;
    }
  },
};

export const renderState = $state({
  // Queried stage time; null = default time.
  time: null as number | null,
  status: "idle" as "idle" | "loading" | "ready" | "error",
  error: null as string | null,

  // Builds the render scene from the manifest of the currently open stage.
  // Returns null when the response was superseded (or the fetch failed) —
  // a superseded scene is disposed, never handed to the viewport.
  async loadRenderScene(): Promise<THREE.Group | null> {
    const generation = ++loadGeneration;
    this.status = "loading";
    this.error = null;
    try {
      const manifest = await invoke<RenderNode[]>("get_scene_manifest", {
        time: this.time,
      });
      if (generation !== loadGeneration) return null;
      const group = await buildScene(manifest, fetchers);
      if (generation !== loadGeneration) {
        disposeScene(group);
        return null;
      }
      this.status = "ready";
      return group;
    } catch (e) {
      if (generation !== loadGeneration) return null;
      this.status = "error";
      this.error = typeof e === "string" ? e : String(e);
      return null;
    }
  },

  async setStageTime(time: number): Promise<THREE.Group | null> {
    this.time = time;
    return this.loadRenderScene();
  },

  // Animated content refresh (full re-load of the manifest at the current
  // time — Task 6 refines this into a time-sampled update).
  refreshAnimated(): Promise<THREE.Group | null> {
    return this.loadRenderScene();
  },
});
