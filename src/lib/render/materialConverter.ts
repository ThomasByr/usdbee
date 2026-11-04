// Pure converter for the Rust `get_material_data` payload (materials.rs) —
// no Svelte, no invoke: MaterialInfo in, THREE.MeshPhysicalMaterial out. The
// texture loader is injected so Task 4 can wire convertFileSrc fetching;
// tests pass a stub. Fail-soft throughout: unknown texture inputs are
// skipped and a texture the loader cannot fetch falls back to base color.
import * as THREE from "three";
import type { MaterialInfo, PreviewSurface, TextureInput, UvTransform } from "../stage/types";

export type MaterialTextureLoader = (file_path: string, onError: () => void) => THREE.Texture | null;

export function convertMaterial(
  info: MaterialInfo,
  fallbackColor: string | null,
  loadTexture: MaterialTextureLoader,
): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial();
  material.name = info.name;

  const surface = info.surface;
  let hasMap = false;
  if (surface) {
    applyTextures(material, surface, loadTexture, fallbackColor);
    hasMap = material.map !== null;
    applyConstantColor(material, surface);
    if (surface.roughness !== null) material.roughness = surface.roughness;
    if (surface.metallic !== null) material.metalness = surface.metallic;
    if (surface.opacity !== null) {
      material.opacity = surface.opacity;
      material.transparent = surface.opacity < 1;
    }
    // An opacity texture blends per-pixel, so the whole material must render in the transparent pass.
    if (material.alphaMap !== null) material.transparent = true;
  }

  applyFallbackColor(material, info, surface, hasMap, fallbackColor);
  return material;
}

function applyTextures(
  material: THREE.MeshPhysicalMaterial,
  surface: PreviewSurface,
  loadTexture: MaterialTextureLoader,
  fallbackColor: string | null,
): void {
  for (const texture of surface.textures) {
    const slot = {
      diffuseColor: "map",
      normal: "normalMap",
      roughness: "roughnessMap",
      metallic: "metalnessMap",
      opacity: "alphaMap",
    }[texture.input] as "map" | "normalMap" | "roughnessMap" | "metalnessMap" | "alphaMap" | undefined;
    if (!slot) continue;
    const loaded = loadTexture(texture.file_path, () => {
      if (!loaded) return;
      loaded.dispose();
      if (material[slot] !== loaded) return;
      material[slot] = null;
      if (slot === "map") {
        applyConstantColor(material, surface);
        applyFallbackColor(material, { name: material.name, surface }, surface, false, fallbackColor);
      }
      material.needsUpdate = true;
    });
    if (loaded) {
      loaded.wrapS = wrapMode(texture.wrap_s);
      loaded.wrapT = wrapMode(texture.wrap_t);
      applyUvTransform(loaded, texture.uv_transform);
      applyValueScale(material, slot, texture);
      material[slot] = loaded;
    }
  }
}

// shortcut: "black"/"useMetadata" and unauthored wrap tokens fall back to
// repeat — three.js cannot do black borders and authored content (the
// CarbonFrameBike included) expects repeat; revisit if a clamp-critical asset appears
function wrapMode(token: string | null | undefined): THREE.Wrapping {
  if (token === "clamp") return THREE.ClampToEdgeWrapping;
  if (token === "mirror") return THREE.MirroredRepeatWrapping;
  return THREE.RepeatWrapping; // "repeat", "black", "useMetadata", unauthored
}

// USD's UsdTransform2d composes `result = in * scale * rotate + translation`
// (rotation counter-clockwise in degrees around the origin). three.js builds
// the same SRT via setUvTransform(offset, repeat, rotation, center): scale,
// then rotation around `center` (positive = the opposite sign of USD's),
// then offset. With center (0,0), repeat=scale, offset=translation and
// negated rotation in radians the two match exactly. The loader creates a
// fresh THREE.Texture per slot, so per-slot transforms are safe even when
// a file is shared across inputs.
function applyUvTransform(texture: THREE.Texture, transform: UvTransform | null | undefined): void {
  if (!transform) return;
  texture.repeat.set(transform.scale[0] ?? 1, transform.scale[1] ?? 1);
  texture.offset.set(transform.translation[0] ?? 0, transform.translation[1] ?? 0);
  texture.center.set(0, 0);
  texture.rotation = -transform.rotation * (Math.PI / 180);
}

// UsdUVTexture value scale/bias, applied only where three.js has an exact
// equivalent or none at all is needed.
function applyValueScale(
  material: THREE.MeshPhysicalMaterial,
  slot: "map" | "normalMap" | "roughnessMap" | "metalnessMap" | "alphaMap",
  texture: TextureInput,
): void {
  const scale = texture.value_scale;
  if (!scale) return;
  if (slot === "normalMap") {
    // The authored (2,2,2,1) / (-1,-1,-1,0) is the 0..1 -> -1..1 decode
    // three.js's normal map shader already performs; re-applying it would
    // double-decode. No-op by design (bias likewise).
    return;
  }
  if (slot === "map") {
    // diffuseColor value scale folds into material.color, which three.js
    // multiplies with the map in-shader — an exact substitute (the one
    // authored non-normal case, CarbonFrameBike's 0.445 tire albedo).
    material.color.multiply(new THREE.Color(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1));
  }
  // roughness/metallic/opacity maps: three.js has no per-map value
  // scale/bias mechanism and no asset authors one; the payload carries
  // them for a future custom-shader path. Value bias has no mechanism on
  // any slot and no authored case outside the normal-map decode above.
}

// USD colors are linear and three.js stores working-space values linear, so
// the payload numbers map straight onto THREE.Color.
function applyConstantColor(material: THREE.MeshPhysicalMaterial, surface: PreviewSurface): void {
  if (material.map !== null) return;
  const color = surface.diffuse_color;
  if (color && Array.isArray(color.data) && color.data.length === 3) {
    material.color = new THREE.Color(color.data[0], color.data[1], color.data[2]);
  }
}

// Fallback color, ported from the +page.svelte replaceWithColor logic: apply
// the chosen color when the material has no map, or when the material name
// matches the basename (sans extension) of one of its textures.
function applyFallbackColor(
  material: THREE.MeshPhysicalMaterial,
  info: MaterialInfo,
  surface: PreviewSurface | null,
  hasMap: boolean,
  fallbackColor: string | null,
): void {
  if (fallbackColor === null) return;
  const name = info.name.toLowerCase();
  const matchesTexture = (surface?.textures ?? []).some((texture) => {
    const base = texture.file_path.split(/[\\/]/).pop() ?? "";
    const stem = base.split(".")[0]?.toLowerCase() ?? "";
    return stem !== "" && name.includes(stem);
  });
  if (!hasMap || matchesTexture) {
    material.color = new THREE.Color(fallbackColor);
  }
}
