// Shadow-map update discipline: with autoUpdate off, three.js draws the
// shadow map only when a frame consumes a request. Every trigger answers one
// question (can a caster or the light have moved?); a plain camera move
// answers no.

import * as THREE from "three";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeShadowUpdate,
  initOnDemandShadows,
  renderWithShadowUpdate,
  requestShadowUpdate,
} from "./shadowMapUpdate";

beforeEach(() => {
  consumeShadowUpdate();
});

describe("on-demand shadow updates", () => {
  it("turns autoUpdate off and draws the map on the next frame", () => {
    const shadowMap = { autoUpdate: true, needsUpdate: false };

    initOnDemandShadows(shadowMap);

    expect(shadowMap.autoUpdate).toBe(false);
    expect(consumeShadowUpdate()).toBe(true);
    // Consumed: the following frames must not redraw an unchanged map.
    expect(consumeShadowUpdate()).toBe(false);
  });

  it("coalesces repeated requests into one redraw", () => {
    requestShadowUpdate();
    requestShadowUpdate();

    expect(consumeShadowUpdate()).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);
  });
});

describe("renderWithShadowUpdate", () => {
  // `drawn` records what the shadow pass saw: three.js clears needsUpdate
  // itself once it has drawn the map.
  function fakeRender() {
    const drawn: boolean[] = [];
    const shadowMap = { autoUpdate: false, needsUpdate: false };
    const draw = vi.fn(() => {
      drawn.push(shadowMap.needsUpdate);
      shadowMap.needsUpdate = false;
    });
    return {
      draw,
      drawn,
      renderer: { render: draw, shadowMap } as unknown as THREE.WebGLRenderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
    };
  }

  it("hands a pending request to three.js and clears it after the draw", () => {
    const { draw, drawn, renderer, scene, camera } = fakeRender();
    requestShadowUpdate();

    renderWithShadowUpdate(renderer, scene, camera);
    renderWithShadowUpdate(renderer, scene, camera);

    expect(draw).toHaveBeenCalledTimes(2);
    expect(drawn).toEqual([true, false]);
  });

  it("draws without redrawing the map when nothing moved", () => {
    const { drawn, renderer, scene, camera } = fakeRender();

    renderWithShadowUpdate(renderer, scene, camera);

    expect(drawn).toEqual([false]);
  });
});

describe("draw-site discipline", () => {
  // A raw renderer.render() bypasses the request handoff, so the map drawn
  // on screen silently keeps the old casters.
  it("is the only file in src/ that calls renderer.render", () => {
    const srcRoot = fileURLToPath(new URL("../..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          if (/\.render\s*\(/.test(readFileSync(path, "utf8"))) {
            offenders.push(path.slice(srcRoot.length).replace(/\\/g, "/"));
          }
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual(["lib/three/shadowMapUpdate.ts"]);
  });
});
