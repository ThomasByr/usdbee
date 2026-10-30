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

// serde_json::Value — arbitrary JSON (number, string, bool, null, array...).
export interface ValuePayload {
  type: string;
  data: unknown;
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
