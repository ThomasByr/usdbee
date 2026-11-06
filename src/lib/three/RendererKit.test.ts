// Frame-loop pin: the selection box must not be recomputed from the
// selected node while playback runs (each pose nulls the animated
// geometry's bounding box, so a rescan walks every selected vertex), and
// must refresh on pause, on a paused scrub and on a selection change.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: () => Promise.resolve() }),
}));

import * as THREE from "three";
import { RendererKit } from "./RendererKit.svelte";
import * as frameDiag from "$lib/perf/frameDiag";
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

// One render-loop tick (time 0 skips the max-fps throttle).
function frame(kit: RendererKit) {
  (kit as any).animate(0);
}

function boxOf(kit: RendererKit): THREE.Box3 {
  return kit.selectionHelper!.box;
}

beforeEach(() => {
  // No recursive rAF ticks: the test drives every frame itself.
  vi.stubGlobal("requestAnimationFrame", () => 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selection box during playback", () => {
  it("does not rescan while playback runs", () => {
    const { kit, node } = makeKit(true);
    frame(kit);
    const setFromObject = vi.spyOn(THREE.Box3.prototype, "setFromObject");
    setFromObject.mockClear();

    node.position.set(5, 0, 0);
    node.updateMatrixWorld(true);
    frame(kit);
    frame(kit);

    expect(setFromObject).not.toHaveBeenCalled();
    expect(boxOf(kit).min.x).toBeCloseTo(-0.5, 6);
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

  it("rescans on the frame where playback pauses", () => {
    const { kit, node } = makeKit(true);
    frame(kit);
    const setFromObject = vi.spyOn(THREE.Box3.prototype, "setFromObject");
    setFromObject.mockClear();

    // The pose reached while playing, frozen until the pause lands.
    node.position.set(-3, 0, 0);
    node.updateMatrixWorld(true);
    kit.isPlayingAnim = false;
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

  it("rescans once when the selection changes during playback", () => {
    const { kit, node } = makeKit(true);
    frame(kit);
    const setFromObject = vi.spyOn(THREE.Box3.prototype, "setFromObject");
    setFromObject.mockClear();
    node.position.set(5, 0, 0);
    node.updateMatrixWorld(true);

    const other = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    other.position.set(10, 0, 0);
    kit.selectedNode = other;
    // A previously hidden box must come back with the new selection.
    kit.selectionHelper!.visible = false;
    frame(kit);

    expect(setFromObject).toHaveBeenCalledTimes(1);
    expect(boxOf(kit).min.x).toBeCloseTo(9, 6);
    expect(kit.selectionHelper!.visible).toBe(true);
    frame(kit);
    expect(setFromObject).toHaveBeenCalledTimes(1);
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
