// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

vi.mock("$lib/state/editState.svelte", () => ({
  editState: { canUndo: false, canRedo: false },
}));

import Toolbar from "./Toolbar.svelte";
import type { RendererKit } from "$lib/three/RendererKit.svelte";
import { tabsState } from "$lib/state/tabsState.svelte";

const viewer = {
  fov: 75,
  enableDamping: true,
  triangleCount: 0,
} as unknown as RendererKit;

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

describe("Toolbar disabled chrome", () => {
  it("renders inert and subdued when disabled", async () => {
    instance = mount(Toolbar, {
      target: document.body,
      props: { viewer, gizmoMode: "translate", gizmoMessage: null, attachable: false, disabled: true },
    });
    await tick();

    const bar = document.querySelector<HTMLDivElement>(".top-toolbar");
    expect(bar).not.toBeNull();
    expect(bar!.hasAttribute("inert")).toBe(true);
    expect(bar!.classList.contains("disabled")).toBe(true);
  });

  it("renders interactive by default", async () => {
    instance = mount(Toolbar, {
      target: document.body,
      props: { viewer, gizmoMode: "translate", gizmoMessage: null, attachable: false },
    });
    await tick();

    const bar = document.querySelector<HTMLDivElement>(".top-toolbar")!;
    expect(bar.hasAttribute("inert")).toBe(false);
    expect(bar.classList.contains("disabled")).toBe(false);
  });

  it("forgets the tab's saved camera when Reset View is clicked", async () => {
    const forget = vi.spyOn(tabsState, "forgetActiveCamera");
    const resetView = vi.fn();
    Object.assign(viewer, { resetCameraView: resetView });
    instance = mount(Toolbar, {
      target: document.body,
      props: { viewer, gizmoMode: "translate", gizmoMessage: null, attachable: false },
    });
    await tick();

    document.querySelector<HTMLButtonElement>('button[title="Reset View"]')!.click();

    expect(forget).toHaveBeenCalledTimes(1);
    expect(resetView).toHaveBeenCalledTimes(1);
    forget.mockRestore();
  });
});
