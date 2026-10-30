// Pure converter for the Rust `get_material_data` payload (materials.rs) —
// no Svelte, no invoke: MaterialInfo in, THREE.MeshPhysicalMaterial out. The
// texture loader is injected so Task 4 can wire convertFileSrc fetching;
// tests pass a stub. Fail-soft throughout: unknown texture inputs are
// skipped and a texture the loader cannot fetch falls back to base color.
import * as THREE from "three";
import type { MaterialInfo, PreviewSurface } from "../stage/types";

export type MaterialTextureLoader = (file_path: string) => THREE.Texture | null;

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
    applyTextures(material, surface, loadTexture);
    hasMap = material.map !== null;
    applyConstantColor(material, surface);
    if (surface.roughness !== null) material.roughness = surface.roughness;
    if (surface.metallic !== null) material.metalness = surface.metallic;
    if (surface.opacity !== null) {
      material.opacity = surface.opacity;
      material.transparent = surface.opacity < 1;
    }
  }

  applyFallbackColor(material, info, surface, hasMap, fallbackColor);
  return material;
}

function applyTextures(
  material: THREE.MeshPhysicalMaterial,
  surface: PreviewSurface,
  loadTexture: MaterialTextureLoader,
): void {
  for (const texture of surface.textures) {
    const loaded = loadTexture(texture.file_path);
    if (!loaded) continue;
    if (texture.input === "diffuseColor") material.map = loaded;
    else if (texture.input === "normal") material.normalMap = loaded;
    // unknown inputs are skipped per the brief
  }
}

// USD colors are linear and three.js stores working-space values linear, so
// the payload numbers map straight onto THREE.Color.
function applyConstantColor(
  material: THREE.MeshPhysicalMaterial,
  surface: PreviewSurface,
): void {
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
