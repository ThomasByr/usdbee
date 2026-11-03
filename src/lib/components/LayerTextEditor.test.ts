// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { invoke } from "@tauri-apps/api/core";
import LayerTextEditor from "./LayerTextEditor.svelte";
import { stageState } from "$lib/stage/stageState.svelte";
import type { LayerInfo } from "$lib/stage/types";

const mockedInvoke = vi.mocked(invoke);

const sharedLayer: LayerInfo = {
  identifier: "/scene/root.usda",
  original_path: "/scene/root.usda",
  is_session: false,
};

const textarea = (): HTMLTextAreaElement =>
  document.querySelector<HTMLTextAreaElement>("textarea.usda-text")!;

let instance: ReturnType<typeof mount> | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  stageState.activeStageId = 1;
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
  stageState.activeStageId = 0;
});

describe("LayerTextEditor stage switch", () => {
  it("ignores a layer list from the previous stage", async () => {
    const staleLayers = deferred<LayerInfo[]>();
    mockedInvoke.mockReturnValueOnce(staleLayers.promise);
    instance = mount(LayerTextEditor, { target: document.body });
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("list_stage_layers", { stageId: 1 }));

    stageState.activeStageId = 2;
    mockedInvoke.mockResolvedValueOnce([sharedLayer]).mockResolvedValueOnce("stage two text");
    await vi.waitFor(() => expect(textarea().value).toBe("stage two text"));

    staleLayers.resolve([{ ...sharedLayer, identifier: "/scene/stale.usda" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector<HTMLSelectElement>("select")!.value).toBe(sharedLayer.identifier);
    expect(textarea().value).toBe("stage two text");
  });

  it("ignores layer text from the previous stage", async () => {
    const staleText = deferred<string>();
    mockedInvoke.mockResolvedValueOnce([sharedLayer]).mockReturnValueOnce(staleText.promise);
    instance = mount(LayerTextEditor, { target: document.body });
    await vi.waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("export_layer_text", {
        stageId: 1,
        identifier: sharedLayer.identifier,
      }),
    );

    stageState.activeStageId = 2;
    mockedInvoke.mockResolvedValueOnce([sharedLayer]).mockResolvedValueOnce("stage two text");
    await vi.waitFor(() => expect(textarea().value).toBe("stage two text"));

    staleText.resolve("stage one stale text");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(textarea().value).toBe("stage two text");
  });

  it("discards an unapplied draft on a stage switch with an identical layer identifier", async () => {
    mockedInvoke
      .mockResolvedValueOnce([sharedLayer]) // stage 1: list_stage_layers
      .mockResolvedValueOnce("stage one text"); // stage 1: export_layer_text
    instance = mount(LayerTextEditor, { target: document.body });
    await vi.waitFor(() => {
      expect(textarea().value).toBe("stage one text");
    });

    // An unapplied edit is sitting in the textarea.
    textarea().value = "draft stage one";
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    // Tab switch: stage 2 (a different stage) has a layer with the SAME
    // identifier. The old draft must not present itself as stage 2's text.
    stageState.activeStageId = 2;
    mockedInvoke
      .mockResolvedValueOnce([sharedLayer]) // stage 2: list_stage_layers
      .mockResolvedValueOnce("stage two text"); // stage 2: export_layer_text

    await vi.waitFor(() => {
      expect(textarea().value).toBe("stage two text");
    });
    expect(mockedInvoke).toHaveBeenCalledWith("export_layer_text", {
      stageId: 2,
      identifier: sharedLayer.identifier,
    });
  });
});
