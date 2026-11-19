// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.2.3") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));

import AboutModal from "./AboutModal.svelte";
import { invoke } from "@tauri-apps/api/core";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
});

async function open(full: boolean): Promise<string> {
  instance = mount(AboutModal, { target: document.body, props: { onClose: () => {}, full } });
  // The version and build calls settle before the rows are worth reading.
  await tick();
  await tick();
  return document.body.textContent ?? "";
}

describe("AboutModal", () => {
  it("compact dialog keeps the update section and drops the identity rows", async () => {
    const text = await open(false);
    expect(text).toContain("Update usdbee");
    expect(text).toContain("Updates");
    expect(text).not.toContain("github.com/ThomasByr/usdbee");
    expect(text).not.toContain("MIT");
  });

  it("full dialog shows the identity rows and the update section", async () => {
    const text = await open(true);
    expect(text).toContain("About usdbee");
    expect(text).toContain("github.com/ThomasByr/usdbee");
    expect(text).toContain("MIT");
    expect(text).toContain("Updates");
  });

  it("full dialog samples memory once a second while open", async () => {
    vi.useFakeTimers();
    try {
      const calls = vi.mocked(invoke);
      calls.mockClear();
      instance = mount(AboutModal, { target: document.body, props: { onClose: () => {}, full: true } });
      await vi.advanceTimersByTimeAsync(1000);
      const afterOneSecond = calls.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(afterOneSecond).toBeGreaterThanOrEqual(2);
      expect(calls.mock.calls.length).toBeGreaterThan(afterOneSecond);
      unmount(instance);
      instance = null;
      const atUnmount = calls.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls.mock.calls.length).toBe(atUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("compact dialog never samples the build info", async () => {
    vi.useFakeTimers();
    try {
      const calls = vi.mocked(invoke);
      calls.mockClear();
      instance = mount(AboutModal, { target: document.body, props: { onClose: () => {}, full: false } });
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
