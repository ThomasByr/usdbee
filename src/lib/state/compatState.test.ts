import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  compatNoticeVisible,
  compatState,
  dismissCompatNotice,
  loadCompatReport,
  setCompatMode,
  type CompatReport,
} from "./compatState.svelte";

const mockedInvoke = vi.mocked(invoke);

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

beforeEach(() => {
  mockedInvoke.mockReset();
  compatState.report = null;
  compatState.dismissed = false;
  compatState.pendingRestart = false;
});

describe("compatState", () => {
  it("stores the report from compat_status", async () => {
    const stored = report();
    mockedInvoke.mockResolvedValueOnce(stored);

    await loadCompatReport();

    expect(mockedInvoke).toHaveBeenCalledWith("compat_status");
    expect(compatState.report).toEqual(stored);
  });

  it("keeps the UI quiet when compat_status rejects", async () => {
    compatState.report = report();
    mockedInvoke.mockRejectedValueOnce("no backend");

    await expect(loadCompatReport()).resolves.toBeUndefined();

    expect(compatState.report).toBeNull();
  });

  it("notice is visible only when auto applied and not dismissed", () => {
    const base = report();
    expect(compatNoticeVisible(base, false)).toBe(true);
    expect(compatNoticeVisible(base, true)).toBe(false);
    expect(compatNoticeVisible({ ...base, applied: false }, false)).toBe(false);
    expect(compatNoticeVisible({ ...base, mode: "off" }, false)).toBe(false);
    expect(compatNoticeVisible({ ...base, mode: "on" }, false)).toBe(false);
    expect(compatNoticeVisible(null, false)).toBe(false);
  });

  it("dismiss hides the notice", async () => {
    mockedInvoke.mockResolvedValueOnce(report());
    await loadCompatReport();
    expect(compatNoticeVisible(compatState.report, compatState.dismissed)).toBe(true);

    dismissCompatNotice();

    expect(compatState.dismissed).toBe(true);
    expect(compatNoticeVisible(compatState.report, compatState.dismissed)).toBe(false);
  });

  it("setting a different mode marks a restart pending and forwards the mode", async () => {
    mockedInvoke.mockResolvedValueOnce(report({ mode: "auto" }));
    await loadCompatReport();
    mockedInvoke.mockResolvedValueOnce(undefined);

    expect(await setCompatMode("off")).toBeNull();

    expect(mockedInvoke).toHaveBeenLastCalledWith("set_compat_pref", { mode: "off" });
    expect(compatState.pendingRestart).toBe(true);
    // The running process keeps its decision: the report is untouched.
    expect(compatState.report?.mode).toBe("auto");
  });

  it("setting the running mode clears the restart hint", async () => {
    mockedInvoke.mockResolvedValueOnce(report({ mode: "on", applied: false, forced: true }));
    await loadCompatReport();
    mockedInvoke.mockResolvedValueOnce(undefined);
    await setCompatMode("off");
    expect(compatState.pendingRestart).toBe(true);

    mockedInvoke.mockResolvedValueOnce(undefined);

    expect(await setCompatMode("on")).toBeNull();
    expect(compatState.pendingRestart).toBe(false);
  });

  it("surfaces the backend error string and leaves the restart hint alone", async () => {
    mockedInvoke.mockResolvedValueOnce(report({ mode: "auto" }));
    await loadCompatReport();
    mockedInvoke.mockRejectedValueOnce("cannot resolve the config directory");

    expect(await setCompatMode("off")).toBe("cannot resolve the config directory");
    expect(compatState.pendingRestart).toBe(false);

    mockedInvoke.mockResolvedValueOnce(undefined);
    await setCompatMode("off");
    mockedInvoke.mockRejectedValueOnce("disk full");

    expect(await setCompatMode("on")).toBe("disk full");
    expect(compatState.pendingRestart).toBe(true);
  });
});
