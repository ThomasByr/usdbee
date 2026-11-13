// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import SettingsTab from "./tabs/SettingsTab.svelte";
import { DEFAULT_KEYBINDINGS, controlsState, resetKeybindings } from "$lib/state/controlsState.svelte";

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

function mountTab() {
  resetKeybindings();
  instance = mount(SettingsTab, {
    target: document.body,
    props: {
      showWireframe: false,
      showGrid: true,
      showBoundingBox: false,
      moveSpeedFactor: 1,
      rotSpeedFactor: 1,
      invertMouseX: false,
      invertMouseY: false,
      mouseButtonLeft: "rotate",
      mouseButtonMiddle: "zoom",
      mouseButtonRight: "pan",
      keybindings: controlsState.keybindings,
      backgroundColor: "#1e1e1e",
      activeCameraIndex: -1,
      omniverseUrl: "",
      usdCameras: [],
      triangleCount: 0,
      saveControlPreferences: () => {},
      updateOmniverseUrl: () => {},
    },
  });
}

describe("SettingsTab keyboard section", () => {
  it("gives every binding a recorder and both reset buttons", async () => {
    mountTab();
    await tick();

    expect(document.querySelectorAll(".keybtn").length).toBe(Object.keys(DEFAULT_KEYBINDINGS).length);
    const labels = [...document.querySelectorAll(".reset-btn")].map((b) => b.textContent!.trim());
    expect(labels).toContain("Reset keyboard");
    expect(labels).toContain("Reset controls");
  });

  it("resets the keybindings from the Reset keyboard button", async () => {
    resetKeybindings();
    mountTab();
    controlsState.keybindings.forward = "x";
    await tick();
    expect(document.querySelector(".keybtn")!.textContent!.trim()).toBe("X");

    const button = [...document.querySelectorAll<HTMLButtonElement>(".reset-btn")].find(
      (b) => b.textContent!.trim() === "Reset keyboard",
    )!;
    button.click();
    await tick();

    expect(controlsState.keybindings.forward).toBe("z");
    expect(document.querySelector(".keybtn")!.textContent!.trim()).toBe("Z");
  });

  it("persists a captured binding to usdbee_keybindings", async () => {
    localStorage.clear();
    mountTab();
    await tick();

    document.querySelector<HTMLButtonElement>(".keybtn")!.click();
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    await tick();

    expect(controlsState.keybindings.forward).toBe("x");
    expect(JSON.parse(localStorage.getItem("usdbee_keybindings")!).forward).toBe("x");
  });
});
