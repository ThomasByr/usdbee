// three.js redraws every shadow caster into the shadow map on every
// render() by default. Camera-only motion (orbit, zoom, pan) never moves a
// caster, so the map is drawn on demand instead, and every trigger answers
// one question: can a caster or the light have moved?

import type * as THREE from "three";

export interface ShadowMapState {
  autoUpdate: boolean;
  needsUpdate: boolean;
}

let pending = false;

export function initOnDemandShadows(shadowMap: ShadowMapState) {
  shadowMap.autoUpdate = false;
  // The map texture does not exist yet: without a request the first render
  // has no shadows at all.
  requestShadowUpdate();
}

export function requestShadowUpdate() {
  pending = true;
}

export function consumeShadowUpdate(): boolean {
  const requested = pending;
  pending = false;
  return requested;
}

// Every draw site goes through here: it is the one place that hands a
// pending request to three.js, which clears needsUpdate once it has drawn
// the map.
export function renderWithShadowUpdate(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  if (consumeShadowUpdate()) renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
}
