// F6 texture memo: one decode per file, independent clones per material,
// and no entry survives a failed load or a scene disposal.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { clearTextureCache, loadCachedTexture } from "./textureCache";

beforeEach(clearTextureCache);

// A loader whose decode the test releases by hand; the real ones call onLoad
// from an image/EXR callback, i.e. after load() returned.
function deferredLoader(make: () => THREE.Texture = () => new THREE.Texture()) {
  const decodes: (() => void)[] = [];
  const load = vi.fn((onLoad: () => void) => {
    decodes.push(onLoad);
    return make();
  });
  return { load, decodeAll: () => decodes.forEach((decode) => decode()) };
}

describe("loadCachedTexture", () => {
  it("loads a shared file once and hands out independent clones", async () => {
    const { load, decodeAll } = deferredLoader();

    const first = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    const second = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    expect(load).toHaveBeenCalledOnce();
    decodeAll();

    const [a, b] = await Promise.all([first, second]);
    // Distinct objects: per-slot wrap/colorSpace/UV transforms must not leak
    // from one material to the next.
    expect(a).not.toBe(b);
    expect(a.source).toBe(b.source);
    a.repeat.set(4, 4);
    expect(b.repeat.x).toBe(1);
  });

  it("keeps different resolved paths separate", async () => {
    const { load, decodeAll } = deferredLoader();

    const a = loadCachedTexture("/cache/usdz/texgen_7.png", () => {}, load);
    const b = loadCachedTexture("/cache/other/texgen_7.png", () => {}, load);
    expect(load).toHaveBeenCalledTimes(2);
    decodeAll();

    const [first, second] = await Promise.all([a, b]);
    expect(first.source).not.toBe(second.source);
  });

  it("does not cache a failed load and notifies every waiting material", async () => {
    const errors: (() => void)[] = [];
    const load = vi.fn((_onLoad: () => void, onError: () => void) => {
      errors.push(onError);
      return new THREE.Texture();
    });
    const firstFallback = vi.fn();
    const secondFallback = vi.fn();

    const first = loadCachedTexture("/Textures/broken.png", firstFallback, load);
    const second = loadCachedTexture("/Textures/broken.png", secondFallback, load);
    expect(load).toHaveBeenCalledOnce();

    // The image errors out after both materials joined the entry.
    errors[0]!();
    expect(firstFallback).toHaveBeenCalledOnce();
    expect(secondFallback).toHaveBeenCalledOnce();
    // The promise the slots hold rejects too, so no slot hangs on it.
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();

    loadCachedTexture("/Textures/broken.png", () => {}, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a load that could not start", async () => {
    const load = vi.fn(() => null);

    await expect(loadCachedTexture("/Textures/none.png", () => {}, load)).rejects.toThrow();
    await expect(loadCachedTexture("/Textures/none.png", () => {}, load)).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("hands out clones after the decode, so an async decoder's pixel format survives", async () => {
    // DataTextureLoader derivatives (EXR) decode asynchronously: they assign
    // format/type and the sampler fields only after load() returns, while
    // Texture.copy() snapshots them. Cloning before the decode would upload
    // half-float data as unsigned bytes, a silently broken texture.
    const texture = new THREE.DataTexture();
    let finish: () => void = () => {};
    const load = vi.fn((onLoad: () => void) => {
      finish = () => {
        texture.type = THREE.HalfFloatType;
        texture.format = THREE.RedFormat;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        onLoad();
      };
      return texture;
    });

    const first = loadCachedTexture("/cache/env/studio.exr", () => {}, load);
    const second = loadCachedTexture("/cache/env/studio.exr", () => {}, load);
    finish();

    const [a, b] = await Promise.all([first, second]);
    for (const clone of [a, b]) {
      expect(clone.type).toBe(THREE.HalfFloatType);
      expect(clone.format).toBe(THREE.RedFormat);
      expect(clone.magFilter).toBe(THREE.LinearFilter);
      expect(clone.minFilter).toBe(THREE.LinearFilter);
    }
    // The converter owns these; the decode landing must not reset them.
    a.colorSpace = THREE.SRGBColorSpace;
    a.wrapS = THREE.RepeatWrapping;
    a.repeat.set(4, 4);
    expect(a.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(a.wrapS).toBe(THREE.RepeatWrapping);
    expect(a.repeat.x).toBe(4);
  });

  it("does not evict the newer entry when a superseded load fails late", async () => {
    // A scene swap clears the cache while the previous scene's decode is still
    // in flight. That stale decode's failure must not delete the entry the new
    // scene already owns, or the next reference decodes a third time.
    const decodes: (() => void)[] = [];
    const errors: (() => void)[] = [];
    const load = vi.fn((onLoad: () => void, onError: () => void) => {
      decodes.push(onLoad);
      errors.push(onError);
      return new THREE.Texture();
    });

    const stale = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    clearTextureCache();
    const fresh = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    expect(load).toHaveBeenCalledTimes(2);

    errors[0]!(); // the superseded decode errors out after the swap
    await expect(stale).rejects.toThrow();
    decodes[1]!();
    await expect(fresh).resolves.toBeInstanceOf(THREE.Texture);

    loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    expect(load).toHaveBeenCalledTimes(2); // the new scene's entry survived
  });

  it("drops every entry on clear so the next scene decodes again", async () => {
    const { load, decodeAll } = deferredLoader();
    const first = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    decodeAll();
    await first;

    clearTextureCache();
    const second = loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    decodeAll();
    await second;

    expect(load).toHaveBeenCalledTimes(2);
  });
});
