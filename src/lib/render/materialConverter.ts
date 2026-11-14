// Pure converter for the Rust `get_material_data` payload (materials.rs) —
// no Svelte, no invoke: MaterialInfo in, THREE.MeshPhysicalMaterial out. The
// texture loader is injected so Task 4 can wire convertFileSrc fetching;
// tests pass a stub. Fail-soft throughout: unknown texture inputs are
// skipped and a texture the loader cannot fetch falls back to base color.
//
// Textures attach asynchronously (F8): convertMaterial returns the material
// with its authored constants already applied, and each resolved clone
// overwrites its own slot on the SAME instance, so a mesh built before the
// decode finished upgrades in place — no spinner, no placeholder texture.
import * as THREE from "three";
import type {
  Displacement,
  MaterialInfo,
  PreviewSurface,
  TextureInput,
  UvTransform,
  ValuePayload,
} from "../stage/types";
import { isExrPath } from "./textureLoaders";

export type MaterialTextureLoader = (file_path: string, onError: () => void) => Promise<THREE.Texture>;

type TextureSlot =
  | "map"
  | "normalMap"
  | "roughnessMap"
  | "metalnessMap"
  | "alphaMap"
  | "emissiveMap"
  | "specularColorMap"
  | "clearcoatMap"
  | "clearcoatRoughnessMap"
  | "aoMap";

// USD PreviewSurface input name -> three.js material slot. Unknown inputs
// (studio shader dialects, future channels) are skipped, never errors.
const TEXTURE_SLOTS: Record<string, TextureSlot> = {
  diffuseColor: "map",
  normal: "normalMap",
  roughness: "roughnessMap",
  metallic: "metalnessMap",
  opacity: "alphaMap",
  emissiveColor: "emissiveMap",
  specularColor: "specularColorMap",
  clearcoat: "clearcoatMap",
  clearcoatRoughness: "clearcoatRoughnessMap",
  occlusion: "aoMap",
};

// Slots carrying sRGB-encoded color data; every other slot holds linear data.
const COLOR_SLOTS: TextureSlot[] = ["map", "emissiveMap", "specularColorMap"];

export function convertMaterial(
  info: MaterialInfo,
  fallbackColor: string | null,
  loadTexture: MaterialTextureLoader,
): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial();
  material.name = info.name;

  const surface = info.surface;
  if (surface) {
    applyTextures(material, info, surface, loadTexture, fallbackColor);
    applySurfaceConstants(material, surface);
  } else if (info.has_volume) {
    // Volume-only material (no surface to draw): translucent gray placeholder.
    material.color.setHex(0x888888);
    material.opacity = 0.35;
    material.transparent = true;
  }

  applyDisplacement(material, info.displacement, loadTexture);
  // No map has landed yet, so the textured case renders as the untextured one
  // until its clone arrives (attachSlot re-runs this rule with hasMap = true).
  applyFallbackColor(material, info, surface, false, fallbackColor);
  return material;
}

function applyTextures(
  material: THREE.MeshPhysicalMaterial,
  info: MaterialInfo,
  surface: PreviewSurface,
  loadTexture: MaterialTextureLoader,
  fallbackColor: string | null,
): void {
  for (const texture of surface.textures) {
    const slot = TEXTURE_SLOTS[texture.input];
    if (!slot) continue;
    // A failed load needs no undo: the slot still holds the authored constant
    // this convert applied (the fail-soft rule, now free). The catch keeps a
    // rejection out of the renderer.
    loadTexture(texture.file_path, () => {})
      .then((loaded) => attachSlot(material, info, surface, slot, texture, loaded, fallbackColor))
      .catch(() => {});
  }
}

// Per-slot parameters are applied to this slot's own clone once it lands: the
// clone was taken after the decode, so it carries the decoded pixel format
// and is still free of every other slot's wrap/colorSpace/UV settings.
function attachSlot(
  material: THREE.MeshPhysicalMaterial,
  info: MaterialInfo,
  surface: PreviewSurface,
  slot: TextureSlot,
  input: TextureInput,
  loaded: THREE.Texture,
  fallbackColor: string | null,
): void {
  loaded.wrapS = wrapMode(input.wrap_s);
  loaded.wrapT = wrapMode(input.wrap_t);
  loaded.colorSpace = colorSpace(input.color_space, slot, input.file_path);
  // USD occlusion samples the same st UVs, i.e. the base uv set.
  if (slot === "aoMap") loaded.channel = 0;
  applyUvTransform(loaded, input.uv_transform);
  // The pre-resolve material carries the authored constant; three multiplies
  // the map by that constant, so drop it to what the map-only path leaves.
  neutralizeSlot(material, slot);
  material[slot] = loaded;
  // An opacity texture blends per-pixel, so the whole material must render in the transparent pass.
  if (slot === "alphaMap") material.transparent = true;
  applyValueScale(material, slot, input);
  if (slot === "map") applyFallbackColor(material, info, surface, true, fallbackColor);
  material.needsUpdate = true;
}

// three's own defaults, i.e. the values the synchronous path left in place
// when a map occupied the slot (it skipped the authored constant entirely).
// Emissive is the exception: a black multiplier would swallow the map.
const NEUTRAL = new THREE.MeshPhysicalMaterial();

function neutralizeSlot(material: THREE.MeshPhysicalMaterial, slot: TextureSlot): void {
  switch (slot) {
    case "map":
      material.color.setRGB(1, 1, 1);
      break;
    case "emissiveMap":
      material.emissive.setRGB(1, 1, 1);
      break;
    case "specularColorMap":
      material.specularColor.copy(NEUTRAL.specularColor);
      break;
    case "roughnessMap":
      material.roughness = NEUTRAL.roughness;
      break;
    case "metalnessMap":
      material.metalness = NEUTRAL.metalness;
      break;
    case "clearcoatMap":
      material.clearcoat = NEUTRAL.clearcoat;
      break;
    case "clearcoatRoughnessMap":
      material.clearcoatRoughness = NEUTRAL.clearcoatRoughness;
      break;
  }
}

// Spec R8: authored constants land on the matching three.js slot, except
// where a texture occupies that slot — three multiplies map by constant, so
// applying both would double-count (spec R3 texture-wins rule).
function applySurfaceConstants(material: THREE.MeshPhysicalMaterial, surface: PreviewSurface): void {
  applyConstantColor(material, surface);

  const emissive = constantColor(surface.emissive_color);
  if (material.emissiveMap !== null) material.emissive = new THREE.Color(1, 1, 1);
  else if (emissive) material.emissive = emissive;

  if (material.specularColorMap === null) {
    const specular = constantColor(surface.specular_color);
    if (specular) material.specularColor = specular;
  }

  if (surface.roughness != null && material.roughnessMap === null) material.roughness = surface.roughness;
  if (surface.metallic != null && material.metalnessMap === null) material.metalness = surface.metallic;
  if (surface.clearcoat != null && material.clearcoatMap === null) material.clearcoat = surface.clearcoat;
  if (surface.clearcoat_roughness != null && material.clearcoatRoughnessMap === null) {
    material.clearcoatRoughness = surface.clearcoat_roughness;
  }

  if (surface.ior != null) material.ior = surface.ior;

  if (surface.opacity != null) {
    material.opacity = surface.opacity;
    material.transparent = surface.opacity < 1;
  }
  // The threshold discards fragments in any pass: three.js defines
  // USE_ALPHATEST from alphaTest alone. transparent = true is the spec R8 rule
  // here, not a requirement of the discard, and it costs pass sorting.
  if (surface.opacity_threshold != null) {
    material.alphaTest = surface.opacity_threshold;
    material.transparent = true;
  }
}

// Displacement only moves existing vertices, so a coarse mesh shows little or
// nothing — accepted (manual-pass note), not a bug. The authored scale stays a
// multiplier on the map, so it applies alongside it.
function applyDisplacement(
  material: THREE.MeshPhysicalMaterial,
  displacement: Displacement | null | undefined,
  loadTexture: MaterialTextureLoader,
): void {
  if (!displacement) return;
  if (displacement.file_path) {
    loadTexture(displacement.file_path, () => {})
      .then((loaded) => {
        loaded.colorSpace = THREE.NoColorSpace;
        material.displacementMap = loaded;
        material.needsUpdate = true;
      })
      .catch(() => {});
  }
  if (displacement.scale != null) material.displacementScale = displacement.scale;
}

// shortcut: "black"/"useMetadata" and unauthored wrap tokens fall back to
// repeat — three.js cannot do black borders and authored content (the
// CarbonFrameBike included) expects repeat; revisit if a clamp-critical asset appears
function wrapMode(token: string | null | undefined): THREE.Wrapping {
  if (token === "clamp") return THREE.ClampToEdgeWrapping;
  if (token === "mirror") return THREE.MirroredRepeatWrapping;
  return THREE.RepeatWrapping; // "repeat", "black", "useMetadata", unauthored
}

// Authored sourceColorSpace always wins; unauthored "auto" picks by slot:
// COLOR_SLOTS above is the whole default table — color slots carry
// sRGB-encoded files, data slots carry linear data. EXR is the exception: the
// file holds scene-linear floats in every channel, so it never takes the
// sRGB default, color slot or not.
function colorSpace(token: string | null | undefined, slot: TextureSlot, filePath: string): THREE.ColorSpace {
  if (token === "raw") return THREE.NoColorSpace;
  // shortcut: an authored "sRGB" on a half-float EXR still uploads linear —
  // three's verifyColorSpace refuses sRGB for HalfFloatType (only RGBA8 gets an
  // sRGB internal format), so the token stays on the texture but the GPU
  // samples linear; upgrade when an EXR authored sRGB must display sRGB, or a
  // non-half-float EXR path appears
  if (token === "sRGB") return THREE.SRGBColorSpace;
  if (isExrPath(filePath)) return THREE.NoColorSpace;
  return COLOR_SLOTS.includes(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace; // unauthored "auto"
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
  slot: TextureSlot,
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
  // shortcut: emissiveMap and specularColorMap share this no-per-map-scale
  // gap; an emissive fold into material.emissive would be exact — upgrade
  // when an asset authors a scale on either
}

// USD colors are linear and three.js stores working-space values linear, so
// the payload numbers map straight onto THREE.Color.
function constantColor(payload: ValuePayload | null | undefined): THREE.Color | null {
  if (!payload || !Array.isArray(payload.data) || payload.data.length !== 3) return null;
  const data = payload.data as number[];
  return new THREE.Color(data[0], data[1], data[2]);
}

function applyConstantColor(material: THREE.MeshPhysicalMaterial, surface: PreviewSurface): void {
  if (material.map !== null) return;
  const color = constantColor(surface.diffuse_color);
  if (color) material.color = color;
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
