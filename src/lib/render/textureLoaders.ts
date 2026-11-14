// Loader pick by extension: EXR holds float data that the image path cannot
// read, so it goes through three's DataTextureLoader-based EXRLoader. Both
// loaders return their texture synchronously (EXR decodes into it later); the
// promise the cache hands out settles on their onLoad, so a slow decode is
// ordinary async here.
import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

// One instance per loader: both are stateless between loads.
const imageLoader = new THREE.TextureLoader();
// shortcut: EXR decode runs on the main thread, a large EXR can hitch the first load,
// upgrade to a worker decode when a production EXR visibly stutters
const exrLoader = new EXRLoader();

export function isExrPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".exr");
}

// shortcut: .hdr/RGBE stays unsupported (log-encoded, needs RGBELoader plus its
// own linear rule), add it when a fixture demands one
export function pickTextureLoader(filePath: string): THREE.TextureLoader | EXRLoader {
  return isExrPath(filePath) ? exrLoader : imageLoader;
}
