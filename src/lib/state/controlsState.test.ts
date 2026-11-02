import { describe, expect, it } from "vitest";

import { controlsState } from "./controlsState.svelte";

describe("controlsState keybinding defaults", () => {
  it("gizmo mode shortcuts exist and never collide with other bindings", () => {
    const kb = controlsState.keybindings;
    expect(kb.gizmoTranslate).toBe("1");
    expect(kb.gizmoRotate).toBe("2");
    expect(kb.gizmoScale).toBe("3");
    // A collision would make one key silently shadow another action.
    const values = Object.values(kb);
    expect(new Set(values).size).toBe(values.length);
  });
});
