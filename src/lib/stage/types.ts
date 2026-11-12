// TS mirrors of the Tauri backend serde types (src-tauri/src/stage.rs and
// src-tauri/src/values.rs). Keys are snake_case to match serde's field
// names exactly — no rename attrs are set on the Rust side, so field names
// serialize verbatim (already snake_case).

// Rust stage.rs::EditTargetInfo / LayerInfo / LayerSaveRequest — the
// Phase 3 editing surface (edit target switching, dirty layers, saving).
export interface EditTargetInfo {
  layer_identifier: string;
  is_session: boolean;
  // True when the stage was opened from a .usdz package (direct or via the
  // dialog extraction flow): saving layers is refused and the UI offers
  // Save As usdz instead (the backend command itself accepts any stage).
  is_usdz_stage: boolean;
}

export interface LayerInfo {
  identifier: string;
  // Where the layer was read from; null for anonymous layers.
  original_path: string | null;
  is_session: boolean;
}

export interface LayerSaveRequest {
  identifier: string;
  path: string;
}

// Rust stage.rs::UndoState — undo/redo availability (Phase 3 Task 5).
export interface UndoState {
  can_undo: boolean;
  can_redo: boolean;
}

export interface StageInfo {
  // The keyed stage map's id (first id is 1); 0 means "no stage" on the
  // frontend. Every stage-scoped command takes it as its stage_id param.
  stage_id: number;
  root_layer: string;
  time_codes_per_second: number;
  start_time_code: number;
  end_time_code: number;
  composition_errors: string[];
  // "Y" or "Z"; the backend defaults anything unreadable to "Y".
  up_axis: string;
}

// Rust stage.rs::StageSummary — one open stage as list_stages reports it.
// dirty_count is the number of layers with unsaved edits.
export interface StageSummary {
  stage_id: number;
  root_identifier: string;
  dirty_count: number;
}

// The payload of the usd-stage-changed event: which stage changed and
// which prim paths were touched.
export interface StageChangedEvent {
  stage_id: number;
  paths: string[];
}

export interface PrimNode {
  path: string;
  name: string;
  type_name: string;
  kind: string;
  is_active: boolean;
  is_instance: boolean;
  is_abstract: boolean;
  children: PrimNode[];
}

// Rust stage.rs::RenderNode — render manifest node (Phase 2). `transform`
// and each entry of `instances` are [f64; 16], row-major 4x4 in the USD
// row-vector convention (translation in the last row), same as
// PrimDetails.local_transform.
export interface RenderNode {
  path: string;
  name: string;
  type_name: string;
  has_geometry: boolean;
  animated: boolean;
  // The node's OWN geometry attrs (points/normals/widths/primvars, Task 6
  // ruling) have authored time samples — per-step geometry refetch happens
  // only for these; `animated` additionally covers transform motion.
  geometry_animated: boolean;
  material: string | null;
  instances: number[][];
  transform: number[];
  visible: boolean;
  children: RenderNode[];
}

// Rust tessellation.rs::pack_geometry header — first 20 bytes of the
// get_geometry_data payload, little-endian. flags: bit0 has_normals,
// bit1 has_uvs, bit2 has_colors.
export interface GeometryHeader {
  magic: number;
  version: number;
  vertex_count: number;
  index_count: number;
  flags: number;
}

// serde_json::Value — arbitrary JSON (number, string, bool, null, array...).
export interface ValuePayload {
  type: string;
  data: unknown;
  truncated?: boolean;
  count?: number;
}

// Rust materials.rs::UvTransform — the UsdTransform2d feeding a texture's
// `st`, composed as `result = in * scale * rotate + translation` (rotation
// counter-clockwise in degrees around the origin).
export interface UvTransform {
  scale: number[];
  translation: number[];
  rotation: number;
}

// Rust materials.rs::TextureInfo — a texture outside the per-input list
// (the normal map): its file path and the primvar its UVs come from.
export interface TextureInfo {
  file_path: string;
  st_primvar: string;
  wrap_s?: string | null;
  wrap_t?: string | null;
  uv_transform?: UvTransform | null;
  value_scale?: number[] | null;
  value_bias?: number[] | null;
  color_space?: string | null;
}

// Rust materials.rs::TextureInput — one PreviewSurface input fed by a
// UsdUVTexture. `file_path` is frontend-fetchable when the file exists,
// else the unresolved spelling (fetch it and fall back on failure).
export interface TextureInput {
  input: string;
  file_path: string;
  st_primvar: string;
  wrap_s?: string | null;
  wrap_t?: string | null;
  uv_transform?: UvTransform | null;
  value_scale?: number[] | null;
  value_bias?: number[] | null;
  color_space?: string | null;
}

// Rust materials.rs::PreviewSurface — serialized UsdPreviewSurface channels.
// Unauthored channels fold the USD node definition's defaults (the converter
// applies no three.js default to a found UsdPreviewSurface).
// The widened channels carry serde(default) on the Rust side, so an older
// payload may omit them: undefined and null both mean "unauthored".
export interface PreviewSurface {
  diffuse_color: ValuePayload | null;
  roughness: number | null;
  metallic: number | null;
  opacity: number | null;
  normal: TextureInfo | null;
  textures: TextureInput[];
  emissive_color?: ValuePayload | null;
  specular_color?: ValuePayload | null;
  clearcoat?: number | null;
  clearcoat_roughness?: number | null;
  opacity_threshold?: number | null;
  ior?: number | null;
  // Serialized for completeness; three.js has no occlusion scalar slot.
  occlusion?: number | null;
}

// Rust materials.rs::Displacement — the material's displacement terminal: a
// scale from an authored constant, or the file a UsdUVTexture feeds it.
// `st_primvar` names the UV set a map would read, authored or not.
export interface Displacement {
  scale?: number | null;
  file_path?: string | null;
  st_primvar: string;
}

// Rust materials.rs::MaterialInfo — get_material_data payload. `name` is
// the material prim name (or the prim name when unbound); `surface` is null
// when no UsdPreviewSurface is found (unbound or unknown shader id).
// `displacement`/`has_volume` carry serde(default), so an older payload may
// omit them.
export interface MaterialInfo {
  name: string;
  surface: PreviewSurface | null;
  displacement?: Displacement | null;
  has_volume?: boolean;
}

export interface AttributeInfo {
  name: string;
  type_name: string;
  variability: string;
  authored: boolean;
  value: ValuePayload;
}

export interface VariantSetInfo {
  name: string;
  authored_selection: string | null;
  options: string[];
}

export interface PrimDetails {
  path: string;
  type_name: string;
  kind: string;
  is_active: boolean;
  is_instance: boolean;
  is_abstract: boolean;
  instance_of: string | null;
  attributes: AttributeInfo[];
  // Rust Vec<(String, ValuePayload)>: serde serializes a tuple as a JSON
  // array, so this is a list of [field, value] pairs, not an object.
  metadata: [string, ValuePayload][];
  variant_sets: VariantSetInfo[];
  composition_arcs: string[];
  // Rust [f64; 16], row-major 4x4; identity for a prim without an authored
  // xformOpOrder; null only when an op in the chain cannot be evaluated.
  local_transform: number[] | null;
  world_transform: number[] | null;
}
