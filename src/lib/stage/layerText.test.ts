import { describe, expect, it } from "vitest";
import type { LayerInfo } from "./types";
import { layerDisplayName, layerTextRevisionAction } from "./layerText";

const layer = (identifier: string, is_session = false): LayerInfo => ({
  identifier,
  original_path: null,
  is_session,
});

describe("layerTextRevisionAction", () => {
  it("keeps a current draft unchanged", () => {
    expect(layerTextRevisionAction(4, 4, true)).toBe("none");
    expect(layerTextRevisionAction(4, 4, false)).toBe("none");
  });

  it("reloads a clean draft when the stage advances", () => {
    expect(layerTextRevisionAction(4, 5, false)).toBe("reload");
  });

  it("blocks a dirty draft with a conflict when the stage advances", () => {
    expect(layerTextRevisionAction(4, 5, true)).toBe("conflict");
  });
});

describe("layerDisplayName", () => {
  it("labels the session layer", () => {
    expect(layerDisplayName(layer("/cache/sessions/session-123-0.usda", true))).toBe("Session layer");
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
