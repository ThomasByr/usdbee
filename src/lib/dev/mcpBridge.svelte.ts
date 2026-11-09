// Dev-only MCP bridge: the running app dials OUT to the local MCP server's
// WebSocket host and executes the commands a coding agent sends. Every
// command calls an existing seam (load path, gizmo commit authoring,
// playback driver, frameDiag, export render) — the bridge owns no behavior
// of its own. A production bundle must carry none of it: startMcpBridge
// returns null outside a dev build, and the caller imports it dynamically
// behind the same gate.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import * as THREE from "three";
import { stageState } from "$lib/stage/stageState.svelte";
import { renderState } from "$lib/render/renderState.svelte";
import { tabsState } from "$lib/state/tabsState.svelte";
import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
import { authorLocalTransform } from "$lib/render/gizmoCommit.svelte";
import * as frameDiag from "$lib/perf/frameDiag";
import { renderWithShadowUpdate } from "$lib/three/shadowMapUpdate";
import type { PrimDetails, RenderNode } from "$lib/stage/types";

export const MCP_BRIDGE_PORT = 9330;
const RECONNECT_MAX_MS = 30000;
const NODE_CAP = 200;
const MATCH_CAP = 50;
const INSPECT_DEPTH = 3;

// The viewport slice the bridge drives; RendererKit satisfies it.
export interface BridgeViewer {
  isPlayingAnim: boolean;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  activeCameraIndex: number;
  usdCameras: THREE.Camera[];
}

export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, RECONNECT_MAX_MS);
}

function bridgeUrl(): string {
  const port = Number(import.meta.env.VITE_MCP_PORT) || MCP_BRIDGE_PORT;
  return `ws://127.0.0.1:${port}`;
}

function numberArg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function vec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out = value.map(numberArg);
  return out.every((v) => v !== null) ? (out as [number, number, number]) : null;
}

// The loaded scene's prim records: the same manifest the render pipeline
// builds from.
function fetchManifest(): Promise<RenderNode[]> {
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
  viewer: BridgeViewer,
  cmd: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (cmd) {
    case "status":
      return {
        stage_loaded: stageState.activeStageId !== 0,
        stage_id: stageState.activeStageId,
        playing: viewer.isPlayingAnim,
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
      await tabsState.closeConfirmed(stageId);
      const failure = loadOrchestrator.modalError;
      if (failure !== null) throw new Error(failure);
      // It also returns silently when the tab list no longer holds the stage,
      // so the closed stage has to be confirmed through the active id.
      if (stageState.activeStageId === stageId) throw new Error(`stage ${stageId} is still open`);
      return { ok: true };
    }
    case "inspect_scene":
      return inspectScene(args);
    case "search_objects":
      return searchObjects(args);
    case "transform_object":
      return transformObject(args);
    case "play":
      viewer.isPlayingAnim = true;
      return { ok: true };
    case "pause":
      viewer.isPlayingAnim = false;
      return { ok: true };
    case "set_time": {
      const time = numberArg(args.time);
      if (time === null) throw new Error("set_time needs a time");
      await renderState.setStageTime(time);
      return { ok: true };
    }
    case "get_performance":
      return frameDiag.snapshot();
    case "reset_performance":
      frameDiag.reset();
      return { ok: true };
    case "screenshot":
      return screenshot(viewer);
    case "close_app":
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

// Ids being answered: a duplicate frame for an id already in flight is
// dropped rather than run twice.
const inFlight = new Set<number>();

// One wire frame in, one envelope out (null for an unusable frame).
export async function handleMessage(viewer: BridgeViewer, raw: string): Promise<string | null> {
  let request: { id?: unknown; cmd?: unknown; args?: unknown };
  try {
    request = JSON.parse(raw);
  } catch {
    return null;
  }
  const id = numberArg(request?.id);
  if (id === null || inFlight.has(id)) return null;
  inFlight.add(id);
  try {
    const args =
      request.args && typeof request.args === "object" ? (request.args as Record<string, unknown>) : {};
    const result = await dispatchCommand(viewer, String(request.cmd ?? ""), args);
    return JSON.stringify({ id, ok: true, result });
  } catch (e) {
    return JSON.stringify({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    inFlight.delete(id);
  }
}

// Connect the app to the MCP server's host. Null (and no socket) outside a
// dev build, which is what keeps the release bundle free of this module.
export function startMcpBridge(viewer: BridgeViewer): (() => void) | null {
  if (!import.meta.env.DEV) return null;
  const url = bridgeUrl();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const connect = () => {
    const fresh = new WebSocket(url);
    socket = fresh;
    fresh.onopen = () => {
      attempt = 0;
      console.info("usdbee: dev MCP bridge connected on", url);
    };
    fresh.onmessage = (event) => {
      void handleMessage(viewer, String(event.data)).then((reply) => {
        if (reply !== null && socket?.readyState === WebSocket.OPEN) socket.send(reply);
      });
    };
    // A refused connection closes too, so one backoff path serves both.
    fresh.onclose = () => {
      if (stopped) return;
      timer = setTimeout(connect, reconnectDelay(attempt++));
    };
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    socket?.close();
    socket = null;
  };
}
