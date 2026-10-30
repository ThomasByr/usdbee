import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { stageState } from "./stageState.svelte";

const info = { path: "/a.usda" };
const details = { path: "/A" } as never;

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("stageState.loadStage", () => {
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
});
