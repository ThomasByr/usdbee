// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_KEYBINDINGS,
  controlsState,
  loadControlPreferences,
  resetControls,
  resetKeybindings,
  saveControlPreferences,
  saveKeybindings,
} from "./controlsState.svelte";

beforeEach(() => {
  resetControls();
  resetKeybindings();
  localStorage.clear();
});

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

  it("exports a default snapshot including the palette combo", () => {
    expect(DEFAULT_KEYBINDINGS.commandPalette).toBe("mod+p");
  });

  it("binds camera cycling to c by default", () => {
    expect(DEFAULT_KEYBINDINGS.cycleCamera).toBe("c");
  });

  it("binds play/pause to k by default", () => {
    expect(controlsState.keybindings.playPause).toBe("k");
  });

  it("binds frame stepping to the arrow keys by default", () => {
    expect(DEFAULT_KEYBINDINGS.nextFrame).toBe("arrowright");
    expect(DEFAULT_KEYBINDINGS.previousFrame).toBe("arrowleft");
  });

  it("reset restores the defaults without letting the state leak into them", () => {
    controlsState.keybindings.forward = "x";
    expect(DEFAULT_KEYBINDINGS.forward).toBe("z");

    resetKeybindings();

    expect(controlsState.keybindings.forward).toBe("z");
    expect({ ...controlsState.keybindings }).toEqual({ ...DEFAULT_KEYBINDINGS });
  });

  it("persists the reset keybindings", () => {
    controlsState.keybindings.forward = "x";
    saveKeybindings();
    resetKeybindings();

    expect(JSON.parse(localStorage.getItem("usdbee_keybindings")!)).toEqual({ ...DEFAULT_KEYBINDINGS });
  });
});

describe("controls reset", () => {
  it("restores the mouse and speed defaults and persists them", () => {
    controlsState.moveSpeedFactor = 4;
    controlsState.mouseButtonLeft = "zoom";

    resetControls();

    expect(controlsState.moveSpeedFactor).toBe(1);
    expect(controlsState.mouseButtonLeft).toBe("rotate");
    expect(JSON.parse(localStorage.getItem("usdbee_controls")!).moveSpeedFactor).toBe(1);
  });
});

describe("paletteTabExecutes preference", () => {
  it("defaults to true", () => {
    expect(controlsState.paletteTabExecutes).toBe(true);
  });

  it("round-trips through usdbee_controls", () => {
    controlsState.paletteTabExecutes = false;
    saveControlPreferences();

    controlsState.paletteTabExecutes = true;
    loadControlPreferences();

    expect(controlsState.paletteTabExecutes).toBe(false);
  });

  it("stays true when the stored blob predates the field", () => {
    localStorage.setItem("usdbee_controls", JSON.stringify({ invertMouseX: true }));

    loadControlPreferences();

    expect(controlsState.paletteTabExecutes).toBe(true);
    expect(controlsState.invertMouseX).toBe(true);
  });
});
