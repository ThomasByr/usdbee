// The launch path: CLI files open as tabs, then an initial camera pin through
// the same command the palette runs. Once per run, whatever the backend says.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("$lib/state/tabsState.svelte", () => ({ tabsState: { openTab: vi.fn(async () => {}) } }));
vi.mock("./dispatch", () => ({ dispatchCommand: vi.fn(async () => ({})) }));
vi.mock("./viewerRef", () => ({ bridgeViewer: vi.fn(() => null) }));

import { invoke } from "@tauri-apps/api/core";
import { tabsState } from "$lib/state/tabsState.svelte";
import { dispatchCommand } from "./dispatch";
import { bridgeViewer } from "./viewerRef";

const invocation = vi.mocked(invoke);
const openTab = vi.mocked(tabsState.openTab);
const dispatch = vi.mocked(dispatchCommand);
const viewer = vi.mocked(bridgeViewer);

const fakeViewer = { camera: {} } as never;

async function load() {
  vi.resetModules();
  return import("./launch");
}

function payload(
  files: string[],
  position: [number, number, number] | null,
  target: [number, number, number] | null,
) {
  return { files, camera_position: position, camera_target: target };
}

beforeEach(() => {
  vi.clearAllMocks();
  invocation.mockResolvedValue(payload([], null, null));
  viewer.mockReturnValue(null);
});

describe("consumeLaunchOptions", () => {
  it("opens one tab per file, in order", async () => {
    invocation.mockResolvedValue(payload(["a.usd", "b.usda"], null, null));
    const { consumeLaunchOptions } = await load();

    await consumeLaunchOptions();

    expect(openTab.mock.calls.map((call) => call[0])).toEqual(["a.usd", "b.usda"]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("pins the camera with only the given channels", async () => {
    viewer.mockReturnValue(fakeViewer);
    invocation.mockResolvedValue(payload([], [1, 2, 3], null));
    const { consumeLaunchOptions } = await load();

    await consumeLaunchOptions();

    expect(dispatch).toHaveBeenCalledWith(fakeViewer, "set_camera", { position: [1, 2, 3] });
  });

  it("passes both channels when both are given, after the files open", async () => {
    viewer.mockReturnValue(fakeViewer);
    invocation.mockResolvedValue(payload(["a.usd"], [1, 2, 3], [4, 5, 6]));
    const { consumeLaunchOptions } = await load();

    await consumeLaunchOptions();

    expect(dispatch).toHaveBeenCalledWith(fakeViewer, "set_camera", {
      position: [1, 2, 3],
      target: [4, 5, 6],
    });
    expect(openTab.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
  });

  it("skips the camera pin without a viewer", async () => {
    invocation.mockResolvedValue(payload([], [1, 2, 3], [4, 5, 6]));
    const { consumeLaunchOptions } = await load();

    await consumeLaunchOptions();

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    invocation.mockResolvedValue(payload(["a.usd"], null, null));
    const { consumeLaunchOptions } = await load();

    await consumeLaunchOptions();
    await consumeLaunchOptions();

    expect(invocation).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the backend has no options", async () => {
    invocation.mockRejectedValue("no CLI options");
    const { consumeLaunchOptions } = await load();

    await expect(consumeLaunchOptions()).resolves.toBeUndefined();

    expect(openTab).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
