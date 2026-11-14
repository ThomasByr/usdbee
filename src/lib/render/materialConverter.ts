// Pure converter for the Rust `get_material_data` payload (materials.rs) —
// no Svelte, no invoke: MaterialInfo in, THREE.MeshPhysicalMaterial out. The
// texture loader is injected so Task 4 can wire convertFileSrc fetching;
// tests pass a stub. Fail-soft throughout: unknown texture inputs are
// skipped and a texture the loader cannot fetch falls back to base color.
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

export type MaterialTextureLoader = (file_path: string, onError: () => void) => THREE.Texture | null;

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
  let hasMap = false;
  if (surface) {
    applyTextures(material, surface, loadTexture, fallbackColor);
    hasMap = material.map !== null;
    applySurfaceConstants(material, surface);
    // An opacity texture blends per-pixel, so the whole material must render in the transparent pass.
    if (material.alphaMap !== null) material.transparent = true;
  } else if (info.has_volume) {
    // Volume-only material (no surface to draw): translucent gray placeholder.
    material.color.setHex(0x888888);
    material.opacity = 0.35;
    material.transparent = true;
  }

  applyDisplacement(material, info.displacement, loadTexture);
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
    const slot = TEXTURE_SLOTS[texture.input];
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
      restoreSlotConstant(material, surface, slot);
      material.needsUpdate = true;
    });
    if (loaded) {
      loaded.wrapS = wrapMode(texture.wrap_s);
      loaded.wrapT = wrapMode(texture.wrap_t);
      loaded.colorSpace = colorSpace(texture.color_space, slot, texture.file_path);
      // USD occlusion samples the same st UVs, i.e. the base uv set.
      if (slot === "aoMap") loaded.channel = 0;
      applyUvTransform(loaded, texture.uv_transform);
      applyValueScale(material, slot, texture);
      material[slot] = loaded;
    }
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

// A failed async load must undo the map-present rule above: the constant was
// skipped when the map was assigned, and emissive was painted white. Slots
// holding no authored constant already sit at three.js's default.
function restoreSlotConstant(
  material: THREE.MeshPhysicalMaterial,
  surface: PreviewSurface,
  slot: TextureSlot,
): void {
  switch (slot) {
    case "emissiveMap":
      material.emissive = constantColor(surface.emissive_color) ?? new THREE.Color(0, 0, 0);
      break;
    case "specularColorMap": {
      const specular = constantColor(surface.specular_color);
      if (specular) material.specularColor = specular;
      break;
    }
    case "roughnessMap":
      if (surface.roughness != null) material.roughness = surface.roughness;
      break;
    case "metalnessMap":
      if (surface.metallic != null) material.metalness = surface.metallic;
      break;
    case "clearcoatMap":
      if (surface.clearcoat != null) material.clearcoat = surface.clearcoat;
      break;
    case "clearcoatRoughnessMap":
      if (surface.clearcoat_roughness != null) material.clearcoatRoughness = surface.clearcoat_roughness;
      break;
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
    const loaded = loadTexture(displacement.file_path, () => {
      if (!loaded) return;
      loaded.dispose();
      if (material.displacementMap !== loaded) return;
      material.displacementMap = null;
      material.needsUpdate = true;
    });
    if (loaded) {
      loaded.colorSpace = THREE.NoColorSpace;
      material.displacementMap = loaded;
    }
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
