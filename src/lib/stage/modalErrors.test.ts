import { describe, expect, it } from "vitest";
import { stageModalContent, type StageErrorInput } from "./modalErrors";

const base: StageErrorInput = { status: "idle", error: null, compositionErrors: [] };

describe("stageModalContent", () => {
  it("returns null when the stage is clean", () => {
    expect(stageModalContent(base)).toBeNull();
    expect(stageModalContent({ ...base, status: "ready" })).toBeNull();
    expect(stageModalContent({ ...base, status: "loading" })).toBeNull();
    expect(stageModalContent({ ...base, status: "ready", compositionNotices: [] })).toBeNull();
  });

  it("returns one error line for a stage-open failure", () => {
    expect(stageModalContent({ ...base, status: "error", error: "Invalid stage description" })).toEqual({
      notices: [],
      errors: ["Failed to open stage: Invalid stage description"],
    });
  });

  it("prefers the open failure over composition messages", () => {
    expect(
      stageModalContent({
        status: "error",
        error: "boom",
        compositionErrors: ["some error"],
        compositionNotices: ["skipped"],
      }),
    ).toEqual({ notices: [], errors: ["Failed to open stage: boom"] });
  });

  it("keeps notices only, with no errors", () => {
    const notices = ["4 files skipped (unsupported format): a.mtlx, b.mtlx"];
    const content = stageModalContent({ ...base, status: "ready", compositionNotices: notices });
    expect(content?.notices).toEqual(notices);
    expect(content?.errors).toEqual([]);
  });

  it("passes composition error strings through verbatim, one per entry", () => {
    const errors = [
      "Error in </Assets/Leg>[0] while prim </Assets/Leg> — could not resolve reference @missing.usda@",
      "Warning in </Assets/Upper> — unknown variant config",
    ];
    const content = stageModalContent({ ...base, status: "ready", compositionErrors: errors });
    expect(content?.errors).toEqual(errors);
    expect(content?.errors).toHaveLength(2);
    expect(content?.notices).toEqual([]);
  });

  it("carries both lists side by side", () => {
    const content = stageModalContent({
      ...base,
      status: "ready",
      compositionErrors: ["real error"],
      compositionNotices: ["notice"],
    });
    expect(content).toEqual({ notices: ["notice"], errors: ["real error"] });
  });

  it("treats a missing notices field as empty (older backend)", () => {
    const content = stageModalContent({ ...base, status: "ready", compositionErrors: ["boom"] });
    expect(content).toEqual({ notices: [], errors: ["boom"] });
  });
});
