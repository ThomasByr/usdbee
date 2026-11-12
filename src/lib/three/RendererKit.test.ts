// Frame-loop pin: the selection box follows the selected node every frame,
// playback included (the orange box and the gizmo anchor both read it), and
// a pose's invalidated geometry bounding box costs at most one vertex walk.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: () => Promise.resolve() }),
}));

import * as THREE from "three";
import { RendererKit } from "./RendererKit.svelte";
import * as frameDiag from "$lib/perf/frameDiag";
import { viewerSettings } from "$lib/state/viewerSettings.svelte";
import { consumeShadowUpdate, requestShadowUpdate } from "./shadowMapUpdate";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function makeKit(playing: boolean) {
  const kit = new RendererKit();
  const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  kit.scene = new THREE.Scene();
  // `shadowDraws` records what the shadow pass saw at each render: three.js
  // clears needsUpdate itself once it has drawn the map.
  const shadowDraws: boolean[] = [];
  // three.js's own default: production code must turn it off, and the test
  // proves it did.
  const shadowMap = { autoUpdate: true, needsUpdate: false };
  kit.renderer = {
    render: vi.fn(() => {
      shadowDraws.push(shadowMap.needsUpdate);
      shadowMap.needsUpdate = false;
    }),
    shadowMap,
  } as unknown as THREE.WebGLRenderer;
  kit.controls = { update: vi.fn() } as unknown as RendererKit["controls"];
  kit.selectedNode = node;
  kit.selectionHelper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0xffffff));
  kit.isPlayingAnim = playing;
  return { kit, node, shadowDraws };
}

// The loop samples performance.now() itself, so the test drives that clock and
// passes an independent rAF timestamp, as the webview does.
let clockMs = 0;

function frame(kit: RendererKit, stepMs = 20, rafJitterMs = 0) {
  clockMs += stepMs;
  (kit as any).animate(clockMs + rafJitterMs);
}

function boxOf(kit: RendererKit): THREE.Box3 {
  return kit.selectionHelper!.box;
}

beforeEach(() => {
  // No recursive rAF ticks: the test drives every frame itself.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  clockMs = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clockMs);
});

afterEach(() => {
  viewerSettings.maxFps = 60;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fps limiter", () => {
  it("gates on the sampled clock, not on the raf timestamp", () => {
    // The webview's rAF argument is its own clock, so it can wobble around the
    // time the callback actually ran; the gate must not read it.
    const { kit, shadowDraws } = makeKit(true);
    for (let i = 0; i < 6; i++) frame(kit, 20, i % 2 === 0 ? -9 : 9);
    expect(shadowDraws).toHaveLength(6);
  });

  it("stamps the render ring with the clock the gate decided on", () => {
    // The gate no longer trusts the rAF stamp, so the render ring must not
    // either: renderFps is the number the whole round is judged by.
    const { kit } = makeKit(true);
    for (let i = 0; i < 4; i++) frame(kit, 20, i % 2 === 0 ? -9 : 9);
    const diag = frameDiag.snapshot();
    expect(diag.renderP50).toBeCloseTo(20, 5);
    expect(diag.renderFps).toBeCloseTo(50, 5);
  });

  it("renders every callback when uncapped", () => {
    const { kit, shadowDraws } = makeKit(true);
    viewerSettings.maxFps = 0;
    for (let i = 0; i < 5; i++) frame(kit, 3);
    expect(shadowDraws).toHaveLength(5);
  });

  it("renders the first frame on a clock that has not ticked yet", () => {
    // init calls animate() synchronously, so the first decision sees a clock
    // near zero and no anchor: pacing it against 0 drops the first frame.
    const { kit, shadowDraws } = makeKit(true);
    clockMs = 2;
    frame(kit, 0);
    expect(shadowDraws).toHaveLength(1);
  });

  it("drops the export frames' records while the loop is parked", () => {
    // An export poses once per frame through setStageTime, so its records
    // would fill the 10 s rings and pollute the snapshot the user reads next.
    const { kit, shadowDraws } = makeKit(true);
    kit.showExportModal = true;
    frameDiag.reset();
    frameDiag.onPoseApplied(40);
    frame(kit);
    frame(kit);

    expect(shadowDraws).toHaveLength(0);
    expect(frameDiag.snapshot().applyN).toBe(0);
  });

  it("leaves the skipped time to the next rendered frame", () => {
    const { kit, shadowDraws } = makeKit(true);
    const deltas: number[] = [];
    frameDiag.reset();
    kit.onAdvanceTime = (delta) => deltas.push(delta);
    frame(kit); // starts the playback clock
    frame(kit);
    frame(kit, 8); // under the max-fps interval: skipped
    frame(kit, 12); // renders and pays the skipped 8 ms too

    expect(shadowDraws).toHaveLength(3);
    expect(frameDiag.snapshot().throttled).toBe(1);
    expect(deltas).toHaveLength(3);
    expect(deltas[2]).toBeCloseTo(0.02, 4);
  });
});

describe("selection box during playback", () => {
  it("follows the pose every frame while playback runs", () => {
    const { kit, node } = makeKit(true);
    frame(kit);
    const setFromObject = vi.spyOn(THREE.Box3.prototype, "setFromObject");
    setFromObject.mockClear();

    node.position.set(5, 0, 0);
    node.updateMatrixWorld(true);
    frame(kit);

    expect(setFromObject).toHaveBeenCalledTimes(1);
    expect(boxOf(kit).min.x).toBeCloseTo(4.5, 6);

    node.position.set(-2, 0, 0);
    node.updateMatrixWorld(true);
    frame(kit);

    expect(setFromObject).toHaveBeenCalledTimes(2);
    expect(boxOf(kit).min.x).toBeCloseTo(-2.5, 6);
  });

  it("walks vertices at most once per pose", () => {
    // A pose nulls the animated geometry's cached box (the in-place write in
    // sceneBuilder). The first rescan after it repopulates that cache, so the
    // frames in between a pose must not walk the vertices again.
    const { kit, node } = makeKit(true);
    const geometry = (node as THREE.Mesh).geometry;
    frame(kit);
    const walk = vi.spyOn(THREE.BufferGeometry.prototype, "computeBoundingBox");

    geometry.boundingBox = null; // what applyPackedGeometryInPlace does
    frame(kit);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(geometry.boundingBox).not.toBeNull();

    frame(kit);
    frame(kit);
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it("rescans on the paused frame and tracks pose changes while paused", () => {
    const { kit, node } = makeKit(false);
    const setFromObject = vi.spyOn(THREE.Box3.prototype, "setFromObject");
    frame(kit);
    expect(setFromObject).toHaveBeenCalledTimes(1);

    // Paused scrub: the node re-poses, the box follows it.
    node.position.set(-3, 0, 0);
    node.updateMatrixWorld(true);
    setFromObject.mockClear();
    frame(kit);

    expect(setFromObject).toHaveBeenCalledTimes(1);
    expect(boxOf(kit).min.x).toBeCloseTo(-3.5, 6);
  });

  it("starts a fresh pose chain on the frame where playback resumes", () => {
    const { kit } = makeKit(true);
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    frameDiag.reset();
    frameDiag.onPose(0, 0);

    kit.isPlayingAnim = false;
    frame(kit); // play -> pause: the dump, not a chain reset
    kit.isPlayingAnim = true;
    frame(kit); // pause -> play: the resume must not inherit the pause

    frameDiag.onPose(3000, 1); // first present after a 3 s pause
    frameDiag.onPose(3041.7, 2);

    const diag = frameDiag.snapshot();
    expect(diag.poseN).toBe(1);
    expect(diag.poseMax).toBe(41.7);
    table.mockRestore();
  });

  it("tracks a selection change during playback", () => {
    const { kit } = makeKit(true);
    frame(kit);

    const other = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    other.position.set(10, 0, 0);
    kit.selectedNode = other;
    // A previously hidden box must come back with the new selection.
    kit.selectionHelper!.visible = false;
    frame(kit);

    expect(boxOf(kit).min.x).toBeCloseTo(9, 6);
    expect(kit.selectionHelper!.visible).toBe(true);
  });

  it("hides the box when the selection clears during playback", () => {
    const { kit } = makeKit(true);
    frame(kit);
    expect(kit.selectionHelper!.visible).toBe(true);

    kit.selectedNode = null;
    frame(kit);

    expect(kit.selectionHelper!.visible).toBe(false);
  });
});

describe("drawing buffer", () => {
  it("does not ask the browser to preserve it", () => {
    // A preserved buffer costs a full-canvas copy per frame; the exporters
    // render right before each read instead.
    const src = readFileSync(fileURLToPath(new URL("./RendererKit.svelte.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/preserveDrawingBuffer/);
  });
});

describe("shadow map updates", () => {
  it("turns the on-demand shadow map on in init", () => {
    // init needs a real WebGL context, so the call site is pinned at the
    // source: without it three.js redraws every caster every frame.
    const src = readFileSync(fileURLToPath(new URL("./RendererKit.svelte.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/initOnDemandShadows\(this\.renderer\.shadowMap\)/);
  });

  it("draws the map on the first frame, then leaves it alone on plain frames", () => {
    const { kit, shadowDraws } = makeKit(false);
    requestShadowUpdate();

    frame(kit);
    frame(kit);
    frame(kit);

    expect(shadowDraws).toEqual([true, false, false]);
  });

  it("does not redraw while a paused scene is orbited", () => {
    const { kit, shadowDraws } = makeKit(true);
    kit.isPlayingAnim = false;
    kit.camera = new THREE.PerspectiveCamera();
    // OrbitControls motion moves the camera only: no caster moves.
    kit.controls = {
      update: vi.fn(() => kit.camera.position.set(kit.camera.position.x + 1, 0, 3)),
    } as unknown as RendererKit["controls"];
    requestShadowUpdate();

    frame(kit);
    frame(kit);
    frame(kit);

    expect(shadowDraws).toEqual([true, false, false]);
  });

  it("redraws the frame after a request, once", () => {
    const { kit, shadowDraws } = makeKit(true);
    requestShadowUpdate();
    frame(kit);

    requestShadowUpdate(); // a pose, an edit refresh or a load landed
    frame(kit);
    frame(kit);

    expect(shadowDraws).toEqual([true, true, false]);
  });
});
