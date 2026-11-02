import type { LayerInfo } from "./types";

// The selector label for one stage layer: session layers read "Session
// layer" (their identifier is a generated temp path), file-backed layers
// read their file name.
export function layerDisplayName(layer: LayerInfo): string {
  if (layer.is_session) return "Session layer";
  const name = layer.identifier.split(/[\\/]/).pop();
  return name && name.length > 0 ? name : layer.identifier;
}
