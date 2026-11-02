import { describe, expect, it } from "vitest";
import type { ValuePayload } from "./types";
import { commitEditedValue, isEditableValue, parseEditedValue } from "./valueEdit";

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
    ]) {
      expect(isEditableValue(payload(type, null))).toBe(false);
    }
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

  it("parses bools from checkbox state", () => {
    expect(parseEditedValue("bool", true)).toEqual({ ok: true, data: true });
    expect(parseEditedValue("bool", false)).toEqual({ ok: true, data: false });
    expect(parseEditedValue("bool", "maybe").ok).toBe(false);
  });

  it("passes token, string and assetpath text through", () => {
    expect(parseEditedValue("token", "prop")).toEqual({ ok: true, data: "prop" });
    expect(parseEditedValue("string", "a b")).toEqual({ ok: true, data: "a b" });
    expect(parseEditedValue("assetpath", "./tex.png")).toEqual({ ok: true, data: "./tex.png" });
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
