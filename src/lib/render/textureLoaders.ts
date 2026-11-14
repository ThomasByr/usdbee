// Loader pick by extension: EXR holds float data that the image path cannot
// read, so it goes through three's DataTextureLoader-based EXRLoader. Both
// loaders return their texture synchronously (EXR decodes into it later); the
// promise the cache hands out settles on their onLoad, so a slow decode is
// ordinary async here.
//
// KTX2 is the one loader that returns nothing: it hands the transcoded
// (compressed) texture to onLoad only, so loadTexture gives the cache a
// placeholder that the callback fills in place.
import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

// One instance per loader: both are stateless between loads.
const imageLoader = new THREE.TextureLoader();
// shortcut: EXR decode runs on the main thread, a large EXR can hitch the first load,
// upgrade to a worker decode when a production EXR visibly stutters
const exrLoader = new EXRLoader();
const ktx2Loader = new KTX2Loader();

// The transcoder is vendored from the installed three dependency into
// public/basis/ (an npm package ships no static assets of its own).
ktx2Loader.setTranscoderPath("/basis/");

export function isExrPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".exr");
}

export function isKtx2Path(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".ktx2") || lower.endsWith(".ktx");
}

// shortcut: .hdr/RGBE stays unsupported (log-encoded, needs RGBELoader plus its
// own linear rule), add it when a fixture demands one
export function pickTextureLoader(filePath: string): THREE.TextureLoader | EXRLoader | KTX2Loader {
  if (isKtx2Path(filePath)) return ktx2Loader;
  return isExrPath(filePath) ? exrLoader : imageLoader;
}

// shortcut: detectSupport picks the transcode target formats from ONE
// renderer's WebGL extensions, so this loader follows that renderer's
// lifetime — call this again if RendererKit ever recreates its renderer.
export function configureTextureSupport(renderer: THREE.WebGLRenderer): void {
  ktx2Loader.detectSupport(renderer);
}

// The cache's shape: a texture object now, its decode signalled through
// onLoad/onError later.
export function loadTexture(
  filePath: string,
  url: string,
  onLoad: () => void,
  onError: () => void,
): THREE.Texture {
  const loader = pickTextureLoader(filePath);
  if (loader instanceof KTX2Loader) return loadKtx2(url, onLoad, onError);
  return loader.load(url, onLoad, undefined, onError);
}

// KTX2Loader.load() returns nothing, but the cache needs the object at call
// time (it clones only after the decode settles), so the transcoded texture is
// copied onto a placeholder — the late-fill shape the EXR path already has for
// its format/type.
// shortcut: only a 2D ktx2 fits the placeholder; a cube or array ktx2
// transcodes into subclasses (CompressedCubeTexture/CompressedArrayTexture)
// whose flags a copy cannot carry, upgrade when one ships as ktx2
function loadKtx2(url: string, onLoad: () => void, onError: () => void): THREE.Texture {
  const placeholder = new THREE.CompressedTexture([], 1, 1);
  ktx2Loader.load(
    url,
    (texture) => {
      placeholder.copy(texture);
      onLoad();
    },
    undefined,
    onError,
  );
  return placeholder;
}
