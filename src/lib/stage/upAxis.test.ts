import { describe, expect, it } from "vitest";

import { upAxisRotation } from "./upAxis";

describe("upAxisRotation", () => {
  it("rotates Z-up stages -90 degrees about X", () => {
    expect(upAxisRotation("Z")).toBe(-Math.PI / 2);
  });

  it("leaves Y-up stages unrotated", () => {
    expect(upAxisRotation("Y")).toBe(0);
  });

  it("treats unknown up axes as Y (USD spec default)", () => {
    expect(upAxisRotation("")).toBe(0);
    expect(upAxisRotation("X")).toBe(0);
  });
});
