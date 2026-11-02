// Stage `upAxis` correction for the Y-up three.js scene.
//
// "Z" → -90° about X maps USD (x,y,z) to three.js (x,z,-y), so a Z-up
// stage stands on the horizontal grid. "Y" (and anything unrecognized —
// the backend already normalizes those to "Y") → no rotation.

export function upAxisRotation(up: string): number {
  if (up === "Z") return -Math.PI / 2;
  if (up !== "Y") {
    console.warn(`unrecognized stage upAxis '${up}' — treating as Y`);
  }
  return 0;
}
