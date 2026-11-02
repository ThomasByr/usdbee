import { describe, expect, it } from "vitest";
import type { LayerInfo } from "./types";
import { layerDisplayName } from "./layerText";

const layer = (identifier: string, is_session = false): LayerInfo => ({
  identifier,
  original_path: null,
  is_session,
});

describe("layerDisplayName", () => {
  it("labels the session layer", () => {
    expect(
      layerDisplayName(
        layer("/cache/sessions/session-123-0.usda", true),
      ),
    ).toBe("Session layer");
  });

  it("labels a file-backed layer by its file name", () => {
    expect(layerDisplayName(layer("/home/user/scene/basic.usda"))).toBe("basic.usda");
  });

  it("handles windows-style separators", () => {
    expect(layerDisplayName(layer("C:\\assets\\scene.usdc"))).toBe("scene.usdc");
  });

  it("falls back to the whole identifier when it ends in a separator", () => {
    expect(layerDisplayName(layer("/odd/path/"))).toBe("/odd/path/");
  });
});
