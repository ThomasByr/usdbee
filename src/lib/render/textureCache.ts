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
  // Clones handed out before an async decode finished (see syncDecoded); null
  // once the decode landed.
  pending: THREE.Texture[] | null;
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
    return handOut(cached);
  }
  // The entry is visible to later callers as soon as load() returns, inside
  // this same synchronous block, so `texture` is never read while unset.
  const entry: CacheEntry = {
    texture: null as unknown as THREE.Texture,
    waiters: [onError],
    pending: [],
  };
  cache.set(filePath, entry);
  const texture = load(
    () => {
      entry.waiters.length = 0; // decoded: no fallbacks to run, no closures held
      const pending = entry.pending ?? [];
      entry.pending = null;
      if (entry.texture) for (const clone of pending) syncDecoded(entry.texture, clone);
    },
    () => {
      // A broken image is never served from the cache.
      entry.pending = null;
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
  return handOut(entry);
}

function handOut(entry: CacheEntry): THREE.Texture {
  const clone = entry.texture.clone();
  entry.pending?.push(clone);
  return clone;
}

// DataTextureLoader derivatives (EXR) decode asynchronously: they assign the
// pixel format and the sampler fields only after load() returns, while
// Texture.copy() snapshots them. A clone taken in that window would upload
// half-float data as unsigned bytes. Re-copy exactly those fields once the
// decode lands; wrap/colorSpace/UV transforms belong to the converter.
function syncDecoded(texture: THREE.Texture, clone: THREE.Texture): void {
  clone.format = texture.format;
  clone.type = texture.type;
  clone.internalFormat = texture.internalFormat;
  clone.flipY = texture.flipY;
  clone.magFilter = texture.magFilter;
  clone.minFilter = texture.minFilter;
  clone.generateMipmaps = texture.generateMipmaps;
  clone.needsUpdate = true;
}

// Called at the start of every scene load, right after the previous scene
// was disposed: the next scene decodes from scratch, so no image from a
// closed or superseded scene can resurface.
export function clearTextureCache(): void {
  cache.clear();
}
