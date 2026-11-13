import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { stageState } from "./stageState.svelte";
import { renderState } from "../render/renderState.svelte";

const info = { path: "/a.usda", stage_id: 7 };
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
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce(details);
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
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    renderState.time = 12.5;
    mockedInvoke.mockResolvedValueOnce(details);

    await stageState.selectPrim("/A");

    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { stageId: 7, path: "/A", time: 12.5 });
  });

  it("refreshes the current selection at a newer render time", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    renderState.time = 1;
    mockedInvoke.mockResolvedValueOnce(details);
    await stageState.selectPrim("/A");
    renderState.time = 2;
    mockedInvoke.mockResolvedValueOnce(details);

    const refresh = (stageState as any).refreshSelectedDetails;
    expect(refresh).toBeTypeOf("function");
    await refresh.call(stageState);

    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { stageId: 7, path: "/A", time: 2 });
  });

  it("suppresses the inspector refresh while playing and refreshes once on pause", async () => {
    // Playback perf: the per-step details refresh costs ~205 ms of stage
    // work; while the playhead auto-advances it must not run at all, and
    // pausing refreshes exactly once. Values go stale during playback
    // by design.
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockResolvedValueOnce(details);
    await stageState.selectPrim("/A");
    mockedInvoke.mockClear();

    for (let i = 0; i < 5; i++) stageState.onStageTimeChanged(true);
    expect(mockedInvoke).not.toHaveBeenCalled();

    stageState.onPlaybackPaused();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_prim_details")).toHaveLength(1);

    // A second pause hook must not refresh again.
    mockedInvoke.mockClear();
    stageState.onPlaybackPaused();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("refreshes on selection change even while the per-step refresh is suppressed", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    stageState.onStageTimeChanged(true); // playback suppression on
    mockedInvoke.mockClear();

    mockedInvoke.mockResolvedValueOnce(details);
    await stageState.selectPrim("/A");

    expect(mockedInvoke).toHaveBeenCalledWith("get_prim_details", {
      stageId: 7,
      path: "/A",
      time: renderState.time,
    });
  });

  it("coalesces overlapping refreshes and re-runs with the latest time", async () => {
    // In-flight guard: rapid triggers (scrub storms while paused) must not
    // pile get_prim_details requests onto the stage actor; the last
    // dropped trigger re-runs once the active refresh lands.
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockResolvedValueOnce(details);
    await stageState.selectPrim("/A");
    renderState.time = 1;

    const slow = deferred<never>();
    mockedInvoke.mockReturnValueOnce(slow.promise);
    const first = stageState.refreshSelectedDetails();
    stageState.onStageTimeChanged(false); // dropped while in flight, re-run pending
    renderState.time = 9;
    slow.resolve(details);
    await first;
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { stageId: 7, path: "/A", time: 9 });
  });

  it("re-runs an awaited refresh when a younger selectPrim superseded its fetch", async () => {
    // The supersede hole: the awaited refresh's payload assignment is
    // dropped when a younger selectPrim is in flight, but the promise
    // still resolved — the gizmo commit then authored from stale details
    // (the rotate-reverted-the-move bug). The refresh must re-run until
    // an assignment actually applies.
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    const old = { path: "/A", marker: "old" } as never;
    mockedInvoke.mockResolvedValueOnce(old);
    await stageState.selectPrim("/A");
    expect(stageState.details).toEqual(old);

    const mine = deferred<never>();
    const other = deferred<never>();
    const fresh = { path: "/A", marker: "fresh" } as never;
    mockedInvoke
      .mockReturnValueOnce(mine.promise)
      .mockReturnValueOnce(other.promise)
      .mockResolvedValueOnce(fresh);

    const refresh = stageState.refreshSelectedDetails();
    void stageState.selectPrim("/A");

    mine.resolve({ path: "/A", marker: "mine" } as never);
    await refresh;
    // mine was superseded and dropped: the re-run's payload must be what
    // an awaiting caller sees, not the pre-refresh `old`.
    expect(stageState.details).toEqual(fresh);

    other.resolve({ path: "/A", marker: "other" } as never);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // The younger selectPrim's generation is now older than the re-run's:
    // its late payload must not overwrite the fresh details.
    expect(stageState.details).toEqual(fresh);
  });

  it("does not resolve an overlapping refresh before fresh details land", async () => {
    // The gizmo commit awaits this refresh before reading the local
    // transform: a caller landing mid-flight must not get the promise of a
    // dedupe no-op, or it authors its delta from the stale payload.
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    const stale = { path: "/A", marker: "stale" } as never;
    mockedInvoke.mockResolvedValueOnce(stale);
    await stageState.selectPrim("/A");

    const fresh = { path: "/A", marker: "fresh" } as never;
    const slow = deferred<never>();
    mockedInvoke.mockResolvedValue(fresh);
    mockedInvoke.mockReturnValueOnce(slow.promise);

    const first = stageState.refreshSelectedDetails();
    const second = stageState.refreshSelectedDetails();
    let settled = false;
    void second.then(() => (settled = true));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);

    slow.resolve(fresh);
    await Promise.all([first, second]);
    expect(stageState.details).toEqual(fresh);
  });

  it("adopts a backend-opened stage without any backend call (lazy tree)", async () => {
    await stageState.adoptOpenedStage(info as never);

    expect(stageState.stageInfo).toEqual(info);
    expect(stageState.status).toBe("ready");
    expect(stageState.tree).toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("does not let a stale selection repopulate details after a newer load", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");

    const staleDetails = deferred<never>();
    mockedInvoke.mockReturnValueOnce(staleDetails.promise);
    const selection = stageState.selectPrim("/Old");

    mockedInvoke.mockResolvedValueOnce(info);
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

    const currentInfo = { path: "/new.usda", stage_id: 8 };
    mockedInvoke.mockResolvedValueOnce(currentInfo);
    await stageState.loadStage("/new.usda");

    staleInfo.resolve(info as never);
    await staleLoad;

    expect(stageState.stageInfo).toEqual(currentInfo);
    expect(stageState.status).toBe("ready");
  });

  it("setVariantSelection invokes the backend and passes null for a clear", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockResolvedValue(undefined);

    const error = await stageState.setVariantSelection("color", "blue");

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("set_variant_selection", {
      stageId: 7,
      path: "/A",
      variantSet: "color",
      selection: "blue",
    });

    await stageState.setVariantSelection("color", null);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_variant_selection", {
      stageId: 7,
      path: "/A",
      variantSet: "color",
      selection: null,
    });
  });

  it("setVariantSelection surfaces backend errors", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockRejectedValueOnce("prim not found: /A");

    const error = await stageState.setVariantSelection("color", "blue");

    expect(error).toBe("prim not found: /A");
  });

  it("setPrimTexture invokes the backend per path and passes null for a clear", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockResolvedValue(undefined);

    const error = await stageState.setPrimTexture("/A", "/tex/checker.png");

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("set_prim_texture", {
      stageId: 7,
      path: "/A",
      texturePath: "/tex/checker.png",
    });

    await stageState.setPrimTexture("/A", null);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_prim_texture", {
      stageId: 7,
      path: "/A",
      texturePath: null,
    });
  });

  it("setPrimTexture surfaces backend errors", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockRejectedValueOnce("prim not found: /A");

    const error = await stageState.setPrimTexture("/A", "/tex/checker.png");

    expect(error).toBe("prim not found: /A");
  });

  it("setAttributeValue forwards the time argument, including null", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockResolvedValue(undefined);
    const value = { type: "double3", data: [1, 2, 3] };

    // Default: the viewer's current time code.
    renderState.time = 7;
    await stageState.setAttributeValue("xformOp:translate", value as never);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_attribute_value", {
      stageId: 7,
      path: "/A",
      name: "xformOp:translate",
      value,
      time: 7,
    });

    // Explicit time codes reach the backend unchanged.
    await stageState.setAttributeValue("xformOp:translate", value as never, 42);
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_attribute_value", {
      stageId: 7,
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
      stageId: 7,
      path: "/A",
      name: "xformOpOrder",
      value: order,
      time: null,
    });
  });

  it("setAttributeValue authors an explicit path without touching the selection", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockResolvedValue(undefined);
    const value = { type: "color3f_array", data: [[1, 0, 0]] };

    const error = await stageState.setAttributeValue("primvars:displayColor", value as never, null, "/B");

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_attribute_value", {
      stageId: 7,
      path: "/B",
      name: "primvars:displayColor",
      value,
      time: null,
    });
    expect(stageState.selectedPath).toBe("/A");
  });

  it("setAttributeValues sends the whole write list in one call", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    mockedInvoke.mockResolvedValue(undefined);
    const writes = [
      { name: "xformOp:translate", value: { type: "vec3d", data: [1, 2, 3] }, time: 7 },
      { name: "xformOpOrder", value: { type: "token_array", data: ["xformOp:translate"] }, time: null },
    ];

    const error = await stageState.setAttributeValues(writes);

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_attribute_values", {
      stageId: 7,
      path: "/A",
      writes,
    });

    stageState.deselectPrim();
    expect(await stageState.setAttributeValues(writes)).toBe("no prim selected");
  });

  it("setPrimMetadata authors an explicit path and surfaces backend errors", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockResolvedValue(undefined);

    const error = await stageState.setPrimMetadata("visibility", { type: "token", data: "invisible" }, "/B");

    expect(error).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("set_prim_metadata", {
      stageId: 7,
      path: "/B",
      key: "visibility",
      value: { type: "token", data: "invisible" },
    });

    mockedInvoke.mockRejectedValueOnce("prim not found: /B");
    expect(await stageState.setPrimMetadata("visibility", { type: "token", data: "inherited" }, "/B")).toBe(
      "prim not found: /B",
    );
  });

  it("fetchPrimDetails reads an arbitrary prim without changing the selection", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");
    renderState.time = 5;
    const remote = { path: "/B", attributes: [], metadata: [], variant_sets: [], composition_arcs: [] };
    mockedInvoke.mockResolvedValueOnce(remote);

    const details = await stageState.fetchPrimDetails("/B");

    expect(details).toEqual(remote);
    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { stageId: 7, path: "/B", time: 5 });
    expect(stageState.selectedPath).toBe("/A");
    expect(stageState.details).not.toEqual(remote);
  });

  it("fetchPrimDetails returns null instead of throwing", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockRejectedValueOnce("prim not found: /B");

    expect(await stageState.fetchPrimDetails("/B")).toBeNull();
  });

  it("getMaterialInfo returns the material data and null on error", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    const bound = { name: "Mat", surface: null };

    mockedInvoke.mockResolvedValueOnce(bound);
    expect(await stageState.getMaterialInfo("/B")).toEqual(bound);
    expect(mockedInvoke).toHaveBeenLastCalledWith("get_material_data", { stageId: 7, path: "/B" });

    mockedInvoke.mockRejectedValueOnce("prim not found: /B");
    expect(await stageState.getMaterialInfo("/B")).toBeNull();
  });

  it("clear resets the whole stage state for the no-stage empty view", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    await stageState.selectPrim("/A");

    stageState.clear();

    expect(stageState.activeStageId).toBe(0);
    expect(stageState.stageInfo).toBeNull();
    expect(stageState.tree).toEqual([]);
    expect(stageState.selectedPath).toBeNull();
    expect(stageState.details).toBeNull();
    expect(stageState.status).toBe("idle");
    expect(stageState.error).toBeNull();
  });

  it("clear invalidates an in-flight tree fetch", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    const staleTree = deferred<never>();
    mockedInvoke.mockReturnValueOnce(staleTree.promise);
    const fetch = stageState.ensureTree();

    stageState.clear();
    staleTree.resolve([] as never);
    await fetch;

    expect(stageState.stageInfo).toBeNull();
    expect(stageState.tree).toEqual([]);
    expect(stageState.status).toBe("idle");
  });

  it("ensureTree fetches once per stage epoch and shares the in-flight call", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockClear();
    const tree = [{ path: "/World" }];
    mockedInvoke.mockResolvedValueOnce(tree as never);

    await Promise.all([stageState.ensureTree(), stageState.ensureTree()]);

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_stage_tree")).toHaveLength(1);
    expect(stageState.tree).toEqual(tree);

    // Cached for the epoch: a later panel mount is free.
    await stageState.ensureTree();
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_stage_tree")).toHaveLength(1);
  });

  it("a tree failure surfaces on treeError without failing the stage", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockRejectedValueOnce("walk failed");

    await stageState.ensureTree();

    expect(stageState.treeError).toBe("walk failed");
    expect(stageState.status).toBe("ready");

    mockedInvoke.mockResolvedValueOnce([{ path: "/World" }] as never);
    await stageState.ensureTree();

    expect(stageState.treeError).toBeNull();
    expect(stageState.tree).toEqual([{ path: "/World" }]);
  });

  it("an edit landing mid-fetch refetches after the in-flight tree lands", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockClear();
    const preEdit = deferred<never>();
    mockedInvoke.mockReturnValueOnce(preEdit.promise);
    const initial = stageState.ensureTree();
    const postEdit = [{ path: "/World/New" }];
    mockedInvoke.mockResolvedValueOnce(postEdit as never);

    const refresh = stageState.refreshAfterEdit();
    preEdit.resolve([{ path: "/World" }] as never);
    await Promise.all([initial, refresh]);

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_stage_tree")).toHaveLength(2);
    expect(stageState.tree).toEqual(postEdit);
  });

  it("a stage edit leaves a never-opened tree alone", async () => {
    mockedInvoke.mockResolvedValueOnce(info);
    await stageState.loadStage("/a.usda");
    mockedInvoke.mockClear();

    await stageState.refreshAfterEdit();

    expect(mockedInvoke).not.toHaveBeenCalledWith("get_stage_tree", expect.anything());
  });

  it("drops a stale edit refresh after the active stage changes", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    await stageState.ensureTree();
    const staleTree = deferred<never>();
    mockedInvoke.mockReturnValueOnce(staleTree.promise);

    const refresh = stageState.refreshAfterEdit();
    await stageState.adoptOpenedStage({ ...info, stage_id: 8 } as never);
    staleTree.resolve([{ path: "/Old" }] as never);
    await refresh;

    expect(stageState.activeStageId).toBe(8);
    expect(stageState.tree).toEqual([]);
  });

  it("refreshAfterEdit refetches a loaded tree and re-selects the prim", async () => {
    mockedInvoke.mockResolvedValueOnce(info).mockResolvedValueOnce([]);
    await stageState.loadStage("/a.usda");
    await stageState.ensureTree();
    renderState.time = 3;
    mockedInvoke.mockResolvedValueOnce(details);
    await stageState.selectPrim("/A");

    mockedInvoke.mockResolvedValueOnce([]).mockResolvedValueOnce(details);
    await stageState.refreshAfterEdit();

    expect(mockedInvoke).toHaveBeenCalledWith("get_stage_tree", { stageId: 7 });
    expect(mockedInvoke).toHaveBeenLastCalledWith("get_prim_details", { stageId: 7, path: "/A", time: 3 });
  });
});
