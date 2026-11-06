// sceneIntegration tests: the playback driver gate — autoplay must not
// advance the playhead while a scene load is in flight, or the pose the
// scene centers on would depend on how long the load took.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import {
  installPlaybackDriver,
  integrateScene,
  loadRustScene,
  resetLoadedScene,
  syncGraphicsSettings,
  syncLightRig,
} from "./sceneIntegration";
import { loadCachedTexture } from "./textureCache";
import { renderState } from "./renderState.svelte";
import { invalidatePoseBuffer, poseCoverage, takePose } from "./posePrefetch";
import * as frameDiag from "../perf/frameDiag";
import { loadOrchestrator } from "../state/loadOrchestrator.svelte";
import { stageState } from "../stage/stageState.svelte";
import { viewerSettings } from "../state/viewerSettings.svelte";
import { consumeShadowUpdate } from "../three/shadowMapUpdate";
import type { RendererKit } from "../three/RendererKit.svelte";

const mockedInvoke = vi.mocked(invoke);

function viewer(): RendererKit {
  return { animationProgress: 0 } as unknown as RendererKit;
}

// Minimal kit that integrateScene can drive: camera/controls framing plus
// the helpers it recreates.
function integrateKit(): RendererKit {
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    controls: {
      target: new THREE.Vector3(),
      reset: vi.fn(),
      update: vi.fn(),
      saveState: vi.fn(),
    },
    gridHelper: null,
    boxHelper: null,
    dirLight: null,
    showGrid: false,
    showBoundingBox: false,
    selectedNode: null,
    animationProgress: 0,
  } as unknown as RendererKit;
}

function namedGroup(path: string): { group: THREE.Group; node: THREE.Object3D } {
  const group = new THREE.Group();
  const node = new THREE.Object3D();
  node.name = path;
  group.add(node);
  return { group, node };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  renderState.time = null;
  renderState.status = "idle";
  renderState.timeCodes = [];
  stageState.selectedPath = null;
  consumeShadowUpdate();
  stageState.stageInfo = {
    start_time_code: 0,
    end_time_code: 24,
    time_codes_per_second: 24,
  } as any;
});

describe("installPlaybackDriver", () => {
  it("does not advance time while the render state is loading", () => {
    renderState.time = 0;
    renderState.status = "loading";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0.5);

    expect(renderState.time).toBe(0);
    expect(v.animationProgress).toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("advances normally once the status is ready again", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0.05);

    expect(renderState.time).toBeCloseTo(1.2, 10);
    expect(v.animationProgress).toBeCloseTo(1.2, 10);
  });

  it("caps a single huge delta (main-thread stall) at 0.1 s of advance", () => {
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 240,
      time_codes_per_second: 24,
    } as any;
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    // 5 s stall at 24 tcps would be 120 codes unclamped.
    v.onAdvanceTime!(5);

    expect(renderState.time).toBeLessThanOrEqual(0.1 * 24);
  });

  it("still accumulates repeated small deltas normally", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeCloseTo((10 / 60) * 24, 5);
  });

  it("advances past the first authored code under exact small deltas (stall regression)", () => {
    // Regression: advancing from the ALREADY-SNAPPED time re-snaps to the
    // same authored code every frame — 30 tcps at 60 Hz advances 0.5
    // codes, then snapping eats the sub-code delta, so playback stalls.
    // Real rAF deltas are irregular, which is why this only failed on
    // exact-delta displays.
    renderState.timeCodes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 8,
      time_codes_per_second: 30,
    } as any;
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeGreaterThan(1);
  });

  it("records one pose sample per distinct presented code", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    const diag = frameDiag.snapshot();
    // The first tick presents a code, so nine gaps follow it.
    expect(diag.poseN).toBe(9);
    // No authored codes on this fixture: gaps are measurable, drops are not.
    expect(diag.droppedCodes).toBe(0);
    expect(diag.tcps).toBe(24);
  });

  it("counts the authored codes the playhead skipped", () => {
    renderState.timeCodes = Array.from({ length: 25 }, (_, i) => i);
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();

    v.onAdvanceTime!(0); // presents code 0
    v.onAdvanceTime!(2 / 24); // 2 codes later: index 1 never showed

    expect(frameDiag.snapshot().droppedCodes).toBe(1);
  });

  it("does not count a forward scrub as dropped codes", () => {
    renderState.timeCodes = Array.from({ length: 25 }, (_, i) => i);
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();

    v.onAdvanceTime!(0); // presents code 0
    void renderState.setStageTime(10); // simulated scrub
    v.onAdvanceTime!(0); // presents code 10

    expect(frameDiag.snapshot().droppedCodes).toBe(0);
  });

  it("continues from an externally scrubbed time, not a stale playhead", () => {
    // The driver keeps its own continuous playhead; any external write of
    // renderState.time (scrub slider, new load) must be adopted on the
    // very next frame so the two never diverge.
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(1 / 60); // the driver now holds a stale playhead
    void renderState.setStageTime(10); // simulated scrub
    v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeGreaterThan(10);
  });
});

// One pose frame with no geometry slots (`[]` manifest, no paths), the
// smallest legal frame for the batch decode.
function emptyPoseFrame(): ArrayBuffer {
  const manifest = new TextEncoder().encode("[]");
  const buffer = new ArrayBuffer(24);
  const view = new DataView(buffer);
  view.setUint32(0, manifest.length, true);
  new Uint8Array(buffer).set(manifest, 4);
  view.setUint32(8, 0, true); // path count
  view.setUint32(12, 0x55534247, true); // geometry batch magic
  view.setUint32(16, 1, true); // batch version
  view.setUint32(20, 0, true); // slot count
  return buffer;
}

function poseBatch(count: number): ArrayBuffer {
  const frame = new Uint8Array(emptyPoseFrame());
  const buffer = new ArrayBuffer(4 + count * frame.byteLength);
  new DataView(buffer).setUint32(0, count, true);
  for (let i = 0; i < count; i++) {
    new Uint8Array(buffer, 4 + i * frame.byteLength, frame.byteLength).set(frame);
  }
  return buffer;
}

describe("installPlaybackDriver pose prefetch", () => {
  const codes = Array.from({ length: 60 }, (_, i) => i);

  function batchCalls() {
    return mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose_batch");
  }

  // The batch fill lands in microtasks: a macrotask flushes all of them.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    invalidatePoseBuffer();
    renderState.timeCodes = codes;
    renderState.time = 0;
    renderState.status = "ready";
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 60,
      time_codes_per_second: 24,
    } as any;
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_animated_pose_batch") return poseBatch(args.times.length);
      throw new Error(`unexpected command: ${cmd}`);
    });
  });

  it("issues one batch for the look-ahead instead of one pose per frame", async () => {
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(1 / 24); // presents code 1
    await flush(); // the batch lands and fills the buffer
    for (let i = 0; i < 5; i++) v.onAdvanceTime!(1 / 24);

    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(2, 2 + 12),
    });
  });

  it("refills only once the window drops below half", async () => {
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(1 / 24); // presents code 1: cold look-ahead, one batch
    await flush(); // ...which lands and fills 2..13
    expect(batchCalls()).toHaveLength(1);

    // The playhead consumes the window (a loaded scene takes these); at half
    // full the look-ahead is still enough.
    for (let code = 2; code <= 7; code++) {
      takePose(code);
      v.onAdvanceTime!(1 / 24);
    }
    expect(poseCoverage(7)).toBe(6);
    expect(batchCalls()).toHaveLength(1);

    takePose(8);
    v.onAdvanceTime!(1 / 24); // coverage 5: exactly one refill

    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(9, 9 + 12),
    });
  });

  it("drops the look-ahead when the playhead is written externally", async () => {
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(1 / 24); // presents code 1
    await flush(); // batch fills 2..13
    expect(poseCoverage(1)).toBe(12);
    expect(batchCalls()).toHaveLength(1);

    renderState.time = 30; // simulated scrub
    v.onAdvanceTime!(0);

    // The pre-scrub window is gone, not merely behind the new playhead: the
    // resync branch drops it before the next batch is even claimed.
    expect(poseCoverage(1)).toBe(0);
    expect(takePose(2)).toBeNull();
    expect(poseCoverage(30)).toBe(0);
    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(31, 31 + 12),
    });
  });

  it("drops the look-ahead on a backwards scrub too", async () => {
    // The resync branch must not care which way the external write went: a
    // rewind leaves the forward window just as unusable as a forward scrub.
    const v = viewer();
    installPlaybackDriver(v);
    renderState.time = 30;
    v.onAdvanceTime!(0); // resyncs to 30 and claims 31..42
    await flush();
    expect(poseCoverage(30)).toBe(12);

    renderState.time = 5; // simulated rewind
    v.onAdvanceTime!(0);

    expect(poseCoverage(30)).toBe(0);
    expect(takePose(31)).toBeNull();
    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(6, 6 + 12),
    });
  });

  it("clears the look-ahead at the loop wrap so prefetch keeps claiming", async () => {
    // Wrapping past the end drops the playhead back to the start while
    // end-of-loop poses are still buffered. They can never be consumed from
    // there but still count as coverage, so with K/2 of them left no batch is
    // ever claimed again and every step pays the single-pose invoke.
    const loop = Array.from({ length: 40 }, (_, i) => i);
    renderState.timeCodes = loop;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 39,
      time_codes_per_second: 60,
    } as any;
    renderState.time = 33;
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0); // presents 33 and claims the clamped tail 34..39
    await flush();
    expect(poseCoverage(33)).toBe(6);

    v.onAdvanceTime!(0.1); // 6 codes: presents 39, skipping the buffered tail
    v.onAdvanceTime!(0.1); // wraps to code 6
    expect(renderState.time).toBe(6);

    expect(poseCoverage(6)).toBe(0);
    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: loop.slice(7, 7 + 12),
    });
  });
});

describe("resetLoadedScene", () => {
  it("drops the scene and the texture memo so a closed stage holds no images", () => {
    // The memo is cleared again at the next load, but a stage closed with
    // no reload after it would keep the last scene's decoded images.
    const load = vi.fn(() => new THREE.Texture());
    loadCachedTexture("/Textures/texgen_7.png", () => {}, load);

    const group = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(group);
    const kit = { loadedGroup: group, scene } as unknown as RendererKit;

    resetLoadedScene(kit);

    expect(scene.children).not.toContain(group);
    loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops the selection visuals with the scene", () => {
    // The frame loop only redraws the box while selectedNode is set: a
    // close would freeze the last-drawn box over the empty view.
    const group = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(group);
    const helper = { visible: true } as unknown as THREE.Box3Helper;
    const kit = {
      loadedGroup: group,
      scene,
      selectedNode: group,
      selectionHelper: helper,
    } as unknown as RendererKit;

    resetLoadedScene(kit);

    expect(kit.selectedNode).toBeNull();
    expect(helper.visible).toBe(false);
  });
});

describe("integrateScene", () => {
  it("re-binds the selection to the rebuilt subtree", () => {
    // A rebuild disposes the old group: without the re-bind the selection
    // box and the gizmo keep tracking a detached node until the user
    // clicks the prim's tree row again.
    const kit = integrateKit();
    const old = namedGroup("/Scene/Shape");
    kit.selectedNode = old.node;
    stageState.selectedPath = "/Scene/Shape";

    const rebuilt = namedGroup("/Scene/Shape");
    integrateScene(kit, rebuilt.group);

    expect(kit.selectedNode).toBe(rebuilt.node);
  });

  it("clears the selection when the rebuilt subtree lost the selected path", () => {
    const kit = integrateKit();
    const old = namedGroup("/Scene/Gone");
    kit.selectedNode = old.node;
    stageState.selectedPath = "/Scene/Gone";

    const rebuilt = namedGroup("/Scene/Shape");
    integrateScene(kit, rebuilt.group);

    expect(kit.selectedNode).toBeNull();
  });

  it("requests a shadow redraw for the new geometry", () => {
    // Load, rebuild and stage switch all land here: the map holds the old
    // scene's casters until it is redrawn.
    const kit = integrateKit();
    consumeShadowUpdate();

    integrateScene(kit, namedGroup("/Scene/Shape").group);

    expect(consumeShadowUpdate()).toBe(true);
  });
});

describe("syncLightRig", () => {
  it("requests a shadow redraw when the light rig changes", () => {
    const kit = integrateKit();
    kit.renderer = { toneMappingExposure: 1 } as unknown as RendererKit["renderer"];
    kit.dirLight = new THREE.DirectionalLight();
    kit.sceneCenter = new THREE.Vector3();
    kit.sceneSize = 10;
    consumeShadowUpdate();

    syncLightRig(kit, 45, 45);

    expect(consumeShadowUpdate()).toBe(true);
  });
});

describe("syncGraphicsSettings shadow triggers", () => {
  // Only the two shadow branches matter here: the material walk needs no
  // scene, so the kit stays a plain object.
  function graphicsKit(): RendererKit {
    return {
      renderer: {
        shadowMap: { type: THREE.PCFSoftShadowMap, enabled: true, needsUpdate: false },
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1,
        setPixelRatio: vi.fn(),
        capabilities: { getMaxAnisotropy: () => 16 },
      },
      scene: null,
      dirLight: null,
      loadedGroup: null,
    } as unknown as RendererKit;
  }

  const settings = { size: viewerSettings.shadowMapSize, type: viewerSettings.shadowMapType };
  beforeEach(() => {
    settings.size = viewerSettings.shadowMapSize;
    settings.type = viewerSettings.shadowMapType;
    // syncGraphicsSettings reads the device pixel ratio it applies.
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => {
    viewerSettings.shadowMapSize = settings.size;
    viewerSettings.shadowMapType = settings.type;
    vi.unstubAllGlobals();
  });

  it("requests a redraw when the shadow map type changes", () => {
    // A new type recompiles the depth materials: without a request the map
    // keeps sampling the old one until some caster moves.
    const kit = graphicsKit();
    viewerSettings.shadowMapType = "VSM";
    consumeShadowUpdate();

    syncGraphicsSettings(kit);

    expect(kit.renderer.shadowMap.type).toBe(THREE.VSMShadowMap);
    expect(consumeShadowUpdate()).toBe(true);
  });

  it("requests a redraw when the shadow map size changes", () => {
    const kit = graphicsKit();
    kit.dirLight = {
      shadow: { mapSize: { width: 512, height: 512 }, map: null },
    } as unknown as THREE.DirectionalLight;
    viewerSettings.shadowMapSize = 4096;
    consumeShadowUpdate();

    syncGraphicsSettings(kit);

    expect(kit.dirLight!.shadow.mapSize.width).toBe(4096);
    expect(consumeShadowUpdate()).toBe(true);
  });

  it("leaves the map alone when neither shadow setting changed", () => {
    const kit = graphicsKit();
    kit.renderer.shadowMap.type = THREE.VSMShadowMap;
    viewerSettings.shadowMapType = "VSM";
    consumeShadowUpdate();

    syncGraphicsSettings(kit);

    expect(consumeShadowUpdate()).toBe(false);
  });
});

describe("loadRustScene progress", () => {
  it("holds the bar at the frontend half and forwards the build's own progress", async () => {
    // The Rust stream ends at 45 %; everything the user waits on after it
    // (manifest, batches, assembly) is reported from here.
    const seen: { stage: string; percent: number }[] = [];
    const spy = vi
      .spyOn(renderState, "loadRenderScene")
      .mockImplementation(async (_start, _fallbacks, onProgress) => {
        seen.push({ ...loadOrchestrator.loadingProgress! });
        onProgress?.("Loading Geometry 32/70", 66);
        seen.push({ ...loadOrchestrator.loadingProgress! });
        return null;
      });

    const kit = { scene: new THREE.Scene(), animationProgress: 0 } as unknown as RendererKit;
    await loadRustScene(kit);

    expect(seen).toEqual([
      { stage: "Fetching Scene Manifest", percent: 50 },
      { stage: "Loading Geometry 32/70", percent: 66 },
    ]);
    expect(loadOrchestrator.loadingProgress).toBeNull();
    spy.mockRestore();
  });
});
