// The command set the palette and the dev MCP bridge share. Every command
// calls an existing seam (load path, gizmo commit authoring, playback driver,
// frameDiag, export render, camera framing); this module owns no behavior of
// its own and imports no dev code, so a release bundle can carry it.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import * as THREE from "three";
import { stageState } from "$lib/stage/stageState.svelte";
import { renderState } from "$lib/render/renderState.svelte";
import { tabsState } from "$lib/state/tabsState.svelte";
import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
import { authorLocalTransform } from "$lib/render/gizmoCommit.svelte";
import { bindSelectionBox } from "$lib/render/sceneIntegration";
import * as frameDiag from "$lib/perf/frameDiag";
import { renderWithShadowUpdate } from "$lib/three/shadowMapUpdate";
import { upAxisRotation } from "$lib/stage/upAxis";
import type { CameraInfo, PrimDetails, RenderNode } from "$lib/stage/types";

const NODE_CAP = 200;
const MATCH_CAP = 50;
const INSPECT_DEPTH = 3;

// The viewport slice the commands drive; RendererKit satisfies it.
export interface BridgeViewer {
  isPlayingAnim: boolean;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  loadedGroup: THREE.Group | null;
  selectedNode: THREE.Object3D | null;
  selectionHelper: THREE.Box3Helper | null;
  camera: THREE.Camera;
  controls: { target: THREE.Vector3; update: () => void };
  fov: number;
  pinnedCamera: { position: THREE.Vector3; target: THREE.Vector3 } | null;
  activeCameraIndex: number;
  usdCameras: THREE.Camera[];
  // F5: the stage's camera prims, as last fetched, plus the re-centring the
  // loaded group got — a prim transform needs both to become a viewer pose.
  stageCameras: CameraInfo[];
  sceneCenter: THREE.Vector3;
  sceneSize: number;
}

// A palette click runs without a mounted viewport or an open stage, where the
// dev bridge always had both: these sets turn that into a readable error.
const NEEDS_VIEWER = new Set([
  "play",
  "pause",
  "screenshot",
  "select_node",
  "set_camera",
  "look_through_camera",
  "box_report",
]);
const NEEDS_STAGE = new Set(["inspect_scene", "search_objects", "transform_object"]);

export function numberArg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function vec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out = value.map(numberArg);
  return out.every((v) => v !== null) ? (out as [number, number, number]) : null;
}

// The loaded scene's prim records: the same manifest the render pipeline
// builds from.
export function fetchManifest(): Promise<RenderNode[]> {
  if (!stageState.activeStageId) return Promise.reject(new Error("no stage loaded"));
  return invoke<RenderNode[]>("get_scene_manifest", {
    stageId: stageState.activeStageId,
    time: renderState.time ?? 0,
  });
}

function forEachNode(nodes: RenderNode[], visit: (node: RenderNode, depth: number) => void, depth = 0): void {
  for (const node of nodes) {
    visit(node, depth);
    forEachNode(node.children, visit, depth + 1);
  }
}

async function inspectScene(args: Record<string, unknown>) {
  const manifest = await fetchManifest();
  let primCount = 0;
  let geometryCount = 0;
  let animatedCount = 0;
  forEachNode(manifest, (node) => {
    primCount++;
    if (node.has_geometry) geometryCount++;
    if (node.animated) animatedCount++;
  });

  const maxDepth = numberArg(args.max_depth) ?? INSPECT_DEPTH;
  const nodes: {
    path: string;
    type: string;
    has_geometry: boolean;
    geometry_animated: boolean;
    children_count: number;
  }[] = [];
  forEachNode(manifest, (node, depth) => {
    if (depth > maxDepth || nodes.length >= NODE_CAP) return;
    nodes.push({
      path: node.path,
      type: node.type_name,
      has_geometry: node.has_geometry,
      geometry_animated: node.geometry_animated,
      children_count: node.children.length,
    });
  });
  return { prim_count: primCount, geometry_count: geometryCount, animated_count: animatedCount, nodes };
}

async function searchObjects(args: Record<string, unknown>) {
  const needle = String(args.query ?? "").toLowerCase();
  const limit = numberArg(args.limit) ?? MATCH_CAP;
  const matches: { path: string; type: string }[] = [];
  forEachNode(await fetchManifest(), (node) => {
    if (matches.length >= limit) return;
    if (node.path.toLowerCase().includes(needle) || node.name.toLowerCase().includes(needle)) {
      matches.push({ path: node.path, type: node.type_name });
    }
  });
  return { matches };
}

// One gizmo mode per contract channel; each channel authors separately
// because the op order has to be re-read after every write.
const TRANSFORM_CHANNELS = [
  { arg: "position", mode: "translate" },
  { arg: "rotation", mode: "rotate" },
  { arg: "scale", mode: "scale" },
] as const;

async function transformObject(args: Record<string, unknown>) {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) throw new Error("transform_object needs a path");
  const requested = TRANSFORM_CHANNELS.flatMap((channel) => {
    const values = vec3(args[channel.arg]);
    return values ? [{ mode: channel.mode, values }] : [];
  });
  if (requested.length === 0) throw new Error("transform_object needs position, rotation or scale");

  for (const { mode, values } of requested) {
    const details: PrimDetails | null = await stageState.fetchPrimDetails(path);
    if (!details) throw new Error(`no prim at ${path}`);
    if (!details.local_transform) throw new Error(`transform stack of ${path} is not editable`);
    // Untouched channels keep the prim's current pose: the target is the
    // composed local matrix with only this channel replaced.
    const local = new THREE.Matrix4().fromArray(details.local_transform);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    local.decompose(position, rotation, scale);
    if (mode === "translate") position.fromArray(values);
    else if (mode === "scale") scale.fromArray(values);
    else
      rotation.setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(values[0]),
          THREE.MathUtils.degToRad(values[1]),
          THREE.MathUtils.degToRad(values[2]),
          "XYZ",
        ),
      );
    local.compose(position, rotation, scale);
    const error = await authorLocalTransform(details, mode, local.toArray() as number[]);
    if (error) throw new Error(error);
  }
  await stageState.refreshAfterEdit();
  return { ok: true };
}

// Reapplied after every scene rebuild, so a pinned view outlives a reload.
function pinView(viewer: BridgeViewer) {
  viewer.controls.update();
  viewer.pinnedCamera = {
    position: viewer.camera.position.clone(),
    target: viewer.controls.target.clone(),
  };
}

function applyFov(viewer: BridgeViewer, fov: number) {
  viewer.fov = fov;
  // The Viewport effect is the other fov consumer; writing both keeps them
  // consistent where that effect is not mounted.
  const camera = viewer.camera as THREE.PerspectiveCamera;
  camera.fov = fov;
  camera.updateProjectionMatrix();
}

function setCamera(viewer: BridgeViewer, args: Record<string, unknown>) {
  const position = vec3(args.position);
  const target = vec3(args.target);
  const fov = numberArg(args.fov);
  if (!position && !target && fov === null) throw new Error("set_camera needs position, target or fov");

  if (position || target) {
    if (position) viewer.camera.position.fromArray(position);
    if (target) viewer.controls.target.fromArray(target);
    viewer.controls.update();
    // Pin the whole view, not the given channels: a rebuild frames the scene
    // from scratch, so an unpinned channel would come back reframed.
    pinView(viewer);
  }
  if (fov !== null) applyFov(viewer, fov);
  return { ok: true, pinned: viewer.pinnedCamera !== null };
}

// F5: frame the viewport through a stage camera. The pose math mirrors
// lightPose (sceneIntegration): the prim transform is row-major in the USD
// row-vector convention, so the translation is the last row and the negated
// third row the look axis, and the stage group was stood upright and
// re-centred before either applies.
function lookThroughCamera(viewer: BridgeViewer, args: Record<string, unknown>) {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) {
    return {
      cameras: viewer.stageCameras.map((camera) => ({
        path: camera.path,
        name: camera.name,
        projection: camera.projection,
      })),
    };
  }
  const info = viewer.stageCameras.find((camera) => camera.path === path);
  if (!info) {
    // An empty list means the cameras have not arrived yet (or the stage has
    // none); reporting the path as missing would read as an unknown prim.
    if (viewer.stageCameras.length === 0) throw new Error("no stage cameras loaded yet");
    throw new Error(`no stage camera at ${path}`);
  }
  const m = info.world_transform;
  if (!m || m.length !== 16) throw new Error(`camera ${path} has no evaluated transform`);

  const axis = new THREE.Vector3(1, 0, 0);
  const spin = upAxisRotation(stageState.stageInfo?.up_axis ?? "Y");
  const position = new THREE.Vector3(m[12] ?? 0, m[13] ?? 0, m[14] ?? 0)
    .applyAxisAngle(axis, spin)
    .sub(viewer.sceneCenter);
  const forward = new THREE.Vector3(-(m[8] ?? 0), -(m[9] ?? 0), -(m[10] ?? 0)).applyAxisAngle(axis, spin);
  if (forward.lengthSq() < 1e-12) throw new Error(`camera ${path} has no look direction`);
  forward.normalize();

  // Keep the framing distance the viewer had, so the look-through lands with
  // comparable context instead of on the camera prim itself.
  const distance = viewer.controls.target.distanceTo(viewer.camera.position) || viewer.sceneSize;
  viewer.camera.position.copy(position);
  viewer.controls.target.copy(position).addScaledVector(forward, distance);
  pinView(viewer);

  // An orthographic camera's lens is not a vertical fov; the viewer's stays.
  const lens = info.vertical_aperture > 0 && info.focal_length > 0;
  if (info.projection !== "perspective" || !lens) {
    return {
      ok: true,
      path,
      name: info.name,
      projection: info.projection,
      fov: viewer.fov,
      framed_only: true,
    };
  }
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(info.vertical_aperture / (2 * info.focal_length)));
  applyFov(viewer, fov);
  return { ok: true, path, name: info.name, projection: info.projection, fov };
}

// Cached vs precise AABB of the selected subtree, plus the meshes that
// contribute the most extent. A box that reaches past the visible geometry
// is either a hidden prim or a stale per-geometry bound; the rows say which.
function boxReport(viewer: BridgeViewer) {
  const node = viewer.selectedNode;
  if (!node) throw new Error("nothing selected");
  node.updateWorldMatrix(true, true);
  const cached = new THREE.Box3().setFromObject(node, false);
  const precise = new THREE.Box3().setFromObject(node, true);
  const rows: Record<string, unknown>[] = [];
  const visibleBox = new THREE.Box3();
  // Which mesh sets each face, and whether that mesh is actually drawn: a face
  // held by a hidden prim is the box reaching where nothing is rendered.
  const markers: Record<string, { value: number; name: string; visible: boolean }> = {};
  const mark = (key: string, value: number, name: string, visible: boolean, keep: "min" | "max") => {
    const prev = markers[key];
    if (!prev || (keep === "min" ? value < prev.value : value > prev.value)) {
      markers[key] = { value, name, visible };
    }
  };
  node.traverse((obj) => {
    const geometry = (obj as THREE.Mesh).geometry;
    if (!geometry) return;
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const box = geometry.boundingBox!.clone().applyMatrix4(obj.matrixWorld);
    const size = box.getSize(new THREE.Vector3());
    let visible = obj.visible;
    for (let p = obj.parent; p && p !== node.parent; p = p.parent) visible &&= p.visible;
    if (visible) visibleBox.union(box);
    const short = obj.name.split("/").slice(-1)[0];
    for (const k of ["min", "max"] as const) {
      for (const a of ["x", "y", "z"] as const) {
        mark(`${k}.${a}`, box[k][a], short, visible, k);
      }
    }
    rows.push({
      name: obj.name,
      visible,
      diagonal: Number(size.length().toFixed(3)),
      min: box.min.toArray().map((v) => Number(v.toFixed(2))),
      max: box.max.toArray().map((v) => Number(v.toFixed(2))),
    });
  });
  rows.sort((a, b) => (b.diagonal as number) - (a.diagonal as number));
  const round = (b: THREE.Box3) => ({
    min: b.min.toArray().map((v) => Number(v.toFixed(2))),
    max: b.max.toArray().map((v) => Number(v.toFixed(2))),
  });
  // What the render loop pays per frame for this selection, measured in the
  // app rather than estimated.
  const scratch = new THREE.Box3();
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) scratch.setFromObject(node, false);
  const refreshMs = (performance.now() - t0) / 200;
  return {
    cached: round(cached),
    precise: round(precise),
    visible: round(visibleBox),
    faces: markers,
    meshes: rows.length,
    refreshMs: Number(refreshMs.toFixed(4)),
    top: rows.slice(0, 10),
  };
}

function screenshot(viewer: BridgeViewer) {
  if (!viewer.renderer) throw new Error("viewport not ready");
  const camera = viewer.activeCameraIndex >= 0 ? viewer.usdCameras[viewer.activeCameraIndex] : viewer.camera;
  // Same-task render then read, the export path's pinned contract (the
  // drawing buffer is not preserved between tasks).
  renderWithShadowUpdate(viewer.renderer, viewer.scene, camera ?? viewer.camera);
  const url = viewer.renderer.domElement.toDataURL("image/png");
  return { png_base64: url.replace(/^data:image\/png;base64,/, "") };
}

export async function dispatchCommand(
  viewer: BridgeViewer | null,
  cmd: string,
  args: Record<string, unknown>,
  opts: { guarded?: boolean } = {},
): Promise<unknown> {
  if (viewer === null && NEEDS_VIEWER.has(cmd)) throw new Error("no viewport available");
  if (!stageState.activeStageId && NEEDS_STAGE.has(cmd)) throw new Error("no stage loaded");
  // The guard above rejected every viewer command without one.
  const view = viewer as BridgeViewer;
  const guarded = opts.guarded === true;

  switch (cmd) {
    case "status":
      return {
        stage_loaded: stageState.activeStageId !== 0,
        stage_id: stageState.activeStageId,
        playing: viewer?.isPlayingAnim ?? false,
        time: renderState.time,
      };
    case "load_scene": {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) throw new Error("load_scene needs a path");
      // The tab open path swallows its failure into the shared error modal, so
      // a modal set by this attempt is the only observable load failure. It is
      // cleared first because a repeat of the same failure leaves it unchanged.
      loadOrchestrator.modalError = null;
      await tabsState.openTab(path);
      const failure = loadOrchestrator.modalError;
      if (failure !== null) throw new Error(failure);
      if (stageState.status === "error") throw new Error(stageState.error ?? "load failed");
      return { ok: true };
    }
    case "unload_scene": {
      const stageId = stageState.activeStageId;
      if (!stageId) return { ok: true };
      // Same modal contract as load_scene: closeConfirmed reports a failed
      // close only through the modal.
      loadOrchestrator.modalError = null;
      if (guarded) {
        // The tab close is the dirty-guard path: a stage with unsaved edits
        // asks before close_stage drops them.
        await tabsState.closeTab(stageId);
      } else {
        await tabsState.closeConfirmed(stageId);
      }
      const failure = loadOrchestrator.modalError;
      if (failure !== null) throw new Error(failure);
      // It also returns silently when the tab list no longer holds the stage,
      // so the closed stage has to be confirmed through the active id. The
      // guarded close may still be waiting on its modal, so only the direct
      // one can be confirmed here.
      if (!guarded && stageState.activeStageId === stageId) throw new Error(`stage ${stageId} is still open`);
      return { ok: true };
    }
    case "inspect_scene":
      return inspectScene(args);
    case "search_objects":
      return searchObjects(args);
    case "select_node": {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) {
        // Empty path = clear, so a measurement can A/B a selection.
        bindSelectionBox(view, null);
        stageState.deselectPrim();
        return { ok: true, path: null };
      }
      const node = view.loadedGroup?.getObjectByName(path) ?? null;
      if (!node) throw new Error(`no render node for ${path}`);
      // Same path as a hierarchy click: orange box, selected node, details.
      bindSelectionBox(view, node);
      await stageState.selectPrim(path);
      return { ok: true, path };
    }
    case "transform_object":
      return transformObject(args);
    case "play":
      view.isPlayingAnim = true;
      return { ok: true };
    case "pause":
      view.isPlayingAnim = false;
      return { ok: true };
    case "set_time": {
      const time = numberArg(args.time);
      if (time === null) throw new Error("set_time needs a time");
      await renderState.setStageTime(time);
      return { ok: true };
    }
    case "get_performance":
      return frameDiag.snapshot();
    case "box_report":
      return boxReport(view);
    case "reset_performance":
      frameDiag.reset();
      return { ok: true };
    case "set_camera":
      return setCamera(view, args);
    case "look_through_camera":
      return lookThroughCamera(view, args);
    case "screenshot":
      return screenshot(view);
    case "close_app":
      if (guarded) {
        // Routed through the window close request so the app's own unsaved
        // work guard runs first.
        await getCurrentWindow().close();
        return { ok: true };
      }
      // Answer before the window goes away: nothing can be sent after it.
      setTimeout(() => {
        void (async () => {
          await saveWindowState(StateFlags.ALL).catch(() => {});
          await getCurrentWindow().destroy();
        })();
      }, 0);
      return { ok: true };
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}
