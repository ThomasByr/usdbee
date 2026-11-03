import { describe, expect, it } from "vitest";

import { confirmCloseNeeded, windowCloseConfirmNeeded } from "./closeGuard";

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

  it("confirms for an unapplied layer-text draft even with clean layers", () => {
    expect(confirmCloseNeeded(0, true)).toBe(true);
    expect(confirmCloseNeeded(0, false)).toBe(false);
  });
});

// Task 11: the OS window close must aggregate dirt across EVERY open
// stage (list_stages), not just the active one.
describe("windowCloseConfirmNeeded", () => {
  it("does not confirm when every open stage is clean", () => {
    expect(
      windowCloseConfirmNeeded([
        { stage_id: 1, root_identifier: "/a.usda", dirty_count: 0 },
        { stage_id: 2, root_identifier: "/b.usda", dirty_count: 0 },
      ]),
    ).toBe(false);
  });

  it("confirms when any stage anywhere in the list is dirty", () => {
    expect(
      windowCloseConfirmNeeded([
        { stage_id: 1, root_identifier: "/a.usda", dirty_count: 0 },
        { stage_id: 2, root_identifier: "/b.usda", dirty_count: 1 },
      ]),
    ).toBe(true);
    expect(windowCloseConfirmNeeded([{ stage_id: 1, root_identifier: "/a.usda", dirty_count: 2 }])).toBe(
      true,
    );
  });

  it("confirms for an unapplied text draft even when all layers are clean", () => {
    expect(
      windowCloseConfirmNeeded([{ stage_id: 1, root_identifier: "/a.usda", dirty_count: 0 }], true),
    ).toBe(true);
    expect(windowCloseConfirmNeeded([], true)).toBe(true);
  });
});
