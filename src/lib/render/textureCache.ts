// F6 texture memo: the render manifest references the same image from many
// materials (the bike: 92 inputs over 10 files), so the loader decodes and
// uploads each file once and hands every material a CLONE. Clones keep
// per-slot wrap/colorSpace/UV transforms independent, and three.js still
// shares one GPU texture per image + parameter set (WebGLTextures caches by
// source), so the uploads collapse too.
import * as THREE from "three";

type LoadTexture = (onLoad: () => void, onError: () => void) => THREE.Texture | null;

interface CacheEntry {
  texture: THREE.Texture;
  // Materials waiting on this image: a failed decode must reach every one of
  // them so each can fall back to its constant color.
  waiters: (() => void)[];
}

// Keyed by the fully resolved file path the manifest carries (usdz stages
// already hand out the extraction-dir path, so no two spellings of one file
// reach this map).
const cache = new Map<string, CacheEntry>();

export function loadCachedTexture(
  filePath: string,
  onError: () => void,
  load: LoadTexture,
): THREE.Texture | null {
  const cached = cache.get(filePath);
  if (cached) {
    cached.waiters.push(onError);
    return cached.texture.clone();
  }
  // The entry is visible to later callers as soon as load() returns, inside
  // this same synchronous block, so `texture` is never read while unset.
  const entry = { texture: null as unknown as THREE.Texture, waiters: [onError] };
  cache.set(filePath, entry);
  const texture = load(
    () => {
      entry.waiters.length = 0; // decoded: no fallbacks to run, no closures held
    },
    () => {
      // A broken image is never served from the cache.
      cache.delete(filePath);
      for (const waiter of entry.waiters) waiter();
      entry.waiters.length = 0;
    },
  );
  if (!texture) {
    cache.delete(filePath);
    return null;
  }
  entry.texture = texture;
  return texture.clone();
}

// Called at the start of every scene load, right after the previous scene
// was disposed: the next scene decodes from scratch, so no image from a
// closed or superseded scene can resurface.
export function clearTextureCache(): void {
  cache.clear();
}
