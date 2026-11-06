// The maxFps gate, as a decision over a clock the callback samples itself.
// The rAF timestamp is not a reliable "when did this frame run" (WebKitGTK
// reports the webview's clock, not the display refresh), so gating on it turns
// timestamp jitter into render-cadence wobble.

/** A frame landing a hair under the interval must not be pushed a whole frame later. */
export const FPS_EPSILON_MS = 1;

/** True once a whole maxFps interval has elapsed since the last render. */
export function shouldRenderFrame(now: number, lastFrameTime: number, interval: number): boolean {
  return now - lastFrameTime >= interval - FPS_EPSILON_MS;
}

/**
 * Anchor for the next decision: a whole number of intervals after the previous
 * one, so skipped frames leave no phase error behind.
 */
export function nextFrameTime(now: number, lastFrameTime: number, interval: number): number {
  return now - ((now - lastFrameTime) % interval);
}
