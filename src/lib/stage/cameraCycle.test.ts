import { describe, expect, it } from "vitest";

import { nextCameraChoice } from "./cameraCycle";
import type { CameraInfo } from "./types";

// Only path and name are read by the cycle.
function cam(path: string, name = path): CameraInfo {
  return { path, name } as CameraInfo;
}

const WIDE = cam("/World/Cam_wide");
const TELE = cam("/World/Cam_tele");

describe("nextCameraChoice", () => {
  it("goes from the free camera to the first stage camera", () => {
    expect(nextCameraChoice([WIDE, TELE], null)).toEqual({ kind: "camera", path: "/World/Cam_wide" });
  });

  it("advances to the next camera", () => {
    expect(nextCameraChoice([WIDE, TELE], "/World/Cam_wide")).toEqual({
      kind: "camera",
      path: "/World/Cam_tele",
    });
  });

  it("returns to the free camera after the last one", () => {
    expect(nextCameraChoice([WIDE, TELE], "/World/Cam_tele")).toEqual({ kind: "free" });
  });

  it("takes a pinned path the stage no longer lists as the free camera", () => {
    expect(nextCameraChoice([WIDE, TELE], "/World/Gone")).toEqual({
      kind: "camera",
      path: "/World/Cam_wide",
    });
  });

  it("stays on the free camera with no cameras", () => {
    expect(nextCameraChoice([], null)).toEqual({ kind: "free" });
  });
});
