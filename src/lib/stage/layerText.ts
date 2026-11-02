import type { LayerInfo } from "./types";

export type LayerTextRevisionAction = "none" | "reload" | "conflict";

// A newer stage invalidates the draft's base revision. Clean drafts can
// reload; dirty drafts must explicitly resolve the conflict instead.
export function layerTextRevisionAction(
  loadedRevision: number,
  stageRevision: number,
  dirty: boolean,
): LayerTextRevisionAction {
  if (loadedRevision === stageRevision) return "none";
  return dirty ? "conflict" : "reload";
}

// The selector label for one stage layer: session layers read "Session
// layer" (their identifier is a generated temp path), file-backed layers
// read their file name.
export function layerDisplayName(layer: LayerInfo): string {
  if (layer.is_session) return "Session layer";
  const name = layer.identifier.split(/[\\/]/).pop();
  return name && name.length > 0 ? name : layer.identifier;
}
