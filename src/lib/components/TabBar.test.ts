// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("$lib/state/editState.svelte", () => ({ editState: { dirtyLayers: [] } }));
vi.mock("$lib/state/layerTextState.svelte", () => ({ layerTextState: { draftDirty: false } }));
vi.mock("$lib/state/loadOrchestrator.svelte", () => ({
  loadOrchestrator: { openUsdFile: vi.fn(), rootFile: null },
}));

import TabBar from "./TabBar.svelte";
import { tabsState } from "$lib/state/tabsState.svelte";

// happy-dom has no PointerEvent constructor; the handlers only read
// button/clientX/pointerId, so a MouseEvent with the pointer type works.
const PointerEventCtor = (
  typeof PointerEvent === "function" ? PointerEvent : MouseEvent
) as typeof MouseEvent;

function pointer(el: Element, type: string, init: MouseEventInit & { pointerId?: number } = {}): void {
  el.dispatchEvent(
    new PointerEventCtor(type, {
      button: 0,
      buttons: 1,
      pointerId: 1,
      bubbles: true,
      clientX: 0,
      ...init,
    } as MouseEventInit),
  );
}

function stubRects(chips: NodeListOf<HTMLElement>): void {
  chips.forEach((chip, i) => {
    chip.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect;
  });
}

const tabRecord = {
  stage_id: 1,
  root_identifier: "/scene/bike.usda",
  root_file: "/scene/bike.usda",
  dirty_count: 0,
  stage_info: {},
  dependencies: null,
} as unknown as (typeof tabsState.stages)[number];

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  tabsState.stages = [];
  tabsState.activeId = 0;
  tabsState.pendingCloseId = null;
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

describe("TabBar chrome", () => {
  it("renders the bar and the add button with no open stages", async () => {
    instance = mount(TabBar, { target: document.body });
    await tick();

    const bar = document.querySelector<HTMLDivElement>('.stage-tab-bar[role="tablist"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("aria-label")).toBe("Stage tabs");
    expect(document.querySelector<HTMLButtonElement>(".stage-tab-add")).not.toBeNull();
    expect(document.querySelectorAll(".stage-tab").length).toBe(0);
  });

  it("renders a tab chip for an open stage", async () => {
    tabsState.stages.push(tabRecord);
    tabsState.activeId = 1;
    instance = mount(TabBar, { target: document.body });
    await tick();

    const chip = document.querySelector<HTMLButtonElement>(".stage-tab-btn");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("aria-selected")).toBe("true");
    expect(chip!.textContent).toContain("bike.usda");
  });

  it("closes a tab on middle click through the guarded close path", async () => {
    tabsState.stages.push(tabRecord, { ...tabRecord, stage_id: 2 });
    const closeTab = vi.spyOn(tabsState, "closeTab").mockResolvedValue();
    instance = mount(TabBar, { target: document.body });
    await tick();

    const chip = document.querySelector<HTMLElement>(".stage-tab")!;
    pointer(chip, "pointerdown", { button: 1, buttons: 4 });
    await tick();

    expect(closeTab).toHaveBeenCalledWith(1);
    closeTab.mockRestore();
  });

  it("does not start a drag from the close button", async () => {
    tabsState.stages.push(tabRecord, { ...tabRecord, stage_id: 2 });
    instance = mount(TabBar, { target: document.body });
    await tick();

    const close = document.querySelector<HTMLElement>(".stage-tab-close")!;
    pointer(close, "pointerdown", { clientX: 10 });
    pointer(close, "pointermove", { clientX: 200 });
    await tick();

    const bar = document.querySelector<HTMLElement>(".stage-tab-bar")!;
    expect(bar.classList.contains("dragging")).toBe(false);
  });

  it("reorders on release past a neighbour and clears the transforms", async () => {
    tabsState.stages.push(tabRecord, { ...tabRecord, stage_id: 2 }, { ...tabRecord, stage_id: 3 });
    tabsState.activeId = 1;
    instance = mount(TabBar, { target: document.body });
    await tick();

    const chips = document.querySelectorAll<HTMLElement>(".stage-tab");
    stubRects(chips);
    pointer(chips[0], "pointerdown", { clientX: 10 });
    pointer(chips[0], "pointermove", { clientX: 250 });
    await tick();

    const bar = document.querySelector<HTMLElement>(".stage-tab-bar")!;
    expect(bar.classList.contains("dragging")).toBe(true);
    // The dragged chip tracks the cursor; the crossed chips open the gap.
    expect(chips[0].style.transform).toBe("translateX(240px)");
    expect(chips[1].style.transform).toBe("translateX(-100px)");
    expect(chips[2].style.transform).toBe("translateX(-100px)");

    pointer(document.body, "pointerup", { clientX: 250, buttons: 0 });
    await tick();

    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([2, 3, 1]);
    // The drag must not steal the active tab.
    expect(tabsState.activeId).toBe(1);
    document.querySelectorAll<HTMLElement>(".stage-tab").forEach((chip) => {
      expect(chip.style.transform).toBe("");
    });
    expect(document.querySelector<HTMLElement>(".stage-tab-bar")!.classList.contains("dragging")).toBe(false);
  });

  it("treats a press that stays under the drag threshold as a click", async () => {
    tabsState.stages.push(tabRecord, { ...tabRecord, stage_id: 2 });
    instance = mount(TabBar, { target: document.body });
    await tick();

    const chips = document.querySelectorAll<HTMLElement>(".stage-tab");
    stubRects(chips);
    pointer(chips[0], "pointerdown", { clientX: 10 });
    pointer(chips[0], "pointermove", { clientX: 12 });
    await tick();

    expect(document.querySelector<HTMLElement>(".stage-tab-bar")!.classList.contains("dragging")).toBe(false);
    expect(chips[0].style.transform).toBe("");

    pointer(document.body, "pointerup", { clientX: 12, buttons: 0 });
    await tick();
    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([1, 2]);
  });

  it("does not lift a lone tab", async () => {
    tabsState.stages.push(tabRecord);
    instance = mount(TabBar, { target: document.body });
    await tick();

    const chips = document.querySelectorAll<HTMLElement>(".stage-tab");
    stubRects(chips);
    pointer(chips[0], "pointerdown", { clientX: 10 });
    pointer(chips[0], "pointermove", { clientX: 300 });
    await tick();

    expect(document.querySelector<HTMLElement>(".stage-tab-bar")!.classList.contains("dragging")).toBe(false);
    expect(chips[0].classList.contains("drag-source")).toBe(false);
    expect(chips[0].style.transform).toBe("");
  });

  it("cancels the drag on pointercancel without reordering", async () => {
    tabsState.stages.push(tabRecord, { ...tabRecord, stage_id: 2 });
    instance = mount(TabBar, { target: document.body });
    await tick();

    const chips = document.querySelectorAll<HTMLElement>(".stage-tab");
    stubRects(chips);
    pointer(chips[0], "pointerdown", { clientX: 10 });
    pointer(chips[0], "pointermove", { clientX: 150 });
    await tick();

    pointer(document.body, "pointercancel", { clientX: 150, buttons: 0 });
    await tick();

    expect(document.querySelector<HTMLElement>(".stage-tab-bar")!.classList.contains("dragging")).toBe(false);
    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([1, 2]);
  });

  it("drops a drag whose button was released off-window", async () => {
    tabsState.stages.push(tabRecord, { ...tabRecord, stage_id: 2 });
    instance = mount(TabBar, { target: document.body });
    await tick();

    const chips = document.querySelectorAll<HTMLElement>(".stage-tab");
    stubRects(chips);
    pointer(chips[0], "pointerdown", { clientX: 10 });
    pointer(chips[0], "pointermove", { clientX: 150 });
    await tick();
    expect(document.querySelector<HTMLElement>(".stage-tab-bar")!.classList.contains("dragging")).toBe(true);

    // A bare hover: no buttons pressed, so the gesture was never released here.
    pointer(chips[0], "pointermove", { clientX: 160, buttons: 0 });
    await tick();

    expect(document.querySelector<HTMLElement>(".stage-tab-bar")!.classList.contains("dragging")).toBe(false);
    expect(tabsState.stages.map((tab) => tab.stage_id)).toEqual([1, 2]);
  });
});
