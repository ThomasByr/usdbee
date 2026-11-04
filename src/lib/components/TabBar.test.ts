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
});
