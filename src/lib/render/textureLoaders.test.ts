// Loader pick: EXR carries float data that the image path cannot read.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { isExrPath, pickTextureLoader } from "./textureLoaders";

describe("pickTextureLoader", () => {
  it("routes exr paths to EXRLoader and image paths to TextureLoader", () => {
    expect(pickTextureLoader("/cache/tex/bump.exr")).toBeInstanceOf(EXRLoader);
    expect(pickTextureLoader("/cache/tex/BUMP.EXR")).toBeInstanceOf(EXRLoader);
    expect(pickTextureLoader("/cache/tex/albedo.png")).toBeInstanceOf(THREE.TextureLoader);
    expect(pickTextureLoader("/cache/tex/albedo.jpg")).toBeInstanceOf(THREE.TextureLoader);
  });

  it("does not mistake a longer name for an exr", () => {
    expect(isExrPath("/cache/tex/studio.exr.png")).toBe(false);
    expect(isExrPath("/cache/tex/studioexr")).toBe(false);
    expect(isExrPath("/cache/tex/studio.exr")).toBe(true);
  });
});
