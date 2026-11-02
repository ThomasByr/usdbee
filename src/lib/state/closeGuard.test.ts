import { describe, expect, it } from "vitest";

import { confirmCloseNeeded } from "./closeGuard";

// The plan's Step 1 close-confirmation pin: given a dirty-layer count, is a
// confirm dialog needed before the window may close?
describe("confirmCloseNeeded", () => {
  it("does not confirm a clean stage", () => {
    expect(confirmCloseNeeded(0)).toBe(false);
  });

  it("confirms when any layer has unsaved edits", () => {
    expect(confirmCloseNeeded(1)).toBe(true);
    expect(confirmCloseNeeded(3)).toBe(true);
  });

  it("treats negative counts as clean (no dirty layers)", () => {
    expect(confirmCloseNeeded(-1)).toBe(false);
  });
});
