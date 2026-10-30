import { describe, expect, it } from "vitest";
import type { ValuePayload } from "./types";
import { formatValue } from "./valueFormat";

const payload = (type: string, data: unknown): ValuePayload => ({ type, data });

describe("formatValue", () => {
  it("renders unauthored", () => {
    expect(formatValue(payload("unauthored", null))).toBe("unauthored");
    expect(formatValue(payload("float", null))).toBe("unauthored");
  });

  it("renders scalars: bool, int, float, token, string, assetpath", () => {
    expect(formatValue(payload("bool", true))).toBe("true");
    expect(formatValue(payload("int", -3))).toBe("-3");
    expect(formatValue(payload("float", 1.5))).toBe("1.5");
    expect(formatValue(payload("token", "roughness"))).toBe("roughness");
    expect(formatValue(payload("string", "a b"))).toBe("a b");
    expect(formatValue(payload("assetpath", "./tex.png"))).toBe("./tex.png");
  });

  it("trims float noise to 6 significant digits", () => {
    expect(formatValue(payload("float", 0.30000001192092896))).toBe("0.3");
    expect(formatValue(payload("double", 1234.567890123))).toBe("1234.57");
  });

  it("renders matrices as 4x4 rows", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(formatValue(payload("matrix4d", identity))).toBe(
      "[1, 0, 0, 0]\n[0, 1, 0, 0]\n[0, 0, 1, 0]\n[0, 0, 0, 1]",
    );
  });

  it("renders matrix2d/3d at their own row size", () => {
    expect(formatValue(payload("matrix2d", [1, 2, 3, 4]))).toBe("[1, 2]\n[3, 4]");
    expect(formatValue(payload("matrix3d", [1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(
      "[1, 2, 3]\n[4, 5, 6]\n[7, 8, 9]",
    );
  });

  it("renders arrays as comma-separated brackets", () => {
    expect(formatValue(payload("int_array", [1, 2, 3]))).toBe("[1, 2, 3]");
    expect(formatValue(payload("float_array", [0.5, 2]))).toBe("[0.5, 2]");
    expect(formatValue(payload("token_array", ["a", "b"]))).toBe("[a, b]");
  });

  it("renders path_array like other arrays", () => {
    expect(formatValue(payload("path_array", ["/A", "/B/C"]))).toBe("[/A, /B/C]");
  });

  it("renders matrix arrays as stacked matrices", () => {
    const m = [1, 0, 0, 1];
    expect(formatValue(payload("matrix2d_array", [m, m]))).toBe("[1, 0]\n[0, 1]\n\n[1, 0]\n[0, 1]");
  });

  it("renders empty arrays", () => {
    expect(formatValue(payload("int_array", []))).toBe("[]");
  });

  it("renders unsupported via its string representation", () => {
    expect(formatValue(payload("unsupported", "<opaque>"))).toBe("<opaque>");
  });

  it("renders vec and color payloads as arrays", () => {
    expect(formatValue(payload("vec3f", [1, 2, 3]))).toBe("[1, 2, 3]");
    expect(formatValue(payload("color3f", [0.5, 0.5, 0.5]))).toBe("[0.5, 0.5, 0.5]");
  });
});
