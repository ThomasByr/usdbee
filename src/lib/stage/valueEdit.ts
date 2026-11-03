import type { ValuePayload } from "./types";

// The value families the inspector can author: the scalar kinds
// value_payload_to_sdf (src-tauri/src/values.rs) converts back to sdf::Value.
// Arrays, vectors, quats, matrices, dicts and unsupported values render
// read-only until their editors land.
const EDITABLE_TYPES = new Set([
  "bool",
  "uchar",
  "int",
  "uint",
  "int64",
  "uint64",
  "half",
  "float",
  "double",
  "timecode",
  "string",
  "token",
  "assetpath",
]);

const INT_TYPES = new Set(["uchar", "int", "uint", "int64", "uint64"]);
const FLOAT_TYPES = new Set(["half", "float", "double", "timecode"]);

// The float3-family arrays the appearance editors author: one [r, g, b]
// element (0..1 floats). color3f[] attributes serialize with the
// color3f_array tag; float3[] and vec3f[] share the generic vec3f_array
// tag (the serializer refines the tag by declared color role only), so
// all three spellings are admitted here and in the backend converter.
const EDITABLE_COLOR_ARRAYS = new Set(["color3f_array", "vec3f_array", "float3_array"]);

// Exact ranges per integer family; out-of-range input is refused instead of
// authoring a wrapped value. The backend re-checks every bound exactly (JS
// numbers go imprecise past 2^53, so the backend is the authority there).
const INT_RANGES: Record<string, [number, number]> = {
  uchar: [0, 255],
  int: [-2147483648, 2147483647],
  uint: [0, 4294967295],
  int64: [-9223372036854775808, 9223372036854775807],
  uint64: [0, 18446744073709551615],
};

export function isEditableValue(value: ValuePayload): boolean {
  return EDITABLE_TYPES.has(value.type) || isColorArray(value);
}

// A color-array payload the editor takes: exactly one [r, g, b] triple of
// finite numbers. Longer arrays (meta primvars) render read-only.
export function isColorArray(value: ValuePayload): boolean {
  if (!EDITABLE_COLOR_ARRAYS.has(value.type)) return false;
  if (!Array.isArray(value.data) || value.data.length !== 1) return false;
  const [single] = value.data;
  if (!Array.isArray(single) || single.length !== 3) return false;
  return single.every(
    (component) => typeof component === "number" && Number.isFinite(component),
  );
}

// The hex spelling (#rrggbb, 8-bit grid) of the single color an editable
// array carries; null when the value is not an editable color array.
export function colorArrayHex(value: ValuePayload): string | null {
  if (!isColorArray(value)) return null;
  const channel = (component: number) =>
    Math.round(Math.min(1, Math.max(0, component)) * 255)
      .toString(16)
      .padStart(2, "0");
  const [r, g, b] = (value.data as [number, number, number][])[0];
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// Hex (#rgb or #rrggbb, with or without the leading #) to one [r, g, b]
// triple on the 8-bit grid, keeping the payload type for the round trip.
export function commitColorArray(value: ValuePayload, raw: string): CommitResult {
  const hex = String(raw).trim().replace(/^#/, "");
  if (!/^([\dA-Fa-f]{3})([\dA-Fa-f]{3})?$/.test(hex)) {
    return { ok: false, error: `"${raw}" is not a #rgb or #rrggbb hex color` };
  }
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const channel = (index: number) => parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
  return {
    ok: true,
    value: { type: value.type, data: [[channel(0), channel(1), channel(2)]] },
  };
}

export type ParseResult = { ok: true; data: number | string | boolean } | { ok: false; error: string };

// Parse the edited text (or checkbox state for bools) into the JSON `data`
// of a ValuePayload of the same type. Numbers reject non-numbers, integer
// families reject fractions and negative unsigned values; half precision
// rounding happens in the backend converter (f16 from f32).
export function parseEditedValue(type: string, raw: string | boolean): ParseResult {
  if (type === "bool") {
    if (typeof raw === "boolean") return { ok: true, data: raw };
    return { ok: false, error: "bool needs a checkbox value" };
  }
  if (!INT_TYPES.has(type) && !FLOAT_TYPES.has(type)) {
    // string, token, assetpath: whitespace and empty values are data.
    return { ok: true, data: String(raw) };
  }
  const text = String(raw).trim();
  if (text === "") return { ok: false, error: "value is empty" };
  if (INT_TYPES.has(type)) {
    if (!/^[+-]?\d+$/.test(text)) return { ok: false, error: `"${text}" is not an integer` };
    const n = Number(text);
    if (!Number.isSafeInteger(n)) {
      return { ok: false, error: `"${text}" is outside JavaScript's safe integer range` };
    }
    const [min, max] = INT_RANGES[type];
    if (n < min) {
      return { ok: false, error: `"${text}" is below the ${type} minimum ${min}` };
    }
    if (n > max) {
      return { ok: false, error: `"${text}" is above the ${type} maximum ${max}` };
    }
    return { ok: true, data: n };
  }
  if (FLOAT_TYPES.has(type)) {
    const n = Number(text);
    if (!Number.isFinite(n)) return { ok: false, error: `"${text}" is not a number` };
    return { ok: true, data: n };
  }
  return { ok: false, error: `unsupported editable type ${type}` };
}

export type CommitResult = { ok: true; value: ValuePayload } | { ok: false; error: string };

// Build the payload to send for an edit of `value` with draft text `raw`;
// the declared type always carries over unchanged.
export function commitEditedValue(value: ValuePayload, raw: string | boolean): CommitResult {
  const parsed = parseEditedValue(value.type, raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { type: value.type, data: parsed.data } };
}
