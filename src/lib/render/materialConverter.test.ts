import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { convertMaterial } from "./materialConverter";
import type { MaterialInfo, PreviewSurface, TextureInput } from "../stage/types";

function surface(over: Partial<PreviewSurface> = {}): PreviewSurface {
  return {
    diffuse_color: null,
    roughness: null,
    metallic: null,
    opacity: null,
    normal: null,
    textures: [],
    ...over,
  };
}

function textureInput(over: Partial<TextureInput> = {}): TextureInput {
  return { input: "diffuseColor", file_path: "/cache/checker.png", st_primvar: "st", ...over };
}

// Stand-in for Task 4's convertFileSrc-backed loader: returns a texture for
// every path by default, null for paths containing "missing".
const loader = (path: string): THREE.Texture | null =>
  path.includes("missing") ? null : new THREE.Texture();

describe("convertMaterial", () => {
  it("maps constant channels onto MeshPhysicalMaterial", () => {
    const material = convertMaterial(
      {
        name: "Plastic",
        surface: surface({
          diffuse_color: { type: "color3f", data: [0.8, 0.2, 0.2] },
          roughness: 0.35,
          metallic: 0.9,
        }),
      },
      null,
      loader,
    );

    expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(material.name).toBe("Plastic");
    expect(material.color.r).toBeCloseTo(0.8);
    expect(material.color.g).toBeCloseTo(0.2);
    expect(material.color.b).toBeCloseTo(0.2);
    expect(material.roughness).toBe(0.35);
    expect(material.metalness).toBe(0.9);
    expect(material.transparent).toBe(false);
  });

  it("applies fallback color when the material has no texture", () => {
    const colored = convertMaterial({ name: "Plastic", surface: surface() }, "#ff0000", loader);
    expect(colored.color.r).toBeCloseTo(1.0); // sRGB #ff0000 -> linear red
    expect(colored.color.g).toBe(0);

    const noSurface = convertMaterial({ name: "Unbound", surface: null }, "#00ff00", loader);
    expect(noSurface.color.g).toBeCloseTo(1.0);
  });

  it("keeps three.js defaults for absent channels", () => {
    const material = convertMaterial({ name: "Plain", surface: surface() }, null, loader);
    const defaults = new THREE.MeshPhysicalMaterial();
    expect(material.roughness).toBe(defaults.roughness);
    expect(material.metalness).toBe(defaults.metalness);
    expect(material.opacity).toBe(defaults.opacity);
  });

  it("wires diffuse and normal textures", () => {
    const material = convertMaterial(
      {
        name: "Textured",
        surface: surface({
          textures: [
            textureInput(),
            textureInput({ input: "normal", file_path: "/cache/normal.png" }),
          ],
        }),
      },
      null,
      loader,
    );

    expect(material.map).toBeInstanceOf(THREE.Texture);
    expect(material.normalMap).toBeInstanceOf(THREE.Texture);
    expect(material.color.r).toBeCloseTo(1.0, 5); // untouched white base color
  });

  it("skips textures the loader cannot fetch", () => {
    const material = convertMaterial(
      {
        name: "Textured",
        surface: surface({ textures: [textureInput({ file_path: "/cache/missing.png" })] }),
      },
      null,
      loader,
    );

    expect(material.map).toBeNull();
  });

  it("applies fallback color for a textured material only when the name matches", () => {
    const mismatch = convertMaterial(
      {
        name: "Brick",
        surface: surface({ textures: [textureInput()] }),
      },
      "#ff0000",
      loader,
    );
    expect(mismatch.color.r).toBeCloseTo(1.0, 5); // map set + no name match -> untouched

    const match = convertMaterial(
      {
        name: "CheckerFloor",
        surface: surface({ textures: [textureInput()] }),
      },
      "#ff0000",
      loader,
    );
    expect(match.map).toBeInstanceOf(THREE.Texture);
    expect(match.color.r).toBeCloseTo(1.0); // "checkerFloor".includes("checker")
    expect(match.color.g).toBe(0);
  });

  it("marks opacity below one as transparent", () => {
    const material = convertMaterial(
      { name: "Glass", surface: surface({ opacity: 0.5 }) },
      null,
      loader,
    );
    expect(material.opacity).toBe(0.5);
    expect(material.transparent).toBe(true);

    const opaque = convertMaterial(
      { name: "Glass", surface: surface({ opacity: 1.0 }) },
      null,
      loader,
    );
    expect(opaque.transparent).toBe(false);
  });
});
