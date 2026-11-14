// F6 texture memo: one decode per file, independent clones per material,
// and no entry survives a failed load or a scene disposal.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { clearTextureCache, loadCachedTexture } from "./textureCache";

beforeEach(clearTextureCache);

describe("loadCachedTexture", () => {
  it("loads a shared file once and hands out independent clones", () => {
    const load = vi.fn(() => new THREE.Texture());

    const first = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    const second = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);

    expect(load).toHaveBeenCalledOnce();
    // Distinct objects: per-slot wrap/colorSpace/UV transforms must not leak
    // from one material to the next.
    expect(first).not.toBe(second);
    expect(first!.source).toBe(second!.source);
    first!.repeat.set(4, 4);
    expect(second!.repeat.x).toBe(1);
  });

  it("keeps different resolved paths separate", () => {
    const load = vi.fn(() => new THREE.Texture());

    const a = loadCachedTexture("/cache/usdz/texgen_7.png", () => {}, load);
    const b = loadCachedTexture("/cache/other/texgen_7.png", () => {}, load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(a!.source).not.toBe(b!.source);
  });

  it("does not cache a failed load and notifies every waiting material", () => {
    const errors: (() => void)[] = [];
    const load = vi.fn((_onLoad: () => void, onError: () => void) => {
      errors.push(onError);
      return new THREE.Texture();
    });
    const firstFallback = vi.fn();
    const secondFallback = vi.fn();

    loadCachedTexture("/Textures/broken.png", firstFallback, load);
    loadCachedTexture("/Textures/broken.png", secondFallback, load);
    expect(load).toHaveBeenCalledOnce();

    // The image errors out after both materials took a clone.
    errors[0]!();
    expect(firstFallback).toHaveBeenCalledOnce();
    expect(secondFallback).toHaveBeenCalledOnce();

    loadCachedTexture("/Textures/broken.png", () => {}, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a load that could not start", () => {
    const load = vi.fn(() => null);

    expect(loadCachedTexture("/Textures/none.png", () => {}, load)).toBeNull();
    expect(loadCachedTexture("/Textures/none.png", () => {}, load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("re-copies the async decoder's pixel format onto clones taken before decode", () => {
    // DataTextureLoader derivatives (EXR) decode asynchronously: they assign
    // format/type and the sampler fields only after load() returns, while
    // Texture.copy() snapshots them. A clone taken in that window would
    // upload half-float data as unsigned bytes, a silently broken texture.
    let decode: () => void = () => {};
    const load = vi.fn((onLoad: () => void) => {
      const texture = new THREE.DataTexture();
      decode = () => {
        texture.type = THREE.HalfFloatType;
        texture.format = THREE.RedFormat;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        onLoad();
      };
      return texture;
    });

    const first = loadCachedTexture("/cache/env/studio.exr", () => {}, load)!;
    const second = loadCachedTexture("/cache/env/studio.exr", () => {}, load)!;
    // The converter owns these; the decode landing must not reset them.
    first.colorSpace = THREE.SRGBColorSpace;
    first.wrapS = THREE.RepeatWrapping;
    first.repeat.set(4, 4);

    expect(first.type).toBe(THREE.UnsignedByteType); // the clone-time snapshot
    decode();

    for (const texture of [first, second]) {
      expect(texture.type).toBe(THREE.HalfFloatType);
      expect(texture.format).toBe(THREE.RedFormat);
      expect(texture.magFilter).toBe(THREE.LinearFilter);
      expect(texture.minFilter).toBe(THREE.LinearFilter);
    }
    expect(first.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(first.wrapS).toBe(THREE.RepeatWrapping);
    expect(first.repeat.x).toBe(4);
  });

  it("drops every entry on clear so the next scene decodes again", () => {
    const load = vi.fn(() => new THREE.Texture());
    loadCachedTexture("/Textures/texgen_7.png", () => {}, load);

    clearTextureCache();
    loadCachedTexture("/Textures/texgen_7.png", () => {}, load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
