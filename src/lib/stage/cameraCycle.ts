import type { CameraInfo } from "./types";

export type CameraChoice = { kind: "free" } | { kind: "camera"; path: string };

// The next entry of the cycle: the free camera first, then the stage cameras in
// traversal order, wrapping back to free. A pinned path the stage no longer has
// counts as free, so the press lands on the first camera instead of nowhere.
export function nextCameraChoice(cameras: CameraInfo[], currentPath: string | null): CameraChoice {
  if (cameras.length === 0) return { kind: "free" };
  const index = currentPath === null ? -1 : cameras.findIndex((camera) => camera.path === currentPath);
  if (index === -1) return { kind: "camera", path: cameras[0].path };
  if (index === cameras.length - 1) return { kind: "free" };
  return { kind: "camera", path: cameras[index + 1].path };
}
