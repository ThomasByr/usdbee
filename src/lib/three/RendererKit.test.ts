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

function makeKit(playing: boolean) {
  const kit = new RendererKit();
  const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  kit.scene = new THREE.Scene();
  kit.renderer = { render: vi.fn() } as unknown as THREE.WebGLRenderer;
  kit.controls = { update: vi.fn() } as unknown as RendererKit["controls"];
  kit.selectedNode = node;
  kit.selectionHelper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0xffffff));
  kit.isPlayingAnim = playing;
  return { kit, node };
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
    frame(kit);

    expect(setFromObject).toHaveBeenCalledTimes(1);
    expect(boxOf(kit).min.x).toBeCloseTo(9, 6);
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
