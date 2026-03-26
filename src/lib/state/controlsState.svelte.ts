export const controlsState = $state({
  moveSpeedFactor: 1.0,
  rotSpeedFactor: 1.0,
  invertMouseX: false,
  invertMouseY: false,
  mouseButtonLeft: "rotate",
  mouseButtonMiddle: "zoom",
  mouseButtonRight: "pan",
  keybindings: {
    forward: "z",
    backward: "s",
    left: "q",
    right: "d",
    turnLeft: "a",
    turnRight: "e",
    up: " ",
    down: "shift",
  },
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
    }),
  );
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
