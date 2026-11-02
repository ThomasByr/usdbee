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
  return EDITABLE_TYPES.has(value.type);
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
  const text = String(raw).trim();
  if (text === "") return { ok: false, error: "value is empty" };
  if (INT_TYPES.has(type)) {
    if (!/^[+-]?\d+$/.test(text)) return { ok: false, error: `"${text}" is not an integer` };
    const n = Number(text);
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
  // string, token, assetpath: pass the text through.
  return { ok: true, data: text };
}

export type CommitResult = { ok: true; value: ValuePayload } | { ok: false; error: string };

// Build the payload to send for an edit of `value` with draft text `raw`;
// the declared type always carries over unchanged.
export function commitEditedValue(value: ValuePayload, raw: string | boolean): CommitResult {
  const parsed = parseEditedValue(value.type, raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { type: value.type, data: parsed.data } };
}
