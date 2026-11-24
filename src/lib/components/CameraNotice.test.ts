// @vitest-environment happy-dom
// The card is a guard and a keyed wrapper: nothing while the notice is empty,
// the text as a polite status otherwise.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CameraNotice from "./CameraNotice.svelte";
import { cameraNotice, resetCameraNoticeTimer, showCameraNotice } from "$lib/state/cameraNotice.svelte";

let host: HTMLElement;
let component: ReturnType<typeof mount>;

beforeEach(() => {
  resetCameraNoticeTimer();
  cameraNotice.text = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CameraNotice, { target: host });
});

afterEach(() => {
  resetCameraNoticeTimer();
  unmount(component);
  host.remove();
});

describe("CameraNotice", () => {
  it("renders nothing before a notice", () => {
    flushSync();
    expect(host.querySelector(".camera-notice")).toBeNull();
  });

  it("announces the camera as a polite status", () => {
    showCameraNotice("Camera: Cam_wide");
    flushSync();

    const card = host.querySelector(".camera-notice")!;
    expect(card.textContent!.trim()).toBe("Camera: Cam_wide");
    expect(card.getAttribute("role")).toBe("status");
    expect(card.getAttribute("aria-live")).toBe("polite");
  });

  it("remounts the card so a second camera restarts the fade", () => {
    showCameraNotice("Camera: Cam_wide");
    flushSync();
    const first = host.querySelector(".camera-notice");

    showCameraNotice("Camera: Cam_tele");
    flushSync();
    const second = host.querySelector(".camera-notice");

    expect(second!.textContent!.trim()).toBe("Camera: Cam_tele");
    expect(second).not.toBe(first);
  });
});
