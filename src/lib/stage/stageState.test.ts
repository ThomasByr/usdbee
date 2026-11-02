import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { stageState } from "./stageState.svelte";
import { renderState } from "../render/renderState.svelte";

const info = { path: "/a.usda" };
const details = { path: "/A" } as never;

const mockedInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("stageState", () => {
  it("clears the previous selection before the second load, even if it rejects", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]).mockResolvedValueOnce(details);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");

    expect(stageState.selectedPath).toBe("/A");
    expect(stageState.details).not.toBeNull();

    mockedInvoke.mockRejectedValueOnce("bad stage");

    await stageState.loadStage("/b.usda");

    expect(stageState.selectedPath).toBeNull();
    expect(stageState.details).toBeNull();
    expect(stageState.status).toBe("error");
    expect(stageState.error).toBe("bad stage");
  });

  it("passes the current render time when fetching selected prim details", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    renderState.time = 12.5;
    mockedInvoke.mockResolvedValueOnce(details);

    await stageState.selectPrim("/A");

    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { path: "/A", time: 12.5 });
  });

  it("refreshes the current selection at a newer render time", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    renderState.time = 1;
    mockedInvoke.mockResolvedValueOnce(details);
    await stageState.selectPrim("/A");
    renderState.time = 2;
    mockedInvoke.mockResolvedValueOnce(details);

    const refresh = (stageState as any).refreshSelectedDetails;
    expect(refresh).toBeTypeOf("function");
    await refresh.call(stageState);

    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { path: "/A", time: 2 });
  });

  it("adopts a backend-opened stage without composing it again", async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    await stageState.adoptOpenedStage(info as never);

    expect(stageState.stageInfo).toEqual(info);
    expect(stageState.status).toBe("ready");
    expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual(["get_stage_tree"]);
  });

  it("does not let a stale selection repopulate details after a newer load", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");

    const staleDetails = deferred<never>();
    mockedInvoke.mockReturnValueOnce(staleDetails.promise);
    const selection = stageState.selectPrim("/Old");

    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/b.usda");
    staleDetails.resolve(details);
    await selection;

    expect(stageState.selectedPath).toBeNull();
    expect(stageState.details).toBeNull();
  });

  it("does not commit a stale load after a newer load finishes", async () => {
    const staleInfo = deferred<never>();
    mockedInvoke.mockReturnValueOnce(staleInfo.promise);
    const staleLoad = stageState.loadStage("/old.usda");

    const currentInfo = { path: "/new.usda" };
    mockedInvoke.mockResolvedValueOnce(currentInfo).mockResolvedValueOnce([]);
    await stageState.loadStage("/new.usda");

    staleInfo.resolve(info as never);
    mockedInvoke.mockResolvedValueOnce([]);
    await staleLoad;

    expect(stageState.stageInfo).toEqual(currentInfo);
    expect(stageState.status).toBe("ready");
  });

  it("setVariantSelection invokes the backend and passes null for a clear", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockResolvedValue(undefined);

    const error = await stageState.setVariantSelection("color", "blue");

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("set_variant_selection", {
      path: "/A",
      variantSet: "color",
      selection: "blue",
    });

    await stageState.setVariantSelection("color", null);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_variant_selection", {
      path: "/A",
      variantSet: "color",
      selection: null,
    });
  });

  it("setVariantSelection surfaces backend errors", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockRejectedValueOnce("prim not found: /A");

    const error = await stageState.setVariantSelection("color", "blue");

    expect(error).toBe("prim not found: /A");
  });

  it("setAttributeValue forwards the time argument, including null", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockResolvedValue(undefined);
    const value = { type: "double3", data: [1, 2, 3] };

    // Default: the viewer's current time code.
    renderState.time = 7;
    await stageState.setAttributeValue("xformOp:translate", value as never);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_attribute_value", {
      path: "/A",
      name: "xformOp:translate",
      value,
      time: 7,
    });

    // Explicit time codes reach the backend unchanged.
    await stageState.setAttributeValue("xformOp:translate", value as never, 42);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_attribute_value", {
      path: "/A",
      name: "xformOp:translate",
      value,
      time: 42,
    });

    // null authors the default (uniform attributes like xformOpOrder must
    // never receive a time sample); Tauri's serde maps JSON null -> None.
    const order = { type: "token_array", data: ["xformOp:translate"] };
    await stageState.setAttributeValue("xformOpOrder", order as never, null);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_attribute_value", {
      path: "/A",
      name: "xformOpOrder",
      value: order,
      time: null,
    });
  });

  it("refreshAfterEdit refetches the tree and re-selects the prim", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    renderState.time = 3;
    mockedInvoke.mockResolvedValueOnce(details);
    await stageState.selectPrim("/A");

    mockedInvoke.mockResolvedValueOnce([]).mockResolvedValueOnce(details);
    await stageState.refreshAfterEdit();

    expect(mockedInvoke).toHaveBeenCalledWith("get_stage_tree");
    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { path: "/A", time: 3 });
  });
});
