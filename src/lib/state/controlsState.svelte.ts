export const DEFAULT_KEYBINDINGS = {
  playPause: "k",
  forward: "z",
  backward: "s",
  left: "q",
  right: "d",
  turnLeft: "a",
  turnRight: "e",
  up: " ",
  down: "shift",
  gizmoTranslate: "1",
  gizmoRotate: "2",
  gizmoScale: "3",
  commandPalette: "mod+p",
};

const CONTROL_DEFAULTS = {
  moveSpeedFactor: 1.0,
  rotSpeedFactor: 1.0,
  invertMouseX: false,
  invertMouseY: false,
  mouseButtonLeft: "rotate",
  mouseButtonMiddle: "zoom",
  mouseButtonRight: "pan",
  paletteTabExecutes: true,
};

export const controlsState = $state({
  ...CONTROL_DEFAULTS,
  keybindings: { ...DEFAULT_KEYBINDINGS },
});

export function saveControlPreferences() {
  localStorage.setItem(
    "usdbee_controls",
    JSON.stringify({
      moveSpeedFactor: controlsState.moveSpeedFactor,
      rotSpeedFactor: controlsState.rotSpeedFactor,
      invertMouseX: controlsState.invertMouseX,
      invertMouseY: controlsState.invertMouseY,
      mouseButtonLeft: controlsState.mouseButtonLeft,
      mouseButtonMiddle: controlsState.mouseButtonMiddle,
      mouseButtonRight: controlsState.mouseButtonRight,
      paletteTabExecutes: controlsState.paletteTabExecutes,
    }),
  );
}

export function saveKeybindings() {
  localStorage.setItem("usdbee_keybindings", JSON.stringify(controlsState.keybindings));
}

export function resetKeybindings() {
  // In place so a bound `keybindings` prop sees the reset without a reassign.
  Object.assign(controlsState.keybindings, DEFAULT_KEYBINDINGS);
  saveKeybindings();
}

export function resetControls() {
  Object.assign(controlsState, CONTROL_DEFAULTS);
  saveControlPreferences();
}

export function loadControlPreferences() {
  const savedControls = localStorage.getItem("usdbee_controls");
  if (savedControls) {
    try {
      const parsed = JSON.parse(savedControls);
      if (parsed.moveSpeedFactor !== undefined) controlsState.moveSpeedFactor = parsed.moveSpeedFactor;
      if (parsed.rotSpeedFactor !== undefined) controlsState.rotSpeedFactor = parsed.rotSpeedFactor;
      if (parsed.invertMouseX !== undefined) controlsState.invertMouseX = parsed.invertMouseX;
      if (parsed.invertMouseY !== undefined) controlsState.invertMouseY = parsed.invertMouseY;
      if (parsed.mouseButtonLeft !== undefined) controlsState.mouseButtonLeft = parsed.mouseButtonLeft;
      if (parsed.mouseButtonMiddle !== undefined) controlsState.mouseButtonMiddle = parsed.mouseButtonMiddle;
      if (parsed.mouseButtonRight !== undefined) controlsState.mouseButtonRight = parsed.mouseButtonRight;
      if (parsed.paletteTabExecutes !== undefined)
        controlsState.paletteTabExecutes = parsed.paletteTabExecutes;
    } catch (e) {
      console.warn("Failed to load control preferences", e);
    }
  }

  const savedKeys = localStorage.getItem("usdbee_keybindings");
  if (savedKeys) {
    try {
      controlsState.keybindings = { ...controlsState.keybindings, ...JSON.parse(savedKeys) };
    } catch (e) {
      console.warn("Failed to load keybindings", e);
    }
  }
}
