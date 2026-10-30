import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { stageState } from "./stageState.svelte";

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
});
