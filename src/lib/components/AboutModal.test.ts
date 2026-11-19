// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.2.3") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));

import AboutModal from "./AboutModal.svelte";

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
});
