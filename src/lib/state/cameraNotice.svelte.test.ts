import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_NOTICE_MS,
  cameraNotice,
  clearCameraNotice,
  resetCameraNoticeTimer,
  showCameraNotice,
} from "./cameraNotice.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  resetCameraNoticeTimer();
  cameraNotice.text = null;
});

afterEach(() => {
  resetCameraNoticeTimer();
  vi.useRealTimers();
});

describe("cameraNotice", () => {
  it("shows the text and bumps the key its fade restarts on", () => {
    const seq = cameraNotice.seq;
    showCameraNotice("Camera: Cam_wide");

    expect(cameraNotice.text).toBe("Camera: Cam_wide");
    expect(cameraNotice.seq).toBe(seq + 1);
  });

  it("clears the text after the notice window", () => {
    showCameraNotice("Camera: Free");

    vi.advanceTimersByTime(CAMERA_NOTICE_MS - 1);
    expect(cameraNotice.text).toBe("Camera: Free");
    const seq = cameraNotice.seq;

    vi.advanceTimersByTime(1);
    expect(cameraNotice.text).toBeNull();
    expect(cameraNotice.seq).toBe(seq + 1);
  });

  it("replaces the text and restarts the timer on a second call", () => {
    showCameraNotice("Camera: Cam_wide");
    vi.advanceTimersByTime(CAMERA_NOTICE_MS - 1);

    showCameraNotice("Camera: Cam_tele");
    // The first call's timer would have fired here.
    vi.advanceTimersByTime(2);
    expect(cameraNotice.text).toBe("Camera: Cam_tele");

    vi.advanceTimersByTime(CAMERA_NOTICE_MS);
    expect(cameraNotice.text).toBeNull();
  });

  it("clears immediately on request", () => {
    showCameraNotice("This stage has no cameras");
    clearCameraNotice();

    expect(cameraNotice.text).toBeNull();
    // The dropped timer must not bump the sequence later.
    const seq = cameraNotice.seq;
    vi.advanceTimersByTime(CAMERA_NOTICE_MS * 2);
    expect(cameraNotice.seq).toBe(seq);
  });
});
