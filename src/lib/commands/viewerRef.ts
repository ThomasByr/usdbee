// The palette runs in production, where nothing hands it the RendererKit the
// dev bridge is given: the Viewport publishes the live viewer here on mount
// and clears it on teardown. Not reactive state, so no runes.
import type { BridgeViewer } from "./dispatch";

let viewer: BridgeViewer | null = null;

export function setBridgeViewer(v: BridgeViewer | null): void {
  viewer = v;
}

export function bridgeViewer(): BridgeViewer | null {
  return viewer;
}
