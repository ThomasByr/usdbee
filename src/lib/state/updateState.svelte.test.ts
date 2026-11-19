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
  const process = await import("@tauri-apps/plugin-process");
  const state = await import("./updateState.svelte");
  const invoke = vi.mocked(core.invoke);
  invoke.mockResolvedValue(true);
  return {
    invoke,
    check: vi.mocked(updater.check),
    relaunch: vi.mocked(process.relaunch),
    updateState: state.updateState,
    checkForUpdates: state.checkForUpdates,
    installUpdate: state.installUpdate,
  };
}

function fakeUpdate(overrides: Record<string, unknown> = {}) {
  return { version: "9.9.9", close: vi.fn(), downloadAndInstall: vi.fn(async () => {}), ...overrides };
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

  it("refuses to check while a download is in progress", async () => {
    const { check, updateState, checkForUpdates, installUpdate } = await load();
    check.mockResolvedValue(fakeUpdate() as never);
    await checkForUpdates();
    expect(updateState.status).toBe("available");

    void installUpdate();
    expect(updateState.status).toBe("downloading");
    check.mockClear();

    await checkForUpdates();

    expect(check).not.toHaveBeenCalled();
    expect(updateState.status).toBe("downloading");
    expect(updateState.message).toBe("");
  });

  it("reports a failure when a user click joins a silent check", async () => {
    const { check, updateState, checkForUpdates } = await load();
    let reject!: (e: unknown) => void;
    check.mockReturnValue(new Promise((_, r) => (reject = r)) as never);

    const startup = checkForUpdates({ silent: true });
    const clicked = checkForUpdates();
    reject(new Error("offline"));
    await Promise.all([startup, clicked]);

    expect(check).toHaveBeenCalledTimes(1);
    expect(updateState.status).toBe("error");
    expect(updateState.message).toBe("offline");
  });

  it("reports an error when the relaunch fails", async () => {
    const { check, relaunch, updateState, checkForUpdates, installUpdate } = await load();
    relaunch.mockRejectedValue(new Error("no permission"));
    check.mockResolvedValue(fakeUpdate() as never);

    await checkForUpdates();
    await installUpdate();

    expect(updateState.status).toBe("error");
    expect(updateState.message).toContain("no permission");
  });

  it("resets progress when the download fails", async () => {
    const { check, updateState, checkForUpdates, installUpdate } = await load();
    check.mockResolvedValue(
      fakeUpdate({ downloadAndInstall: vi.fn(async () => Promise.reject(new Error("disk full"))) }) as never,
    );

    await checkForUpdates();
    updateState.progress = 0.4;
    await installUpdate();

    expect(updateState.status).toBe("error");
    expect(updateState.progress).toBe(0);
    expect(updateState.message).toBe("disk full");
  });
});
