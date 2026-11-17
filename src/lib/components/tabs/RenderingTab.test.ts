// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { CameraInfo } from "$lib/stage/types";
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
