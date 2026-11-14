// The KTX2 loader fetches /basis/basis_transcoder.js from the served root, so
// the vendored pair must live in static/ (Vite serves it in dev and copies it
// into the build output). A 404 there falls back to the material's constant
// colour, with no error anyone sees.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("basis transcoder assets", () => {
  it("sits in static/basis, which SvelteKit serves at /basis/", () => {
    for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
      const path = fileURLToPath(new URL(`../../../static/basis/${name}`, import.meta.url));
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("is not left behind in public/, which SvelteKit does not serve", () => {
    const path = fileURLToPath(new URL("../../../public/basis", import.meta.url));
    expect(existsSync(path), path).toBe(false);
  });
});
