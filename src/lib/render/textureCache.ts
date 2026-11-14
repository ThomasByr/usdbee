// F6 texture memo: the render manifest references the same image from many
// materials (the bike: 92 inputs over 10 files), so the loader decodes each
// file once and hands every material a CLONE. Clones keep per-slot
// wrap/colorSpace/UV transforms independent, and three.js still shares one GPU
// texture per image + parameter set (WebGLTextures caches by source), so the
// uploads collapse too.
import * as THREE from "three";

type LoadTexture = (onLoad: () => void, onError: () => void) => THREE.Texture | null;

interface CacheEntry {
  // Set as soon as load() returns. DataTextureLoader derivatives (EXR) fill
  // the pixel format and sampler fields only when `decoded` settles, which is
  // why no clone leaves before then.
  texture: THREE.Texture | null;
  // The decode signal: resolves when the image is ready, rejects when it
  // failed (the same failure the waiters hear).
  decoded: Promise<void>;
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
): Promise<THREE.Texture> {
  const cached = cache.get(filePath);
  if (cached) {
    cached.waiters.push(onError);
    return cloneWhenDecoded(cached);
  }
  let resolveDecoded!: () => void;
  let rejectDecoded!: (reason: Error) => void;
  const decoded = new Promise<void>((resolve, reject) => {
    resolveDecoded = resolve;
    rejectDecoded = reject;
  });
  const entry: CacheEntry = { texture: null, decoded, waiters: [onError] };
  // Visible to later callers at once: they join this entry and its decode.
  cache.set(filePath, entry);

  const fail = (reason: string) => {
    // A broken image is never served from the cache. Only the entry that still
    // owns the slot may leave it: a superseded decode can fail after a scene
    // swap (`clearTextureCache`), and it must not evict the newer entry for the
    // same file.
    if (cache.get(filePath) === entry) cache.delete(filePath);
    notifyWaiters(entry);
    rejectDecoded(new Error(`usdbee: ${reason}: ${filePath}`));
  };

  let texture: THREE.Texture | null = null;
  try {
    texture = load(
      () => {
        entry.waiters.length = 0; // decoded: no fallbacks to run, no closures held
        resolveDecoded();
      },
      () => fail("texture failed to load"),
    );
  } catch {
    texture = null;
  }
  if (!texture) {
    fail("texture load could not start");
    return cloneWhenDecoded(entry);
  }
  // A loader that decoded synchronously inside load() may already have
  // resolved `decoded`; the clone below still reads `texture` from a
  // microtask, i.e. after this assignment.
  entry.texture = texture;
  return cloneWhenDecoded(entry);
}

function notifyWaiters(entry: CacheEntry): void {
  const waiters = entry.waiters;
  entry.waiters = [];
  for (const waiter of waiters) waiter();
}

// The clone is taken AFTER the decode: Texture.copy() snapshots format/type/
// filters, so a clone taken earlier would upload half-float data as unsigned
// bytes (the EXR path).
function cloneWhenDecoded(entry: CacheEntry): Promise<THREE.Texture> {
  return entry.decoded.then(() => entry.texture!.clone());
}

// Called at the start of every scene load, right after the previous scene
// was disposed: the next scene decodes from scratch, so no image from a
// closed or superseded scene can resurface.
export function clearTextureCache(): void {
  cache.clear();
}
