import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { editState } from "./editState.svelte";
import type { EditTargetInfo, LayerInfo } from "../stage/types";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

const target: EditTargetInfo = {
  layer_identifier: "/cache/sessions/session-1-0.usda",
  is_session: true,
  is_usdz_stage: false,
};

const sessionLayer: LayerInfo = {
  identifier: "/cache/sessions/session-1-0.usda",
  original_path: "/cache/sessions/session-1-0.usda",
  is_session: true,
};

const rootLayer: LayerInfo = {
  identifier: "/scene/basic.usda",
  original_path: "/scene/basic.usda",
  is_session: false,
};

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedListen.mockReset();
  editState.editTarget = null;
  editState.dirtyLayers = [];
  editState.saveError = null;
  editState.saving = false;
});

describe("editState", () => {
  it("refresh queries the edit target and the dirty layers", async () => {
    mockedInvoke.mockResolvedValueOnce(target).mockResolvedValueOnce([sessionLayer, rootLayer]);

    await editState.refresh();

    expect(mockedInvoke).toHaveBeenCalledWith("get_edit_target");
    expect(mockedInvoke).toHaveBeenCalledWith("list_dirty_layers");
    expect(editState.editTarget).toEqual(target);
    expect(editState.dirtyLayers).toEqual([sessionLayer, rootLayer]);
  });

  it("refresh clears the state when no stage is open", async () => {
    editState.editTarget = target;
    editState.dirtyLayers = [sessionLayer];
    mockedInvoke.mockRejectedValueOnce("no stage open");

    await editState.refresh();

    expect(editState.editTarget).toBeNull();
    expect(editState.dirtyLayers).toEqual([]);
  });

  it("setEditTarget invokes the backend and refreshes", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(target).mockResolvedValueOnce([]);

    const error = await editState.setEditTarget("/scene/basic.usda");

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("set_edit_target", {
      identifier: "/scene/basic.usda",
    });
    expect(editState.editTarget).toEqual(target);
  });

  it("setEditTarget passes null for the session target", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    const error = await editState.setEditTarget(null);

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("set_edit_target", { identifier: null });
  });

  it("setEditTarget surfaces backend errors", async () => {
    mockedInvoke.mockRejectedValueOnce("layer not found in the stage: /nope.usda");

    const error = await editState.setEditTarget("/nope.usda");

    expect(error).toBe("layer not found in the stage: /nope.usda");
  });

  it("saveAll sends the requests and refreshes on success", async () => {
    mockedInvoke
      .mockResolvedValueOnce(undefined) // save_layers
      .mockResolvedValueOnce(target) // get_edit_target
      .mockResolvedValueOnce([]); // list_dirty_layers
    editState.dirtyLayers = [sessionLayer];

    const error = await editState.saveAll([
      { identifier: sessionLayer.identifier, path: "/tmp/snapshot.usda" },
    ]);

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("save_layers", {
      requests: [{ identifier: sessionLayer.identifier, path: "/tmp/snapshot.usda" }],
    });
    expect(editState.dirtyLayers).toEqual([]);
    expect(editState.saving).toBe(false);
  });

  it("saveAll surfaces backend errors and keeps the state visible", async () => {
    mockedInvoke.mockRejectedValueOnce("only .usda, .usdc and .usd files are writable");

    const error = await editState.saveAll([{ identifier: rootLayer.identifier, path: "/tmp/sneaky.exe" }]);

    expect(error).toBe("only .usda, .usdc and .usd files are writable");
    expect(editState.saveError).toBe(error);
    expect(editState.saving).toBe(false);
  });

  it("init subscribes to usd-stage-changed and refreshes on every event", async () => {
    let handler: (event: { payload: unknown }) => void = () => {};
    mockedListen.mockImplementation(async (name, callback) => {
      if (name === "usd-stage-changed") handler = callback as (event: { payload: unknown }) => void;
      return () => {};
    });
    mockedInvoke.mockResolvedValue(target);

    await editState.init();

    expect(mockedListen).toHaveBeenCalledWith("usd-stage-changed", expect.any(Function));
    mockedInvoke.mockClear();
    handler({ payload: { paths: ["/World/Ball"] } });
    await vi.waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("get_edit_target");
    });
  });
});
