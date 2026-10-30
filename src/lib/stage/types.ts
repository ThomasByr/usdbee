// TS mirrors of the Tauri backend serde types (src-tauri/src/stage.rs and
// src-tauri/src/values.rs). Keys are snake_case to match serde's field
// names exactly — no rename attrs are set on the Rust side, so field names
// serialize verbatim (already snake_case).

export interface StageInfo {
  root_layer: string;
  time_codes_per_second: number;
  start_time_code: number;
  end_time_code: number;
  composition_errors: string[];
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
  // Rust [f64; 16], row-major 4x4; null when no xformOpOrder is authored.
  local_transform: number[] | null;
  world_transform: number[] | null;
}
