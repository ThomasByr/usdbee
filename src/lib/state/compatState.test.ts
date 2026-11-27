import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockedInvoke }));

import type { CompatReport } from "./compatState.svelte";

// The module keeps the last accepted mode in module scope, so each test needs
// a fresh instance to start without one.
type CompatModule = typeof import("./compatState.svelte");

let mod: CompatModule;
let compatState: CompatModule["compatState"];

function report(overrides: Partial<CompatReport> = {}): CompatReport {
  return {
    mode: "auto",
    applied: true,
    forced: false,
    reason: "Hardware compositing is off: leaks GPU fences while scrolling.",
    distro_label: "Ubuntu 24.04",
    nvidia_version: "580.178.04",
    webkit_version: "2.52.6",
    x11: true,
    debian_family: true,
    ...overrides,
  };
}

beforeEach(async () => {
  mockedInvoke.mockReset();
  vi.resetModules();
  mod = await import("./compatState.svelte");
  compatState = mod.compatState;
});

describe("compatState", () => {
  it("stores the report from compat_status", async () => {
    const stored = report();
    mockedInvoke.mockResolvedValueOnce(stored);

    await mod.loadCompatReport();

    expect(mockedInvoke).toHaveBeenCalledWith("compat_status");
    expect(compatState.report).toEqual(stored);
  });

  it("keeps the UI quiet when compat_status rejects", async () => {
    compatState.report = report();
    mockedInvoke.mockRejectedValueOnce("no backend");

    await expect(mod.loadCompatReport()).resolves.toBeUndefined();

    expect(compatState.report).toBeNull();
  });

  it("notice is visible only when auto applied and not dismissed", () => {
    const base = report();
    expect(mod.compatNoticeVisible(base, false)).toBe(true);
    expect(mod.compatNoticeVisible(base, true)).toBe(false);
    expect(mod.compatNoticeVisible({ ...base, applied: false }, false)).toBe(false);
    expect(mod.compatNoticeVisible({ ...base, mode: "off" }, false)).toBe(false);
    expect(mod.compatNoticeVisible({ ...base, mode: "on" }, false)).toBe(false);
    expect(mod.compatNoticeVisible(null, false)).toBe(false);
  });

  it("dismiss hides the notice", async () => {
    mockedInvoke.mockResolvedValueOnce(report());
    await mod.loadCompatReport();
    expect(mod.compatNoticeVisible(compatState.report, compatState.dismissed)).toBe(true);

    mod.dismissCompatNotice();

    expect(compatState.dismissed).toBe(true);
    expect(mod.compatNoticeVisible(compatState.report, compatState.dismissed)).toBe(false);
  });

  it("setting a different mode marks a restart pending and forwards the mode", async () => {
    mockedInvoke.mockResolvedValueOnce(report({ mode: "auto" }));
    await mod.loadCompatReport();
    mockedInvoke.mockResolvedValueOnce(undefined);

    expect(await mod.setCompatMode("off")).toBeNull();

    expect(mockedInvoke).toHaveBeenLastCalledWith("set_compat_pref", { mode: "off" });
    expect(compatState.pendingRestart).toBe(true);
    // The running process keeps its decision: the report is untouched.
    expect(compatState.report?.mode).toBe("auto");
  });

  it("setting the running mode clears the restart hint", async () => {
    mockedInvoke.mockResolvedValueOnce(report({ mode: "on", applied: false, forced: true }));
    await mod.loadCompatReport();
    mockedInvoke.mockResolvedValueOnce(undefined);
    await mod.setCompatMode("off");
    expect(compatState.pendingRestart).toBe(true);

    mockedInvoke.mockResolvedValueOnce(undefined);

    expect(await mod.setCompatMode("on")).toBeNull();
    expect(compatState.pendingRestart).toBe(false);
  });

  it("surfaces the backend error string and keeps no hint without an accepted save", async () => {
    mockedInvoke.mockResolvedValueOnce(report({ mode: "auto" }));
    await mod.loadCompatReport();
    mockedInvoke.mockRejectedValueOnce("cannot resolve the config directory");

    expect(await mod.setCompatMode("off")).toBe("cannot resolve the config directory");
    expect(compatState.pendingRestart).toBe(false);
  });

  it("keeps the hint honest when a later save rejects", async () => {
    mockedInvoke.mockResolvedValueOnce(report({ mode: "auto" }));
    await mod.loadCompatReport();
    mockedInvoke.mockResolvedValueOnce(undefined);
    await mod.setCompatMode("off");
    expect(compatState.pendingRestart).toBe(true);

    mockedInvoke.mockRejectedValueOnce("disk full");

    expect(await mod.setCompatMode("on")).toBe("disk full");
    // "off" is what the file holds, and it still differs from the started mode.
    expect(compatState.pendingRestart).toBe(true);
  });
});
