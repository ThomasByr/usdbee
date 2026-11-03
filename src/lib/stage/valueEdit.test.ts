import { describe, expect, it } from "vitest";
import type { ValuePayload } from "./types";
import {
  colorArrayHex,
  commitColorArray,
  commitEditedValue,
  isColorArray,
  isEditableValue,
  parseEditedValue,
} from "./valueEdit";

const payload = (type: string, data: unknown): ValuePayload => ({ type, data });

describe("isEditableValue", () => {
  it("accepts the scalar families", () => {
    for (const type of [
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
    ]) {
      expect(isEditableValue(payload(type, 1))).toBe(true);
    }
  });

  it("rejects arrays, vectors, matrices, dicts and unauthored", () => {
    for (const type of [
      "int_array",
      "float_array",
      "vec3f",
      "vec3d",
      "color3f",
      "quatf",
      "matrix4d",
      "matrix4d_array",
      "path_array",
      "dict",
      "unsupported",
      "unauthored",
      // The editable color-array tags need a valid 1-element color too.
      "color3f_array",
      "vec3f_array",
      "float3_array",
    ]) {
      expect(isEditableValue(payload(type, null))).toBe(false);
    }
  });

  it("admits exactly the two display-color array families at one element", () => {
    for (const type of ["color3f_array", "vec3f_array", "float3_array"]) {
      const value = payload(type, [[0.5, 0.5, 0.5]]);
      expect(isEditableValue(value)).toBe(true);
      expect(isColorArray(value)).toBe(true);
    }
    expect(isEditableValue(payload("int_array", [[1, 2, 3]]))).toBe(false);
  });

  it("rejects the color-array tags on any other shape", () => {
    for (const data of [
      [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      [[0.1, 0.2]],
      [[0.1, 0.2, 0.3, 0.4]],
      [["r", "g", "b"]],
      [[NaN, 0, 0]],
      [0.1, 0.2, 0.3],
      [],
    ]) {
      for (const type of ["color3f_array", "vec3f_array", "float3_array"]) {
        expect(isColorArray(payload(type, data))).toBe(false);
        expect(isEditableValue(payload(type, data))).toBe(false);
      }
    }
  });
});

describe("color array hex helpers", () => {
  const redPayload: ValuePayload = payload("color3f_array", [[1, 0, 0]]);

  it("hex-decodes to an 8-bit grid triple", () => {
    expect(commitColorArray(redPayload, "#ff0000")).toEqual({
      ok: true,
      value: { type: "color3f_array", data: [[1, 0, 0]] },
    });
    expect(commitColorArray(redPayload, "#4080c0")).toEqual({
      ok: true,
      value: { type: "color3f_array", data: [[64 / 255, 128 / 255, 192 / 255]] },
    });
  });

  it("commit keeps the payload tag for the round trip", () => {
    const result = commitColorArray(redPayload, "#f00");
    expect(result.ok && result.value.type).toBe("color3f_array");
  });

  it("rejects garbage hex without producing a payload", () => {
    for (const raw of ["", "nothex", "#11223", "#12345", "ffff0", "#zzz"]) {
      const result = commitColorArray(redPayload, raw);
      expect(result.ok).toBe(false);
    }
  });

  it("recomputes the same hex from the composed read", () => {
    expect(colorArrayHex(redPayload)).toBe("#ff0000");
    expect(colorArrayHex(payload("vec3f_array", [[64 / 255, 128 / 255, 192 / 255]]))).toBe(
      "#4080c0",
    );
    expect(colorArrayHex(payload("color3f_array", null))).toBeNull();
  });
});

describe("parseEditedValue", () => {
  it("parses floats and doubles, rejecting non-numbers", () => {
    expect(parseEditedValue("float", "2.5")).toEqual({ ok: true, data: 2.5 });
    expect(parseEditedValue("double", "-1.25e2")).toEqual({ ok: true, data: -125 });
    expect(parseEditedValue("float", "abc").ok).toBe(false);
    expect(parseEditedValue("half", "1z").ok).toBe(false);
    expect(parseEditedValue("float", "").ok).toBe(false);
  });

  it("accepts half like any float (the backend rounds to f16)", () => {
    expect(parseEditedValue("half", "0.1")).toEqual({ ok: true, data: 0.1 });
  });

  it("requires integers for the integer families", () => {
    expect(parseEditedValue("int", "3")).toEqual({ ok: true, data: 3 });
    expect(parseEditedValue("uint", "7")).toEqual({ ok: true, data: 7 });
    expect(parseEditedValue("int64", "-9")).toEqual({ ok: true, data: -9 });
    expect(parseEditedValue("uint64", "12").ok).toBe(true);
    expect(parseEditedValue("uchar", "0").ok).toBe(true);
    expect(parseEditedValue("int", "1.5").ok).toBe(false);
    expect(parseEditedValue("uint", "-1").ok).toBe(false);
    expect(parseEditedValue("uint", "abc").ok).toBe(false);
  });

  it("rejects integers outside their family range instead of wrapping", () => {
    // uchar 0-255
    expect(parseEditedValue("uchar", "255").ok).toBe(true);
    expect(parseEditedValue("uchar", "256").ok).toBe(false);
    expect(parseEditedValue("uchar", "-1").ok).toBe(false);
    // int, i32
    expect(parseEditedValue("int", "2147483647").ok).toBe(true);
    expect(parseEditedValue("int", "-2147483648").ok).toBe(true);
    expect(parseEditedValue("int", "2147483648").ok).toBe(false);
    expect(parseEditedValue("int", "-2147483649").ok).toBe(false);
    // uint, u32
    expect(parseEditedValue("uint", "4294967295").ok).toBe(true);
    expect(parseEditedValue("uint", "4294967296").ok).toBe(false);
    // int64 / uint64 outside the JS-safe range are rejected, never rounded.
    expect(parseEditedValue("int64", "9223372036854775807").ok).toBe(false);
    expect(parseEditedValue("int64", "-9223372036854775808").ok).toBe(false);
    expect(parseEditedValue("int64", "92233720368547758080").ok).toBe(false);
    expect(parseEditedValue("uint64", "18446744073709551615").ok).toBe(false);
    expect(parseEditedValue("uint64", "184467440737095516160").ok).toBe(false);
  });

  it("rejects integers that Number cannot represent exactly", () => {
    const result = parseEditedValue("int64", "9007199254740993");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("safe integer");
    expect(parseEditedValue("int64", "9007199254740991")).toEqual({ ok: true, data: 9007199254740991 });
  });

  it("parses bools from checkbox state", () => {
    expect(parseEditedValue("bool", true)).toEqual({ ok: true, data: true });
    expect(parseEditedValue("bool", false)).toEqual({ ok: true, data: false });
    expect(parseEditedValue("bool", "maybe").ok).toBe(false);
  });

  it("passes token, string and assetpath text through unchanged", () => {
    expect(parseEditedValue("token", "prop")).toEqual({ ok: true, data: "prop" });
    expect(parseEditedValue("string", "  a b  ")).toEqual({ ok: true, data: "  a b  " });
    expect(parseEditedValue("string", "")).toEqual({ ok: true, data: "" });
    expect(parseEditedValue("assetpath", " ./tex.png ")).toEqual({ ok: true, data: " ./tex.png " });
  });
});

describe("commitEditedValue", () => {
  it("builds a payload that keeps the declared type", () => {
    expect(commitEditedValue(payload("float", 1), "2.5")).toEqual({
      ok: true,
      value: { type: "float", data: 2.5 },
    });
    expect(commitEditedValue(payload("token", "a"), "b")).toEqual({
      ok: true,
      value: { type: "token", data: "b" },
    });
  });

  it("reports parse failures without mutating the payload", () => {
    const result = commitEditedValue(payload("float", 1), "abc");
    expect(result.ok).toBe(false);
  });
});
