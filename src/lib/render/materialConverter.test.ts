import { describe, expect, it, vi } from "vitest";
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

  it("clears a failed async diffuse texture and restores fallback color", () => {
    const texture = new THREE.Texture();
    const dispose = vi.spyOn(texture, "dispose");
    let onError: (() => void) | undefined;
    const material = convertMaterial(
      {
        name: "Brick",
        surface: surface({ textures: [textureInput()] }),
      },
      "#ff0000",
      ((_path: string, error: () => void) => {
        onError = error;
        return texture;
      }) as any,
    );
    expect(material.color.g).toBeCloseTo(1.0);

    expect(onError).toBeTypeOf("function");
    onError!();

    expect(material.map).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(material.color.r).toBeCloseTo(1.0);
    expect(material.color.g).toBe(0);
  });

  it("wires diffuse, normal, roughness, metallic, and opacity textures", () => {
    const material = convertMaterial(
      {
        name: "Textured",
        surface: surface({
          textures: [
            textureInput(),
            textureInput({ input: "normal", file_path: "/cache/normal.png" }),
            textureInput({ input: "roughness", file_path: "/cache/roughness.png" }),
            textureInput({ input: "metallic", file_path: "/cache/metallic.png" }),
            textureInput({ input: "opacity", file_path: "/cache/opacity.png" }),
          ],
        }),
      },
      null,
      loader,
    );

    expect(material.map).toBeInstanceOf(THREE.Texture);
    expect(material.normalMap).toBeInstanceOf(THREE.Texture);
    expect(material.roughnessMap).toBeInstanceOf(THREE.Texture);
    expect(material.metalnessMap).toBeInstanceOf(THREE.Texture);
    expect(material.alphaMap).toBeInstanceOf(THREE.Texture);
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

  it("marks a material with an opacity texture as transparent", () => {
    const material = convertMaterial(
      {
        name: "Foliage",
        surface: surface({ textures: [textureInput({ input: "opacity", file_path: "/cache/opacity.png" })] }),
      },
      null,
      loader,
    );
    expect(material.alphaMap).toBeInstanceOf(THREE.Texture);
    expect(material.transparent).toBe(true);
  });

  it("marks opacity below one as transparent", () => {
    const material = convertMaterial({ name: "Glass", surface: surface({ opacity: 0.5 }) }, null, loader);
    expect(material.opacity).toBe(0.5);
    expect(material.transparent).toBe(true);

    const opaque = convertMaterial({ name: "Glass", surface: surface({ opacity: 1.0 }) }, null, loader);
    expect(opaque.transparent).toBe(false);
  });

  it("maps wrap tokens to three.js wrapping modes", () => {
    const convert = (over: Partial<TextureInput> = {}) =>
      convertMaterial(
        { name: "Wrapped", surface: surface({ textures: [textureInput(over)] }) },
        null,
        loader,
      ).map!;

    expect(convert({ wrap_s: "repeat" }).wrapS).toBe(THREE.RepeatWrapping);
    expect(convert({ wrap_s: "clamp" }).wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(convert({ wrap_s: "mirror" }).wrapS).toBe(THREE.MirroredRepeatWrapping);
    // "black" and unauthored fall back to repeat (three.js cannot do black borders)
    expect(convert({ wrap_s: "black" }).wrapS).toBe(THREE.RepeatWrapping);
    expect(convert().wrapS).toBe(THREE.RepeatWrapping);
    expect(convert({ wrap_t: "mirror" }).wrapT).toBe(THREE.MirroredRepeatWrapping);
  });

  it("applies the UsdTransform2d chain to the texture", () => {
    const material = convertMaterial(
      {
        name: "Carbon",
        surface: surface({
          textures: [
            textureInput({
              uv_transform: { scale: [6, 10], translation: [0.25, -0.5], rotation: 90 },
            }),
          ],
        }),
      },
      null,
      loader,
    );

    const map = material.map!;
    expect(map.repeat.x).toBe(6);
    expect(map.repeat.y).toBe(10);
    expect(map.offset.x).toBe(0.25);
    expect(map.offset.y).toBe(-0.5);
    expect(map.center.x).toBe(0);
    expect(map.center.y).toBe(0);
    // USD rotates CCW, three.js clockwise — the sign flips
    expect(map.rotation).toBeCloseTo(-Math.PI / 2);
  });

  it("gives shared-file slots with different transforms distinct textures", () => {
    const material = convertMaterial(
      {
        name: "Shared",
        surface: surface({
          textures: [
            textureInput({ uv_transform: { scale: [15, 15], translation: [0, 0], rotation: 0 } }),
            textureInput({
              input: "normal",
              uv_transform: { scale: [4, 4], translation: [0, 0], rotation: 0 },
            }),
          ],
        }),
      },
      null,
      loader,
    );

    expect(material.map).not.toBe(material.normalMap);
    expect(material.map!.repeat.x).toBe(15);
    expect(material.normalMap!.repeat.x).toBe(4);
  });

  it("treats normal-map value scale/bias as a no-op", () => {
    const material = convertMaterial(
      {
        name: "Tire",
        surface: surface({
          textures: [
            textureInput({
              input: "normal",
              value_scale: [2, 2, 2, 1],
              value_bias: [-1, -1, -1, 0],
            }),
          ],
        }),
      },
      null,
      loader,
    );

    // three.js already performs the 0..1 -> -1..1 decode in-shader
    expect(material.normalScale!.x).toBe(1);
    expect(material.normalScale!.y).toBe(1);
    expect(material.color.r).toBeCloseTo(1.0, 5);
  });

  it("folds a diffuseColor value scale into the base color", () => {
    const material = convertMaterial(
      {
        name: "InnerTire",
        surface: surface({
          textures: [textureInput({ value_scale: [0.44530618, 0.44530618, 0.44530618, 1] })],
        }),
      },
      null,
      loader,
    );

    expect(material.color.r).toBeCloseTo(0.44530618);
    expect(material.color.g).toBeCloseTo(0.44530618);
    expect(material.color.b).toBeCloseTo(0.44530618);
  });
});
