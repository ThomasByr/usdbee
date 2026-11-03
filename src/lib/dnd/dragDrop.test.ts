// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockOnDragDropEvent } = vi.hoisted(() => ({
  mockOnDragDropEvent: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => ({ onDragDropEvent: mockOnDragDropEvent })),
}));

import { droppedUsdPaths, isUsdFilePath, initDragDrop } from "./dragDrop";

let dropHandler: ((event: { payload: unknown }) => void) | null = null;

function drop(paths: string[]): void {
  dropHandler?.({ payload: { type: "drop", paths } });
}

beforeEach(() => {
  dropHandler = null;
  mockOnDragDropEvent
    .mockReset()
    .mockImplementation(async (handler: (event: { payload: unknown }) => void) => {
      dropHandler = handler;
      return () => {
        dropHandler = null;
      };
    });
});

describe("isUsdFilePath", () => {
  it("accepts all four USD extensions, case-insensitively", () => {
    expect(isUsdFilePath("/scene/a.usd")).toBe(true);
    expect(isUsdFilePath("/scene/a.usda")).toBe(true);
    expect(isUsdFilePath("/scene/a.usdc")).toBe(true);
    expect(isUsdFilePath("/scene/a.usdz")).toBe(true);
    expect(isUsdFilePath("/scene/A.USDA")).toBe(true);
  });

  it("refuses other extensions, extensionless and double-extension paths", () => {
    expect(isUsdFilePath("/scene/a.png")).toBe(false);
    expect(isUsdFilePath("/scene/readme")).toBe(false);
    expect(isUsdFilePath("/scene/a.usda.png")).toBe(false);
  });
});

describe("droppedUsdPaths", () => {
  it("passes an all-USD drop through in order", () => {
    expect(droppedUsdPaths(["/scene/b.usdc", "/scene/a.usda", "/scene/c.usdz"])).toEqual([
      "/scene/b.usdc",
      "/scene/a.usda",
      "/scene/c.usdz",
    ]);
  });

  it("refuses a mixed drop entirely", () => {
    expect(droppedUsdPaths(["/scene/a.usda", "/scene/notes.txt"])).toEqual([]);
  });

  it("refuses non-USD and empty drops", () => {
    expect(droppedUsdPaths(["/scene/notes.txt"])).toEqual([]);
    expect(droppedUsdPaths(["/scene/noextension"])).toEqual([]);
    expect(droppedUsdPaths([])).toEqual([]);
  });
});

describe("initDragDrop", () => {
  it("opens each dropped USD path in drop order", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    await initDragDrop(open, onError);

    drop(["/scene/b.usda", "/scene/a.usdz"]);

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open).toHaveBeenNthCalledWith(1, "/scene/b.usda");
    expect(open).toHaveBeenNthCalledWith(2, "/scene/a.usdz");
    expect(onError).not.toHaveBeenCalled();
  });

  it("refuses a mixed drop without opening anything, surfacing an error", async () => {
    const open = vi.fn();
    const onError = vi.fn();
    await initDragDrop(open, onError);

    drop(["/scene/a.usda", "/scene/evil.exe"]);

    expect(open).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("USD");
  });

  it("ignores hover and leave events", async () => {
    const open = vi.fn();
    const onError = vi.fn();
    await initDragDrop(open, onError);

    dropHandler?.({ payload: { type: "over", position: { x: 1, y: 2 } } });
    dropHandler?.({ payload: { type: "leave" } });

    expect(open).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns an unlisten that stops the handler", async () => {
    const open = vi.fn();
    const onError = vi.fn();
    const unlisten = await initDragDrop(open, onError);

    await unlisten();
    drop(["/scene/a.usda"]);

    expect(open).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
