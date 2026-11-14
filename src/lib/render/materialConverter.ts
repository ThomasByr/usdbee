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
  UdimTile,
  UvTransform,
  ValuePayload,
} from "../stage/types";
import { isExrPath, isKtx2Path } from "./textureLoaders";

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
    if (slot === "map" && texture.udim_tiles?.length) {
      attachAtlas(material, info, surface, texture, loadTexture, fallbackColor);
      continue;
    }
    // A failed load needs no undo: the slot still holds the authored constant
    // this convert applied (the fail-soft rule, now free). The catch keeps a
    // rejection out of the renderer.
    const source = resolvedTileInput(texture);
    loadTexture(source.file_path, () => {})
      .then((loaded) => attachSlot(material, info, surface, slot, source, loaded, fallbackColor))
      .catch(() => {});
  }
}

// The authored `<UDIM>` pattern is not fetchable, so a slot the atlas does not
// cover reads one concrete tile instead. shortcut: one tile per slot — a UDIM
// normal/roughness map renders tile 1001 everywhere; upgrade when the payload
// carries tiles for a non-diffuse input
function resolvedTileInput(input: TextureInput): TextureInput {
  const tiles = input.udim_tiles;
  if (!tiles?.length) return input;
  // Near the origin the rule answers 1001 when it exists, else the closest tile.
  const chosen = udimTileIndex(
    0.05,
    0.05,
    tiles.map((tile) => tile.tile),
  );
  const file = tiles.find((tile) => tile.tile === chosen) ?? tiles[0]!;
  return { ...input, file_path: file.file_path };
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
  loaded.colorSpace = colorSpace(input.color_space, slot, input.file_path, loaded.colorSpace);
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

// ---- UDIM atlas (F7) -------------------------------------------------------

// One fragment uniform pairs a tile's grid cell with its atlas layer. The full
// 10x10 grid would cost 200 vec4s of uniform space on top of MeshPhysicalMaterial.
const UDIM_MAX_TILES = 16;
const UDIM_GRID = 10;

// The UDIM convention: one full uv unit per tile, so `tile = 1001 + floor(u) +
// floor(v) * 10` and 1001 spans u,v in [0,1). Fallbacks, in order: the cell's own
// tile, else 1001 (Hydra's missing-tile answer) while the cell is inside the
// grid, else the nearest loaded cell (a uv outside the grid has no tile of its
// own). Ties, a non-finite uv and an empty set all end on 1001 or the lowest
// loaded tile, so the answer is never NaN. UDIM_HEADER mirrors this.
export const UDIM_TILE_BASE = 1001;

export function udimTileIndex(u: number, v: number, tiles: number[]): number {
  if (tiles.length === 0) return UDIM_TILE_BASE;
  const column = Math.floor(u);
  const row = Math.floor(v);
  const inside = column >= 0 && column < UDIM_GRID && row >= 0 && row < UDIM_GRID;
  const exact = UDIM_TILE_BASE + column + row * UDIM_GRID;
  const hasDefault = tiles.includes(UDIM_TILE_BASE);
  let best = hasDefault ? UDIM_TILE_BASE : Math.min(...tiles);
  // 1001 stands for every missing cell, so no non-exact tile may beat it.
  let bestDistance = inside && hasDefault ? 0.5 : Infinity;
  for (const tile of tiles) {
    if (inside && tile === exact) return tile;
    const distance = Math.max(
      Math.abs(((tile - UDIM_TILE_BASE) % UDIM_GRID) - column),
      Math.abs(Math.floor((tile - UDIM_TILE_BASE) / UDIM_GRID) - row),
    );
    if (distance < bestDistance) {
      best = tile;
      bestDistance = distance;
    }
  }
  return best;
}

// GLSL mirror of udimTileIndex plus the layer lookup: `usdbeeUdimCells` holds
// each layer's (column, row) and `usdbeeUdimHas1001` tells the loop whether a
// non-exact tile may beat the 1001 fallback (0.5 stands for "only an exact
// match wins"). `udimUv` is the SRT-transformed uv, so the cell comes straight
// from it — the same values the single-texture path samples, in atlas space.
export const UDIM_HEADER = /* glsl */ `
uniform sampler2DArray usdbeeUdimAtlas;
uniform mat3 usdbeeUdimTransform;
uniform int usdbeeUdimCount;
uniform int usdbeeUdimHas1001;
uniform int usdbeeUdimFallback;
uniform vec2 usdbeeUdimCells[ ${UDIM_MAX_TILES} ];
uniform int usdbeeUdimLayers[ ${UDIM_MAX_TILES} ];

int usdbeeUdimLayer( vec2 uv ) {
	vec2 cell = floor( uv );
	float exact = ${UDIM_TILE_BASE}.0 + cell.x + cell.y * ${UDIM_GRID}.0;
	bool inGrid = cell.x >= 0.0 && cell.x < ${UDIM_GRID}.0 && cell.y >= 0.0 && cell.y < ${UDIM_GRID}.0;
	int layer = usdbeeUdimFallback;
	float bestDistance = ( inGrid && usdbeeUdimHas1001 == 1 ) ? 0.5 : 1e9;
	for ( int i = 0; i < ${UDIM_MAX_TILES}; i ++ ) {
		if ( i >= usdbeeUdimCount ) break;
		vec2 tile = usdbeeUdimCells[ i ];
		float tileTile = ${UDIM_TILE_BASE}.0 + tile.x + tile.y * ${UDIM_GRID}.0;
		float tileDistance = ( inGrid && tileTile == exact ) ? 0.0 : max( abs( tile.x - cell.x ), abs( tile.y - cell.y ) );
		if ( tileDistance < bestDistance ) {
			bestDistance = tileDistance;
			layer = usdbeeUdimLayers[ i ];
		}
	}
	return layer;
}
`;

// The only fragment chunk replaced by the atlas branch. `sampler2DArray` takes a
// vec3, so the layer rides the third coordinate and the intra-tile uv is the
// fractional part of the transformed uv — one tile per full uv unit.
export const UDIM_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
	vec2 udimUv = ( usdbeeUdimTransform * vec3( vMapUv, 1.0 ) ).xy;
	vec4 sampledDiffuseColor = texture(
		usdbeeUdimAtlas,
		vec3( fract( udimUv ), float( usdbeeUdimLayer( udimUv ) ) )
	);
	diffuseColor *= sampledDiffuseColor;
#endif
`;

interface AtlasSource {
  tile: number;
  file_path: string;
  texture: THREE.Texture;
}

interface AtlasLayerInfo {
  tile: number;
  layer: number;
}

interface BuiltAtlas {
  atlas: THREE.DataArrayTexture;
  layers: AtlasLayerInfo[];
}

// One array texture per tile set, shared by every material that binds that set:
// a material is created per prim, and a 4-tile 2K set is ~67 MB, so N prims on
// one tiled skin would otherwise upload N copies. The per-material uv transform
// lives in that material's own uniforms, so sharing costs nothing.
const atlases = new Map<string, BuiltAtlas>();

// The atlas bakes one colour space from its first tile, so the space resolved
// for this material's authored input is part of the identity: two materials on
// one tile set with different authored spaces need different atlases. A KTX2
// tile's own stamped space rides its path, which is already in the key.
function atlasKey(input: TextureInput, tiles: UdimTile[]): string {
  const space = colorSpace(input.color_space, "map", input.file_path, THREE.NoColorSpace);
  return [space, ...tiles.map((tile) => `${tile.tile}:${tile.file_path}`)].join("|");
}

// Called where the texture cache is cleared (a new scene load): the materials
// that sampled these atlases are already disposed.
export function clearUdimAtlases(): void {
  for (const built of atlases.values()) built.atlas.dispose();
  atlases.clear();
}

// Loads every tile, then stacks the ones that decoded into one array texture.
// The material keeps its authored constant until this resolves and keeps it for
// good when nothing decoded, so a tile can only ever lose its own pixels.
function attachAtlas(
  material: THREE.MeshPhysicalMaterial,
  info: MaterialInfo,
  surface: PreviewSurface,
  input: TextureInput,
  loadTexture: MaterialTextureLoader,
  fallbackColor: string | null,
): void {
  const tiles = [...(input.udim_tiles ?? [])].sort((a, b) => a.tile - b.tile);
  const key = atlasKey(input, tiles);
  const cached = atlases.get(key);
  if (cached) {
    applyAtlas(material, info, surface, input, cached, fallbackColor);
    return;
  }
  Promise.allSettled(tiles.map((tile) => loadTexture(tile.file_path, () => {})))
    .then((results) => {
      const sources: AtlasSource[] = [];
      results.forEach((result, index) => {
        const tile = tiles[index]!;
        if (result.status === "fulfilled") sources.push({ ...tile, texture: result.value });
      });
      if (sources.length === 0) return; // every tile failed: the constant stands
      const built = buildAtlas(sources, input);
      if (!built) return;
      if (built.layers.length > UDIM_MAX_TILES) {
        console.warn(
          `usdbee: udim set ${input.file_path} has ${built.layers.length} tiles, the atlas reads ${UDIM_MAX_TILES}`,
        );
      }
      // A tile that failed is not cached as missing: the next material would
      // inherit the hole, and a retry is the fail-soft answer.
      if (built.layers.length === tiles.length) atlases.set(key, built);
      applyAtlas(material, info, surface, input, built, fallbackColor);
    })
    .catch(() => {});
}

// Row-major RGBA pixels of one decoded tile. Image-backed tiles (PNG/JPEG) can
// only be read through a canvas; data-backed ones (EXR) already hold their array.
interface TilePixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
  type: THREE.TextureDataType;
}

function tilePixels(texture: THREE.Texture): TilePixels | null {
  const image = texture.image as { data?: ArrayLike<number>; width?: number; height?: number } | null;
  if (!image) return null;
  const width = image.width ?? 0;
  const height = image.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  // shortcut: only a raw RGBA array joins the atlas — a KTX2 tile keeps its
  // pixels as a mipmap array, not raw RGBA, so it cannot enter a
  // DataArrayTexture without a GPU-side transcode and a KTX2-only UDIM set
  // falls back to the authored constant; a single-channel EXR tile
  // (RedFormat, w*h samples) also fails the RGBA length check and drops.
  // Upgrade when a KTX2 or single-channel UDIM asset appears — transcode the
  // tiles to one shared RGBA format first
  if (image.data && image.data.length >= width * height * 4) {
    return { data: image.data, width, height, type: texture.type };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(image as unknown as CanvasImageSource, 0, 0);
  } catch {
    return null;
  }
  return {
    data: context.getImageData(0, 0, width, height).data,
    width,
    height,
    type: THREE.UnsignedByteType,
  };
}

// One layer per tile that decoded at the size the first tile set. A mismatched
// tile cannot join a fixed-size array texture, so it is dropped rather than
// resizing the atlas under the layers already copied.
function buildAtlas(sources: AtlasSource[], input: TextureInput): BuiltAtlas | null {
  const kept: { source: AtlasSource; pixels: TilePixels }[] = [];
  for (const source of sources) {
    const pixels = tilePixels(source.texture);
    const Target = pixels ? PIXEL_ARRAYS[pixels.type] : undefined;
    if (!pixels || !Target) {
      console.warn(`usdbee: udim tile ${source.tile} has no readable RGBA pixels`);
      continue;
    }
    const head = kept[0]?.pixels;
    if (head && (head.width !== pixels.width || head.height !== pixels.height || head.type !== pixels.type)) {
      // shortcut: the first tile's layout wins for the whole atlas — a mixed-size
      // tile set has no single array-texture depth; upgrade when a real asset
      // ships tiles at different resolutions
      console.warn(
        `usdbee: udim tile ${source.tile} rejected: layout differs from tile ${kept[0]!.source.tile}`,
      );
      continue;
    }
    kept.push({ source, pixels });
  }
  const head = kept[0];
  if (!head) return null;
  const { width, height, type } = head.pixels;
  const stride = width * height * 4;
  const Target = PIXEL_ARRAYS[type]!;
  const data = new Target(stride * kept.length);
  kept.forEach((entry, layer) =>
    copyTilePixels(entry.pixels, entry.source.texture.flipY, data, layer * stride),
  );

  const atlas = new THREE.DataArrayTexture(data, width, height, kept.length);
  atlas.format = THREE.RGBAFormat;
  atlas.type = type;
  atlas.colorSpace = colorSpace(
    input.color_space,
    "map",
    head.source.file_path,
    head.source.texture.colorSpace,
  );
  // shortcut: no mip chain (a 3D mip pass needs GPU work), so a minified tile
  // aliases; float and half-float tiles stay nearest because linear filtering of
  // one needs OES_texture_float_linear
  atlas.generateMipmaps = false;
  atlas.minFilter = type === THREE.UnsignedByteType ? THREE.LinearFilter : THREE.NearestFilter;
  atlas.magFilter = atlas.minFilter;
  // shortcut: one sampler state serves every layer, so sampling clamps at a
  // tile's edge — a per-tile wrap mode is not modelled
  atlas.wrapS = THREE.ClampToEdgeWrapping;
  atlas.wrapT = THREE.ClampToEdgeWrapping;
  atlas.needsUpdate = true;
  return { atlas, layers: kept.map((entry, layer) => ({ tile: entry.source.tile, layer })) };
}

// The types an atlas can hold: the decoders hand out bytes for images, half
// floats for EXR (its own container) and floats for a raw float texture.
const PIXEL_ARRAYS: Partial<
  Record<THREE.TextureDataType, Uint8ArrayConstructor | Uint16ArrayConstructor | Float32ArrayConstructor>
> = {
  [THREE.UnsignedByteType]: Uint8Array,
  [THREE.HalfFloatType]: Uint16Array,
  [THREE.FloatType]: Float32Array,
};

// An array texture uploads as raw rows, so the row order of a `flipY` texture
// (TextureLoader's default) has to be reversed here — the GPU flip only applies
// to image uploads.
function copyTilePixels(
  pixels: TilePixels,
  flipY: boolean,
  target: Uint8Array | Uint16Array | Float32Array,
  offset: number,
): void {
  const rowLength = pixels.width * 4;
  for (let row = 0; row < pixels.height; row++) {
    const from = (flipY ? pixels.height - 1 - row : row) * rowLength;
    const to = offset + row * rowLength;
    for (let i = 0; i < rowLength; i++) target[to + i] = pixels.data[from + i]!;
  }
}

// The atlas is sampled by the patched chunk, so the material's map slot gets a
// 1x1 stand-in: it exists only to compile `vMapUv` in. One instance serves every
// atlas material because nothing reads its pixels, and its own matrix stays
// identity — three copies `material.map.matrix` into `mapTransform`, so a shared
// stand-in could not carry a per-material SRT. That SRT rides the
// `usdbeeUdimTransform` uniform instead, built by the same applyUvTransform.
const UDIM_STAND_IN = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
UDIM_STAND_IN.colorSpace = THREE.NoColorSpace;
UDIM_STAND_IN.needsUpdate = true;

function udimTransform(transform: UvTransform | null | undefined): THREE.Matrix3 {
  // A bare Texture has no image, so it is never uploaded; it only runs three's
  // own SRT math and is collected.
  const scratch = new THREE.Texture();
  applyUvTransform(scratch, transform);
  scratch.updateMatrix();
  return scratch.matrix.clone();
}

function applyAtlas(
  material: THREE.MeshPhysicalMaterial,
  info: MaterialInfo,
  surface: PreviewSurface,
  input: TextureInput,
  built: BuiltAtlas,
  fallbackColor: string | null,
): void {
  neutralizeSlot(material, "map");
  material.map = UDIM_STAND_IN;
  applyValueScale(material, "map", input);
  applyFallbackColor(material, info, surface, true, fallbackColor);

  const indexed = built.layers.slice(0, UDIM_MAX_TILES);
  const cells = new Float32Array(UDIM_MAX_TILES * 2);
  const layers = new Int32Array(UDIM_MAX_TILES);
  indexed.forEach((entry, i) => {
    cells[i * 2] = (entry.tile - UDIM_TILE_BASE) % UDIM_GRID;
    cells[i * 2 + 1] = Math.floor((entry.tile - UDIM_TILE_BASE) / UDIM_GRID);
    layers[i] = entry.layer;
  });
  const fallback = indexed.find((entry) => entry.tile === UDIM_TILE_BASE);
  const uniforms: Record<string, THREE.IUniform> = {
    usdbeeUdimAtlas: { value: built.atlas },
    usdbeeUdimTransform: { value: udimTransform(input.uv_transform) },
    usdbeeUdimCount: { value: indexed.length },
    usdbeeUdimHas1001: { value: fallback ? 1 : 0 },
    usdbeeUdimFallback: { value: fallback?.layer ?? indexed[0]!.layer },
    usdbeeUdimCells: { value: cells },
    usdbeeUdimLayers: { value: layers },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader =
      UDIM_HEADER + shader.fragmentShader.replace("#include <map_fragment>", UDIM_MAP_FRAGMENT);
  };
  material.needsUpdate = true;
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
function colorSpace(
  token: string | null | undefined,
  slot: TextureSlot,
  filePath: string,
  loadedSpace: string,
): THREE.ColorSpace {
  if (token === "raw") return THREE.NoColorSpace;
  // shortcut: an authored "sRGB" on a half-float EXR still uploads linear —
  // three's verifyColorSpace refuses sRGB for HalfFloatType (only RGBA8 gets an
  // sRGB internal format), so the token stays on the texture but the GPU
  // samples linear; upgrade when an EXR authored sRGB must display sRGB, or a
  // non-half-float EXR path appears
  if (token === "sRGB") return THREE.SRGBColorSpace;
  // shortcut: a space the loader stamped wins over the per-slot default, but
  // only for KTX2 — its header names its own primaries and transfer function,
  // which beats the slot's guess about what the file holds. EXRLoader stamps
  // LinearSRGBColorSpace on every decode, so an ungated rule would kill the
  // .exr case below. A KTX2 header with unspecified primaries reads as
  // NoColorSpace, i.e. indistinguishable from unstamped and back to the slot
  // default. Upgrade when a ktx2 must override its own header.
  if (loadedSpace !== THREE.NoColorSpace && isKtx2Path(filePath)) return loadedSpace as THREE.ColorSpace;
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
