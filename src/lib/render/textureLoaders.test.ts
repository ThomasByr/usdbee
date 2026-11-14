// Loader pick: EXR carries float data that the image path cannot read, and
// KTX2 is a container the image path cannot even parse.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { isExrPath, isKtx2Path, loadTexture, pickTextureLoader } from "./textureLoaders";

describe("pickTextureLoader", () => {
  it("routes exr paths to EXRLoader and image paths to TextureLoader", () => {
    expect(pickTextureLoader("/cache/tex/bump.exr")).toBeInstanceOf(EXRLoader);
    expect(pickTextureLoader("/cache/tex/BUMP.EXR")).toBeInstanceOf(EXRLoader);
    expect(pickTextureLoader("/cache/tex/albedo.png")).toBeInstanceOf(THREE.TextureLoader);
    expect(pickTextureLoader("/cache/tex/albedo.jpg")).toBeInstanceOf(THREE.TextureLoader);
  });

  it("routes ktx2 and ktx paths to KTX2Loader", () => {
    expect(pickTextureLoader("/cache/tex/albedo.ktx2")).toBeInstanceOf(KTX2Loader);
    expect(pickTextureLoader("/cache/tex/ALBEDO.KTX")).toBeInstanceOf(KTX2Loader);
  });

  it("does not mistake a longer name for an exr", () => {
    expect(isExrPath("/cache/tex/studio.exr.png")).toBe(false);
    expect(isExrPath("/cache/tex/studioexr")).toBe(false);
    expect(isExrPath("/cache/tex/studio.exr")).toBe(true);
  });

  it("does not mistake a longer name for a ktx2", () => {
    expect(isKtx2Path("/cache/tex/studio.ktx2.png")).toBe(false);
    expect(isKtx2Path("/cache/tex/studioktx2")).toBe(false);
    expect(isKtx2Path("/cache/tex/studio.ktx2")).toBe(true);
    expect(isKtx2Path("/cache/tex/studio.ktx")).toBe(true);
  });
});

describe("loadTexture", () => {
  it("fills the ktx2 placeholder from the loader callback", () => {
    // KTX2Loader.load() returns nothing; the texture arrives in onLoad only.
    const loader = pickTextureLoader("/cache/tex/albedo.ktx2") as KTX2Loader;
    const decode = vi.spyOn(loader, "load").mockImplementation(((
      _url: string,
      onLoad: (texture: THREE.Texture) => void,
    ) => {
      const transcoded = new THREE.CompressedTexture([], 8, 8);
      transcoded.colorSpace = THREE.SRGBColorSpace;
      onLoad(transcoded);
    }) as unknown as KTX2Loader["load"]);

    let loaded = false;
    const texture = loadTexture(
      "/cache/tex/albedo.ktx2",
      "blob:albedo",
      () => (loaded = true),
      () => {},
    );
    decode.mockRestore();

    expect(texture).toBeInstanceOf(THREE.CompressedTexture);
    expect(texture!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(loaded).toBe(true);
  });

  it("routes a ktx2 failure to the cache's error callback", () => {
    const loader = pickTextureLoader("/cache/tex/albedo.ktx") as KTX2Loader;
    const fail = vi.spyOn(loader, "load").mockImplementation(((
      _url: string,
      _onLoad: unknown,
      _progress: unknown,
      onError: () => void,
    ) => {
      onError();
    }) as unknown as KTX2Loader["load"]);

    let failed = false;
    loadTexture(
      "/cache/tex/albedo.ktx",
      "blob:albedo",
      () => {},
      () => (failed = true),
    );
    fail.mockRestore();

    expect(failed).toBe(true);
  });
});
