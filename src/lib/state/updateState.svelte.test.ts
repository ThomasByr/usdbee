// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

// The support probe is cached per module instance, so each test gets a fresh
// module graph instead of a reset hook the production code does not need.
async function load() {
  vi.resetModules();
  const core = await import("@tauri-apps/api/core");
  const updater = await import("@tauri-apps/plugin-updater");
  const state = await import("./updateState.svelte");
  const invoke = vi.mocked(core.invoke);
  invoke.mockResolvedValue(true);
  return {
    invoke,
    check: vi.mocked(updater.check),
    updateState: state.updateState,
    checkForUpdates: state.checkForUpdates,
  };
}

describe("updateState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports error status when the endpoint is unreachable", async () => {
    const { check, updateState, checkForUpdates } = await load();
    check.mockRejectedValue(new Error("network unreachable"));

    await checkForUpdates();

    expect(updateState.status).toBe("error");
    expect(updateState.message).toBe("network unreachable");
  });

  it("does not open a modal for a silent check that fails", async () => {
    const { check, updateState, checkForUpdates } = await load();
    check.mockRejectedValue(new Error("offline"));

    await checkForUpdates({ silent: true });

    expect(updateState.status).toBe("idle");
    expect(updateState.message).toBe("");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("runs only one check while one is in flight", async () => {
    const { check, checkForUpdates } = await load();
    let resolve!: (value: null) => void;
    check.mockReturnValue(new Promise<null>((r) => (resolve = r)) as never);

    const first = checkForUpdates();
    const second = checkForUpdates();
    resolve(null);
    await Promise.all([first, second]);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it("refuses to check on Linux without an AppImage", async () => {
    const { invoke, check, updateState, checkForUpdates } = await load();
    invoke.mockResolvedValue(false);

    await checkForUpdates();

    expect(updateState.status).toBe("unsupported");
    expect(check).not.toHaveBeenCalled();
  });
});
