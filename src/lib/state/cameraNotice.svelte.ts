// The transient card naming the camera the view landed on. Dispatch owns the
// calls so the keyboard and the palette show the same notice.

export const CAMERA_NOTICE_MS = 2000;

// `seq` lets the card restart its fade when the same text comes twice.
export const cameraNotice = $state({ text: null as string | null, seq: 0 });

let timer: ReturnType<typeof setTimeout> | null = null;

export function resetCameraNoticeTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

export function clearCameraNotice(): void {
  resetCameraNoticeTimer();
  cameraNotice.text = null;
}

export function showCameraNotice(text: string): void {
  resetCameraNoticeTimer();
  cameraNotice.text = text;
  cameraNotice.seq += 1;
  timer = setTimeout(() => {
    timer = null;
    cameraNotice.text = null;
    cameraNotice.seq += 1;
  }, CAMERA_NOTICE_MS);
}
