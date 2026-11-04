import { describe, expect, it } from "vitest";
import type { LayerInfo } from "./types";
import { layerDisplayName, layerTextRevisionAction, layerTextStageChangedAction } from "./layerText";

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

describe("layerTextStageChangedAction", () => {
  it("ignores the stage change caused by the editor's own save", () => {
    // Mid-save the draft is still dirty against the old base revision, but
    // the event's revision matches the one the save marked before importing.
    expect(layerTextStageChangedAction(4, 5, true, 5)).toBe("none");
    expect(layerTextStageChangedAction(4, 5, false, 5)).toBe("none");
  });

  it("still flags a conflict for a genuinely external change", () => {
    expect(layerTextStageChangedAction(4, 5, true, null)).toBe("conflict");
  });

  it("still flags a conflict for an external change with a stale self-save mark", () => {
    expect(layerTextStageChangedAction(4, 5, true, 4)).toBe("conflict");
  });

  it("reloads a clean draft for an external change", () => {
    expect(layerTextStageChangedAction(4, 5, false, null)).toBe("reload");
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
