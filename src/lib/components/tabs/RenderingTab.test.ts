// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { CameraInfo } from "$lib/stage/types";
import { compatState, setBannerEnabled, type CompatReport } from "$lib/state/compatState.svelte";
import RenderingTab from "./RenderingTab.svelte";

const CAMERAS: CameraInfo[] = [
  {
    path: "/World/Cam_wide",
    name: "Cam_wide",
    projection: "perspective",
    focal_length: 24,
    horizontal_aperture: 36,
    vertical_aperture: 24,
    clipping_range: [1, 1000],
    world_transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  },
  {
    path: "/World/Cam_unnamed",
    name: "",
    projection: "perspective",
    focal_length: 50,
    horizontal_aperture: 36,
    vertical_aperture: 24,
    clipping_range: null,
    world_transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  },
];

const REPORT: CompatReport = {
  mode: "auto",
  applied: true,
  forced: false,
  reason: "WebKitGTK 2.52 leaks GPU fences with the Debian patch",
  distro_label: "Debian 13",
  nvidia_version: "550.54.14",
  webkit_version: "2.52.0",
  x11: true,
  debian_family: true,
};

const mockedInvoke = vi.mocked(invoke);
let instance: ReturnType<typeof mount> | null = null;

// The rendering groups this test does not exercise still read their props.
const BASE = {
  maxFps: 60,
  renderScale: 1,
  toneMapping: "ACESFilmic",
  toneExposure: 1,
  ambientIntensity: 1,
  dirIntensity: 1,
  shadowsEnabled: true,
  shadowMapSize: 1024,
  shadowMapType: "PCFSoft",
  anisotropy: 8,
  envMapIntensity: 1,
  backgroundColor: "#1e1e1e",
  lightAzimuth: 45,
  lightElevation: 45,
  lightingSource: "auto",
  sceneLightScale: 1,
  saveGraphicsPreferences: () => {},
};

function render(props: Record<string, unknown>) {
  instance = mount(RenderingTab, { target: document.body, props: { ...BASE, ...props } });
  return document.querySelector("select") as HTMLSelectElement;
}

async function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  await tick();
}

// The compat group is app-level state: reset it so a previous test cannot
// leave a report or a pending-restart hint behind.
beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (command: string) =>
    command === "compat_status" ? REPORT : undefined,
  );
  compatState.report = null;
  compatState.storedMode = null;
  compatState.dismissed = false;
  compatState.pendingRestart = false;
  setBannerEnabled(true);
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

describe("RenderingTab camera picker", () => {
  it("offers the free camera plus one option per stage camera", () => {
    const select = render({ cameras: CAMERAS, activeCameraPath: null, pickCamera: vi.fn() });

    expect([...select.options].map((option) => option.value)).toEqual([
      "free",
      "/World/Cam_wide",
      "/World/Cam_unnamed",
    ]);
    // An unnamed prim falls back to its path.
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Free camera",
      "Cam_wide",
      "/World/Cam_unnamed",
    ]);
  });

  it("shows the pinned camera, and the free camera when nothing is pinned", () => {
    expect(render({ cameras: CAMERAS, activeCameraPath: "/World/Cam_wide" }).value).toBe("/World/Cam_wide");
    unmount(instance!);
    expect(render({ cameras: CAMERAS, activeCameraPath: null }).value).toBe("free");
  });

  it("picks a camera by path and releases with the free entry", async () => {
    const pickCamera = vi.fn(async () => {});
    const select = render({ cameras: CAMERAS, activeCameraPath: null, pickCamera });

    await choose(select, "/World/Cam_wide");
    expect(pickCamera).toHaveBeenLastCalledWith("/World/Cam_wide");

    await choose(select, "free");
    expect(pickCamera).toHaveBeenLastCalledWith(null);
  });

  it("shows a failed pick under the select and puts the old value back", async () => {
    const pickCamera = vi.fn(async () => {
      throw new Error("no stage camera at /World/Nope");
    });
    const select = render({ cameras: CAMERAS, activeCameraPath: "/World/Cam_wide", pickCamera });

    await choose(select, "/World/Cam_unnamed");

    expect(document.body.textContent).toContain("no stage camera at /World/Nope");
    expect(select.value).toBe("/World/Cam_wide");
  });

  it("says so when the stage has no cameras", () => {
    const select = render({ cameras: [], activeCameraPath: null, pickCamera: vi.fn() });

    expect([...select.options].map((option) => option.value)).toEqual(["free"]);
    expect(document.body.textContent).toContain("This stage has no cameras.");
  });
});

// The compositing select is the only one that offers "Force on".
function compatSelect() {
  const selects = [...document.querySelectorAll("select")] as HTMLSelectElement[];
  const found = selects.find((select) =>
    [...select.options].some((option) => option.textContent === "Force on"),
  );
  if (found === undefined) throw new Error("no compatibility select rendered");
  return found;
}

// The report arrives from the IPC mock one microtask after mount.
async function renderCompat(props: Record<string, unknown>) {
  render(props);
  await tick();
  await tick();
  return compatSelect();
}

// The banner preference sits under the compatibility select.
function compatCheckbox(): HTMLInputElement {
  const labels = [...document.querySelectorAll("label")];
  const found = labels.find((label) => label.textContent?.includes("Show the compatibility warning"));
  if (found === undefined) throw new Error("no banner checkbox rendered");
  return found.querySelector("input")!;
}

function compatRestartChip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".compat-restart");
}

describe("RenderingTab compatibility group", () => {
  it("carries the anchor the compat notice scrolls to", async () => {
    await renderCompat({ cameras: CAMERAS });

    const group = document.getElementById("compat-group")!;
    expect(group).not.toBeNull();
    expect(group.querySelector("h3")!.textContent!.trim()).toBe("Compatibility");
    expect(group.contains(compatSelect())).toBe(true);
  });

  it("shows the three modes and the running one", async () => {
    const select = await renderCompat({ cameras: CAMERAS });

    expect([...select.options].map((option) => option.value)).toEqual(["auto", "on", "off"]);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Auto (detect)",
      "Force on",
      "Force off",
    ]);
    expect(select.value).toBe("auto");
  });

  it("shows the reason string verbatim", async () => {
    await renderCompat({ cameras: CAMERAS });

    expect(document.querySelector(".compat-reason")?.textContent).toBe(REPORT.reason);
  });

  it("selects the stored mode, not only the first option", async () => {
    mockedInvoke.mockImplementation(async (command: string) =>
      command === "compat_status" ? { ...REPORT, mode: "off" } : undefined,
    );
    const select = await renderCompat({ cameras: CAMERAS });

    expect(select.value).toBe("off");
  });

  it("shows restart-to-apply only when pending, naming the stored mode", async () => {
    await renderCompat({ cameras: CAMERAS });
    expect(document.body.textContent).not.toContain("Restart usdbee to apply");
    unmount(instance!);

    compatState.pendingRestart = true;
    await renderCompat({ cameras: CAMERAS });
    expect(document.body.textContent).toContain("Restart usdbee to apply: Auto (detect)");
  });

  it("names the mode a save stored in the restart hint", async () => {
    const select = await renderCompat({ cameras: CAMERAS });

    await choose(select, "off");

    expect(select.value).toBe("off");
    expect(document.body.textContent).toContain("Restart usdbee to apply: Force off");
  });

  it("selecting a mode forwards it to the backend", async () => {
    const select = await renderCompat({ cameras: CAMERAS });

    await choose(select, "off");

    expect(mockedInvoke).toHaveBeenCalledWith("set_compat_pref", { mode: "off" });
  });

  it("announces a rejected mode and keeps the stored one selected", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "compat_status") return REPORT;
      throw "cannot resolve the config directory";
    });
    const select = await renderCompat({ cameras: CAMERAS });

    await choose(select, "off");

    expect(document.querySelector("[role='alert']")?.textContent).toBe("cannot resolve the config directory");
    expect(select.value).toBe("auto");
  });

  it("disables the select and says the guard does not apply off Linux", async () => {
    mockedInvoke.mockImplementation(async (command: string) =>
      command === "compat_status" ? { ...REPORT, webkit_version: "0.0.0" } : undefined,
    );
    const select = await renderCompat({ cameras: CAMERAS });

    expect(select.disabled).toBe(true);
    expect(document.body.textContent).toContain("Not applicable on this platform");
  });

  it("keeps the select usable and the note absent on WebKitGTK", async () => {
    mockedInvoke.mockImplementation(async (command: string) =>
      command === "compat_status" ? { ...REPORT, webkit_version: "2.52.6" } : undefined,
    );
    const select = await renderCompat({ cameras: CAMERAS });

    expect(select.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Not applicable on this platform");
  });

  it("says so when no report is available yet", async () => {
    mockedInvoke.mockRejectedValue("ipc unavailable");
    render({ cameras: CAMERAS });
    await tick();
    await tick();

    expect(document.body.textContent).toContain("Compatibility status unavailable");
    // No report means no mode: the select has nothing to show.
    const select = document.querySelector("select[disabled]") as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("offers the banner checkbox, checked while the preference is on", async () => {
    await renderCompat({ cameras: CAMERAS });

    const checkbox = compatCheckbox();
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
  });

  it("hides the banner at once when the checkbox is cleared", async () => {
    await renderCompat({ cameras: CAMERAS });

    compatCheckbox().click();
    await tick();

    expect(compatState.bannerEnabled).toBe(false);
    expect(compatCheckbox().checked).toBe(false);
  });

  it("shows the checkbox as cleared when the preference is off", async () => {
    setBannerEnabled(false);
    await renderCompat({ cameras: CAMERAS });

    expect(compatCheckbox().checked).toBe(false);
  });

  it("disables the banner checkbox where the guard does not apply", async () => {
    mockedInvoke.mockImplementation(async (command: string) =>
      command === "compat_status" ? { ...REPORT, webkit_version: "0.0.0" } : undefined,
    );
    await renderCompat({ cameras: CAMERAS });

    expect(compatCheckbox().disabled).toBe(true);
  });

  it("renders the restart hint as a warning chip only while pending", async () => {
    await renderCompat({ cameras: CAMERAS });
    expect(compatRestartChip()).toBeNull();
    unmount(instance!);

    compatState.pendingRestart = true;
    await renderCompat({ cameras: CAMERAS });

    const chip = compatRestartChip()!;
    expect(chip.textContent!.trim()).toBe("Restart usdbee to apply: Auto (detect)");
    expect(chip.tagName).toBe("P");
  });
});
