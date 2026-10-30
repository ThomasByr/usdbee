import { describe, expect, it } from "vitest";
import { stageModalErrorLines, type StageErrorInput } from "./modalErrors";

const base: StageErrorInput = { status: "idle", error: null, compositionErrors: [] };

describe("stageModalErrorLines", () => {
  it("returns null when the stage is clean", () => {
    expect(stageModalErrorLines(base)).toBeNull();
    expect(stageModalErrorLines({ ...base, status: "ready" })).toBeNull();
    expect(stageModalErrorLines({ ...base, status: "loading" })).toBeNull();
  });

  it("returns one line for a stage-open failure", () => {
    const lines = stageModalErrorLines({
      ...base,
      status: "error",
      error: "Invalid stage description",
    });
    expect(lines).toEqual(["Failed to open stage: Invalid stage description"]);
  });

  it("prefers the open failure over composition errors", () => {
    const lines = stageModalErrorLines({
      status: "error",
      error: "boom",
      compositionErrors: ["some error"],
    });
    expect(lines).toEqual(["Failed to open stage: boom"]);
  });

  it("passes composition error strings through verbatim, one per entry", () => {
    const errors = [
      "Error in </Assets/Leg>[0] while prim </Assets/Leg> — could not resolve reference @missing.usda@",
      "Warning in </Assets/Upper> — unknown variant config",
    ];
    const lines = stageModalErrorLines({ ...base, status: "ready", compositionErrors: errors });
    expect(lines).toEqual(errors);
    expect(lines).toHaveLength(2);
  });

  it("ignores empty composition error lists", () => {
    expect(stageModalErrorLines({ ...base, status: "ready", compositionErrors: [] })).toBeNull();
  });
});
