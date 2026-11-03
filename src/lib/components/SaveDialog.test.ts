// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

const mocks = vi.hoisted(() => ({
  saveAll: vi.fn(),
  saveAsUsdz: vi.fn(),
  setEditTarget: vi.fn(),
  dirtyLayers: [
    {
      identifier: "/scene/root.usda",
      original_path: "/scene/root.usda",
      is_session: false,
    },
  ],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("$lib/stage/stageState.svelte", () => ({ stageState: { activeStageId: 1 } }));
vi.mock("$lib/state/editState.svelte", () => ({
  editState: {
    dirtyLayers: mocks.dirtyLayers,
    editTarget: { layer_identifier: "/scene/root.usda", is_session: false, is_usdz_stage: false },
    saveError: null,
    saving: false,
    saveAll: mocks.saveAll,
    saveAsUsdz: mocks.saveAsUsdz,
    setEditTarget: mocks.setEditTarget,
  },
}));

import SaveDialogStackHarness from "./__tests__/save-dialog-stack-harness.svelte";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  mocks.saveAll.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
});

describe("SaveDialog Enter ownership", () => {
  it("never confirms behind another modal but confirms once top-most", async () => {
    instance = mount(SaveDialogStackHarness, {
      target: document.body,
      props: { onCloseSave: () => {}, onCloseTop: () => {} },
    });
    await tick();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.saveAll).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(mocks.saveAll).toHaveBeenCalledTimes(1));
  });
});
