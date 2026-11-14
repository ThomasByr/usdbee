import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  clearUdimAtlases,
  convertMaterial,
  udimTileIndex,
  type MaterialTextureLoader,
} from "./materialConverter";
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

// A texture attaches on a promise chain; one macrotask flushes every chain
// this file starts (stub loaders settle immediately).
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Stand-in for Task 4's convertFileSrc-backed loader: resolves a texture for
// every path by default, rejects for paths containing "missing".
const loader: MaterialTextureLoader = async (path) => {
  if (path.includes("missing")) throw new Error(`cannot load ${path}`);
  return new THREE.Texture();
};

// Texture loader whose textures carry their file path as the name.
const named: MaterialTextureLoader = async (path) => {
  const texture = new THREE.Texture();
  texture.name = path;
  return texture;
};

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

  it("clears a failed async diffuse texture and restores fallback color", async () => {
    const material = convertMaterial(
      {
        name: "Brick",
        surface: surface({ textures: [textureInput()] }),
      },
      "#ff0000",
      async () => {
        throw new Error("decode failed");
      },
    );
    // The fallback paints the map's absence: no slot holds a texture yet.
    expect(material.color.g).toBe(0);

    await flush();

    expect(material.map).toBeNull();
    expect(material.color.r).toBeCloseTo(1.0);
    expect(material.color.g).toBe(0);
  });

  it("renders the authored constants until a texture resolves, then upgrades the same instance", async () => {
    let land!: (texture: THREE.Texture) => void;
    const pending = new Promise<THREE.Texture>((resolve) => {
      land = resolve;
    });
    const material = convertMaterial(
      {
        name: "Wrapped",
        surface: surface({
          diffuse_color: { type: "color3f", data: [0.8, 0.2, 0.2] },
          roughness: 0.35,
          textures: [textureInput()],
        }),
      },
      null,
      () => pending,
    );

    // Pre-resolve: the authored material, no placeholder texture.
    expect(material.map).toBeNull();
    expect(material.color.r).toBeCloseTo(0.8);
    expect(material.roughness).toBe(0.35);

    const texture = new THREE.Texture();
    land(texture);
    await flush();

    // Post-resolve: the SAME material the mesh already holds, map-wins rules on.
    expect(material.map).toBe(texture);
    expect(material.color.r).toBeCloseTo(1.0, 5);
  });

  it("keeps the good slot's texture when a second slot on the same image fails", async () => {
    // Two slots share one file; the first slot's load rejects. Clones are per
    // slot, so the failure must not cost the good slot its texture.
    let calls = 0;
    let good!: THREE.Texture;
    const material = convertMaterial(
      {
        name: "Shared",
        surface: surface({
          roughness: 0.35,
          textures: [
            textureInput({ input: "roughness", file_path: "/cache/shared.png" }),
            textureInput({ input: "diffuseColor", file_path: "/cache/shared.png" }),
          ],
        }),
      },
      null,
      async (path) => {
        calls += 1;
        if (calls === 1) throw new Error("decode failed");
        good = new THREE.Texture();
        good.name = path;
        return good;
      },
    );
    await flush();

    // The failing slot keeps its authored constant.
    expect(material.roughnessMap).toBeNull();
    expect(material.roughness).toBe(0.35);
    // The good slot keeps its own texture (clone independence is pinned in
    // textureCache.test.ts: one decode, distinct clones, shared source).
    expect(material.map).toBe(good);
    expect(material.color.r).toBeCloseTo(1.0, 5);
  });

  it("wires diffuse, normal, roughness, metallic, and opacity textures", async () => {
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
    await flush();

    expect(material.map).toBeInstanceOf(THREE.Texture);
    expect(material.normalMap).toBeInstanceOf(THREE.Texture);
    expect(material.roughnessMap).toBeInstanceOf(THREE.Texture);
    expect(material.metalnessMap).toBeInstanceOf(THREE.Texture);
    expect(material.alphaMap).toBeInstanceOf(THREE.Texture);
    expect(material.color.r).toBeCloseTo(1.0, 5); // untouched white base color
  });

  it("skips textures the loader cannot fetch", async () => {
    const material = convertMaterial(
      {
        name: "Textured",
        surface: surface({ textures: [textureInput({ file_path: "/cache/missing.png" })] }),
      },
      null,
      loader,
    );
    await flush();

    expect(material.map).toBeNull();
  });

  it("applies fallback color for a textured material only when the name matches", async () => {
    const mismatch = convertMaterial(
      {
        name: "Brick",
        surface: surface({ textures: [textureInput()] }),
      },
      "#ff0000",
      loader,
    );

    const match = convertMaterial(
      {
        name: "CheckerFloor",
        surface: surface({ textures: [textureInput()] }),
      },
      "#ff0000",
      loader,
    );
    await flush();

    expect(mismatch.map).toBeInstanceOf(THREE.Texture);
    expect(mismatch.color.r).toBeCloseTo(1.0, 5); // map set + no name match -> untouched
    expect(match.map).toBeInstanceOf(THREE.Texture);
    expect(match.color.r).toBeCloseTo(1.0); // "checkerFloor".includes("checker")
    expect(match.color.g).toBe(0);
  });

  it("marks a material with an opacity texture as transparent", async () => {
    const material = convertMaterial(
      {
        name: "Foliage",
        surface: surface({ textures: [textureInput({ input: "opacity", file_path: "/cache/opacity.png" })] }),
      },
      null,
      loader,
    );
    await flush();

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

  it("maps wrap tokens to three.js wrapping modes", async () => {
    const convert = async (over: Partial<TextureInput> = {}) => {
      const material = convertMaterial(
        { name: "Wrapped", surface: surface({ textures: [textureInput(over)] }) },
        null,
        loader,
      );
      await flush();
      return material.map!;
    };

    expect((await convert({ wrap_s: "repeat" })).wrapS).toBe(THREE.RepeatWrapping);
    expect((await convert({ wrap_s: "clamp" })).wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect((await convert({ wrap_s: "mirror" })).wrapS).toBe(THREE.MirroredRepeatWrapping);
    // "black" and unauthored fall back to repeat (three.js cannot do black borders)
    expect((await convert({ wrap_s: "black" })).wrapS).toBe(THREE.RepeatWrapping);
    expect((await convert()).wrapS).toBe(THREE.RepeatWrapping);
    expect((await convert({ wrap_t: "mirror" })).wrapT).toBe(THREE.MirroredRepeatWrapping);
  });

  it("applies the UsdTransform2d chain to the texture", async () => {
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
    await flush();

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

  it("gives shared-file slots with different transforms distinct textures", async () => {
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
    await flush();

    expect(material.map).not.toBe(material.normalMap);
    expect(material.map!.repeat.x).toBe(15);
    expect(material.normalMap!.repeat.x).toBe(4);
  });

  it("treats normal-map value scale/bias as a no-op", async () => {
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
    await flush();

    // three.js already performs the 0..1 -> -1..1 decode in-shader
    expect(material.normalScale!.x).toBe(1);
    expect(material.normalScale!.y).toBe(1);
    expect(material.color.r).toBeCloseTo(1.0, 5);
  });

  it("folds a diffuseColor value scale into the base color", async () => {
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
    await flush();

    expect(material.color.r).toBeCloseTo(0.44530618);
    expect(material.color.g).toBeCloseTo(0.44530618);
    expect(material.color.b).toBeCloseTo(0.44530618);
  });

  it("applies the authored colorSpace regardless of slot", async () => {
    const convert = async (over: Partial<TextureInput> = {}) => {
      const material = convertMaterial(
        { name: "Bike", surface: surface({ textures: [textureInput(over)] }) },
        null,
        loader,
      );
      await flush();
      return material.map!;
    };

    // the CarbonFrameBike marks diffuse maps raw — three.js must not decode them as sRGB
    expect((await convert({ color_space: "raw" })).colorSpace).toBe(THREE.NoColorSpace);
    // an authored sRGB on a data slot also wins over the data-slot default
    const normal = convertMaterial(
      {
        name: "Bike",
        surface: surface({ textures: [textureInput({ input: "normal", color_space: "sRGB" })] }),
      },
      null,
      loader,
    );
    await flush();
    expect(normal.normalMap!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("wires emissive, specular, clearcoat, ior and alphaTest constants", () => {
    const material = convertMaterial(
      {
        name: "Wide",
        surface: surface({
          emissive_color: { type: "color3f", data: [1, 0.5, 0.1] },
          specular_color: { type: "color3f", data: [0.2, 0.3, 0.4] },
          clearcoat: 0.5,
          clearcoat_roughness: 0.25,
          ior: 1.7,
          opacity_threshold: 0.4,
        }),
      },
      null,
      loader,
    );

    expect(material.emissive.r).toBeCloseTo(1);
    expect(material.emissive.g).toBeCloseTo(0.5);
    expect(material.emissive.b).toBeCloseTo(0.1);
    expect(material.specularColor.r).toBeCloseTo(0.2);
    expect(material.specularColor.g).toBeCloseTo(0.3);
    expect(material.specularColor.b).toBeCloseTo(0.4);
    expect(material.clearcoat).toBe(0.5);
    expect(material.clearcoatRoughness).toBe(0.25);
    expect(material.ior).toBe(1.7);
    expect(material.alphaTest).toBe(0.4);
    expect(material.transparent).toBe(true);
  });

  it("wires the widened texture slots named by input", async () => {
    const material = convertMaterial(
      {
        name: "Textured",
        surface: surface({
          textures: [
            textureInput({ input: "emissiveColor", file_path: "/cache/emissive.png" }),
            textureInput({ input: "specularColor", file_path: "/cache/specular.png" }),
            textureInput({ input: "clearcoat", file_path: "/cache/clearcoat.png" }),
            textureInput({ input: "clearcoatRoughness", file_path: "/cache/clearcoat-rough.png" }),
            textureInput({ input: "occlusion", file_path: "/cache/occlusion.png" }),
          ],
        }),
      },
      null,
      named,
    );
    await flush();

    expect(material.emissiveMap!.name).toBe("/cache/emissive.png");
    expect(material.specularColorMap!.name).toBe("/cache/specular.png");
    expect(material.clearcoatMap!.name).toBe("/cache/clearcoat.png");
    expect(material.clearcoatRoughnessMap!.name).toBe("/cache/clearcoat-rough.png");
    expect(material.aoMap!.name).toBe("/cache/occlusion.png");
    // color slots decode as sRGB, data slots stay linear
    expect(material.emissiveMap!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.specularColorMap!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.aoMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.clearcoatMap!.colorSpace).toBe(THREE.NoColorSpace);
  });

  it("reads the occlusion map from the base uv set", async () => {
    const material = convertMaterial(
      {
        name: "Occluded",
        surface: surface({ textures: [textureInput({ input: "occlusion", file_path: "/cache/ao.png" })] }),
      },
      null,
      loader,
    );
    await flush();

    expect(material.aoMap!.channel).toBe(0);
  });

  it("skips a slot constant when its texture occupies the slot", async () => {
    const material = convertMaterial(
      {
        name: "Both",
        surface: surface({
          roughness: 0.2,
          metallic: 0.9,
          clearcoat: 0.7,
          emissive_color: { type: "color3f", data: [1, 0.5, 0.1] },
          textures: [
            textureInput({ input: "roughness", file_path: "/cache/roughness.png" }),
            textureInput({ input: "metallic", file_path: "/cache/metallic.png" }),
            textureInput({ input: "clearcoat", file_path: "/cache/clearcoat.png" }),
            textureInput({ input: "emissiveColor", file_path: "/cache/emissive.png" }),
          ],
        }),
      },
      null,
      loader,
    );
    await flush();

    // three multiplies map by constant, so the constant must stay at its default
    const defaults = new THREE.MeshPhysicalMaterial();
    expect(material.roughness).toBe(defaults.roughness);
    expect(material.metalness).toBe(defaults.metalness);
    expect(material.clearcoat).toBe(defaults.clearcoat);
    // a black emissive would swallow the map; three multiplies, so paint it white
    expect(material.emissive.getHex()).toBe(0xffffff);
  });

  it("restores authored constants when a widened slot texture fails to load", async () => {
    // Loader rejects; each slot must keep the authored constant it showed
    // before the load started.
    const failedLoad = (input: string, over: Partial<PreviewSurface> = {}) =>
      convertMaterial(
        {
          name: "Broken",
          surface: surface({
            ...over,
            textures: [textureInput({ input, file_path: `/cache/${input}.png` })],
          }),
        },
        null,
        async () => {
          throw new Error("decode failed");
        },
      );
    const defaults = new THREE.MeshPhysicalMaterial();

    const emissive = failedLoad("emissiveColor", {
      emissive_color: { type: "color3f", data: [1, 0.5, 0.1] },
    });
    const emissiveBare = failedLoad("emissiveColor");
    const specular = failedLoad("specularColor", {
      specular_color: { type: "color3f", data: [0.2, 0.3, 0.4] },
    });
    const specularBare = failedLoad("specularColor");
    const roughness = failedLoad("roughness", { roughness: 0.2 });
    const roughnessBare = failedLoad("roughness");
    const metallic = failedLoad("metallic", { metallic: 0.9 });
    const metallicBare = failedLoad("metallic");
    const clearcoat = failedLoad("clearcoat", { clearcoat: 0.7 });
    const clearcoatBare = failedLoad("clearcoat");
    const clearcoatRoughness = failedLoad("clearcoatRoughness", { clearcoat_roughness: 0.25 });
    const clearcoatRoughnessBare = failedLoad("clearcoatRoughness");
    await flush();

    expect(emissive.emissiveMap).toBeNull();
    expect(emissive.emissive.toArray()).toEqual([1, 0.5, 0.1]);
    // no authored emissive: back to three's black, not the white map paint
    expect(emissiveBare.emissive.getHex()).toBe(defaults.emissive.getHex());

    expect(specular.specularColor.toArray()).toEqual([0.2, 0.3, 0.4]);
    expect(specularBare.specularColor.getHex()).toBe(defaults.specularColor.getHex());

    expect(roughness.roughnessMap).toBeNull();
    expect(roughness.roughness).toBe(0.2);
    expect(roughnessBare.roughness).toBe(defaults.roughness);

    expect(metallic.metalness).toBe(0.9);
    expect(metallicBare.metalness).toBe(defaults.metalness);

    expect(clearcoat.clearcoat).toBe(0.7);
    expect(clearcoatBare.clearcoat).toBe(defaults.clearcoat);

    expect(clearcoatRoughness.clearcoatRoughness).toBe(0.25);
    expect(clearcoatRoughnessBare.clearcoatRoughness).toBe(defaults.clearcoatRoughness);
  });

  it("renders a volume-only material as translucent gray", () => {
    const material = convertMaterial({ name: "Fog", surface: null, has_volume: true }, null, loader);

    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.35);
    expect(material.color.getHex()).toBe(0x888888);

    const plain = convertMaterial({ name: "Unbound", surface: null }, null, loader);
    expect(plain.transparent).toBe(false);
    expect(plain.opacity).toBe(1);
    expect(plain.color.getHex()).toBe(0xffffff);
  });

  it("wires displacement scale and map", async () => {
    const scaled = convertMaterial(
      { name: "Bumpy", surface: null, displacement: { scale: 0.05, file_path: null, st_primvar: "st" } },
      null,
      loader,
    );
    expect(scaled.displacementScale).toBe(0.05);
    expect(scaled.displacementMap).toBeNull();

    const mapped = convertMaterial(
      {
        name: "Bumpy",
        surface: null,
        displacement: { scale: null, file_path: "/cache/disp.png", st_primvar: "st" },
      },
      null,
      named,
    );
    await flush();

    expect(mapped.displacementMap!.name).toBe("/cache/disp.png");
    expect(mapped.displacementScale).toBe(1);
  });

  it("samples an unauthored exr color slot as linear data", async () => {
    // EXR stores scene-linear floats in every channel: sRGB decoding would
    // wash the map out, so the color-slot default must not apply.
    const material = convertMaterial(
      {
        name: "Env",
        surface: surface({ textures: [textureInput({ file_path: "/cache/env/studio.exr" })] }),
      },
      null,
      loader,
    );
    await flush();

    expect(material.map!.colorSpace).toBe(THREE.NoColorSpace);
  });

  it("lets an authored colorSpace win over the exr linear rule", async () => {
    const material = convertMaterial(
      {
        name: "Env",
        surface: surface({
          textures: [textureInput({ file_path: "/cache/env/studio.exr", color_space: "sRGB" })],
        }),
      },
      null,
      loader,
    );
    await flush();

    expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("keeps the sRGB default for an unauthored non-exr color slot", async () => {
    const material = convertMaterial(
      {
        name: "Env",
        surface: surface({ textures: [textureInput({ file_path: "/cache/env/studio.png" })] }),
      },
      null,
      loader,
    );
    await flush();

    expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("keeps data slots linear for an unauthored exr", async () => {
    const convert = async (over: Partial<TextureInput> = {}) => {
      const material = convertMaterial(
        {
          name: "Env",
          surface: surface({ textures: [textureInput({ file_path: "/cache/env/studio.exr", ...over })] }),
        },
        null,
        loader,
      );
      await flush();
      return material;
    };

    expect((await convert({ input: "normal" })).normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect((await convert({ input: "roughness" })).roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
  });

  it("picks the per-slot colorSpace default for unauthored sourceColorSpace", async () => {
    const convert = async (over: Partial<TextureInput> = {}) => {
      const material = convertMaterial(
        { name: "Auto", surface: surface({ textures: [textureInput(over)] }) },
        null,
        loader,
      );
      await flush();
      return material;
    };

    expect((await convert({})).map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect((await convert({ input: "normal" })).normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect((await convert({ input: "roughness" })).roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
  });

  it("keeps the exr linear rule over a loader-stamped color space", async () => {
    // EXRLoader stamps LinearSRGBColorSpace on every decode, but an EXR holds
    // scene-linear floats in a half-float container: Round 1's .exr rule must
    // still win, as it did before the ktx2 rule existed.
    const stamped: MaterialTextureLoader = async () => {
      const texture = new THREE.Texture();
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      return texture;
    };
    const convert = async (path: string) => {
      const material = convertMaterial(
        {
          name: "Env",
          surface: surface({ textures: [textureInput({ file_path: path })] }),
        },
        null,
        stamped,
      );
      await flush();
      return material;
    };

    expect((await convert("/cache/env/studio.exr")).map!.colorSpace).toBe(THREE.NoColorSpace);
    // Only a ktx2 path may take the loader's stamp over the slot default.
    expect((await convert("/cache/env/studio.png")).map!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("lets a loader-stamped ktx2 color space beat the per-slot default", async () => {
    // A KTX2 header names its own primaries and transfer function; the slot
    // only guesses what the file holds, so the loader's stamp wins.
    const stamped: MaterialTextureLoader = async () => {
      const texture = new THREE.Texture();
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const convert = async (over: Partial<TextureInput> = {}) => {
      const material = convertMaterial(
        {
          name: "Stamped",
          surface: surface({
            textures: [textureInput({ input: "normal", file_path: "/cache/tex/normal.ktx2", ...over })],
          }),
        },
        null,
        stamped,
      );
      await flush();
      return material;
    };

    expect((await convert({})).normalMap!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect((await convert({ color_space: "raw" })).normalMap!.colorSpace).toBe(THREE.NoColorSpace);
  });
});

// Spec R4's formula as written: tile = 1000 + floor(u*10) + floor(v*10)*10.
// The brief's examples (0.1,0.1) -> 1001 and (1.5,0.2) -> 1015 do not follow
// from it ((0.1,0.1) -> 1011, (1.5,0.2) -> 1035); the formula is pinned here.
describe("udimTileIndex", () => {
  it("pins the spec R4 formula", () => {
    expect(udimTileIndex(0.1, 0.1, [1011])).toBe(1011);
    expect(udimTileIndex(1.5, 0.2, [1035])).toBe(1035);
  });

  it("answers 1001 without a tile set", () => {
    expect(udimTileIndex(0.1, 0.2, [])).toBe(1001);
  });

  it("falls back to 1001 when the cell's tile is missing", () => {
    // cell (5,0) -> 1005, absent, so even the nearer 1002 loses to 1001
    expect(udimTileIndex(0.55, 0.05, [1001, 1002])).toBe(1001);
  });

  it("reads the nearest loaded tile for a uv outside the grid", () => {
    // cell (150,5) is outside the 10x10 grid: 1055 is nearer than 1001
    expect(udimTileIndex(15, 0.55, [1001, 1055])).toBe(1055);
    expect(udimTileIndex(-3, -3, [1001, 1055])).toBe(1001);
  });

  it("clamps to the nearest tile when 1001 is not loaded", () => {
    // cell (5,0) with no 1001: 1003 (distance 2) beats 1002 (distance 3)
    expect(udimTileIndex(0.55, 0.05, [1002, 1003])).toBe(1003);
  });

  it("never answers NaN", () => {
    expect(udimTileIndex(Number.NaN, 0.1, [1002, 1003])).toBe(1002);
    expect(udimTileIndex(Number.NaN, Number.NaN, [])).toBe(1001);
  });
});

// One solid-colour data tile: the array-texture assembly reads typed arrays
// (the canvas readback for image-backed tiles has no headless equivalent).
function pixelTile(red: number, green: number, blue: number, width = 1, height = 1): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = red;
    data[pixel * 4 + 1] = green;
    data[pixel * 4 + 2] = blue;
    data[pixel * 4 + 3] = 255;
  }
  return new THREE.DataTexture(data, width, height);
}

const udimTexture = (tiles: { tile: number; file_path: string }[]): TextureInput =>
  textureInput({ file_path: "/cache/tex.<UDIM>.png", udim_tiles: tiles });

// Loader keyed by tile file name; a name it does not know rejects.
function tileLoader(tiles: Record<string, () => THREE.Texture>, seen: string[] = []): MaterialTextureLoader {
  return async (path) => {
    seen.push(path);
    const make = tiles[path.split("/").pop() ?? ""];
    if (!make) throw new Error(`cannot load ${path}`);
    return make();
  };
}

describe("udim atlas", () => {
  const twoTiles = [
    { tile: 1001, file_path: "/cache/tex.1001.png" },
    { tile: 1002, file_path: "/cache/tex.1002.png" },
  ];

  // The atlases outlive a material (they are shared per tile set), so every test
  // starts from an empty cache and from the real physical shader source.
  beforeEach(() => clearUdimAtlases());

  const patched = (material: THREE.Material, fragmentShader = "#include <map_fragment>") => {
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: "",
      fragmentShader,
    };
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    return shader;
  };

  const atlasOf = (material: THREE.Material): THREE.DataArrayTexture =>
    patched(material).uniforms.usdbeeUdimAtlas?.value as THREE.DataArrayTexture;

  it("stacks one layer per loaded tile and never fetches the pattern", async () => {
    const seen: string[] = [];
    const material = convertMaterial(
      { name: "Udim", surface: surface({ textures: [udimTexture(twoTiles)] }) },
      null,
      tileLoader(
        { "tex.1001.png": () => pixelTile(255, 0, 0), "tex.1002.png": () => pixelTile(0, 255, 0) },
        seen,
      ),
    );
    // Nothing resolves in the same tick: the mesh renders the constants first.
    expect(material.map).toBeNull();
    await flush();

    expect(seen.sort()).toEqual(["/cache/tex.1001.png", "/cache/tex.1002.png"]);
    const atlas = atlasOf(material);
    expect(atlas).toBeInstanceOf(THREE.DataArrayTexture);
    expect(atlas.image.depth).toBe(2);
    expect(atlas.image.width).toBe(1);
    expect(Array.from(atlas.image.data ?? [])).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    // The sampler is the array texture, so the material map is a stand-in that
    // exists only to compile the uv varying in.
    expect(material.map).toBeInstanceOf(THREE.Texture);
    expect(material.map).not.toBe(atlas);
  });

  it("patches the map chunk with the tile lookup and the uv transform", async () => {
    const material = convertMaterial(
      {
        name: "Udim",
        surface: surface({
          textures: [
            textureInput({
              file_path: "/cache/tex.<UDIM>.png",
              udim_tiles: twoTiles,
              uv_transform: { scale: [3, 1], translation: [0, 0], rotation: 0 },
            }),
          ],
        }),
      },
      null,
      tileLoader({ "tex.1001.png": () => pixelTile(255, 0, 0), "tex.1002.png": () => pixelTile(0, 255, 0) }),
    );
    await flush();

    // The SRT rides three's own mapTransform through this stand-in map.
    expect(material.map!.repeat.x).toBe(3);

    const shader = patched(material);

    expect(shader.fragmentShader).not.toContain("#include <map_fragment>");
    expect(shader.fragmentShader).toContain("usdbeeUdimAtlas");
    expect(shader.fragmentShader).toContain("vMapUv");
    expect(shader.uniforms.usdbeeUdimCount.value).toBe(2);
    expect(shader.uniforms.usdbeeUdimHas1001.value).toBe(1);
    expect(shader.uniforms.usdbeeUdimFallback.value).toBe(0);
    expect([...(shader.uniforms.usdbeeUdimCells.value as Float32Array).slice(0, 4)]).toEqual([1, 0, 2, 0]);
    expect([...(shader.uniforms.usdbeeUdimLayers.value as Int32Array).slice(0, 2)]).toEqual([0, 1]);
  });

  it("patches the real physical fragment shader", async () => {
    const material = convertMaterial(
      { name: "Udim", surface: surface({ textures: [udimTexture(twoTiles)] }) },
      null,
      tileLoader({ "tex.1001.png": () => pixelTile(255, 0, 0), "tex.1002.png": () => pixelTile(0, 255, 0) }),
    );
    await flush();

    // The chunk this branch depends on is three's, not a stub: a rename there
    // would leave the atlas unsampled, so it is pinned here.
    expect(THREE.ShaderLib.physical.fragmentShader).toContain("#include <map_fragment>");
    const shader = patched(material, THREE.ShaderLib.physical.fragmentShader);

    expect(shader.fragmentShader).not.toContain("#include <map_fragment>");
    expect(shader.fragmentShader).toContain("#include <common>");
    expect(shader.fragmentShader).toContain("uniform sampler2DArray usdbeeUdimAtlas;");
    expect(shader.fragmentShader).toContain("usdbeeUdimLayer( vMapUv )");
  });

  it("shares one atlas between materials of the same tile set", async () => {
    const seen: string[] = [];
    const load = tileLoader(
      { "tex.1001.png": () => pixelTile(255, 0, 0), "tex.1002.png": () => pixelTile(0, 255, 0) },
      seen,
    );
    const build = () =>
      convertMaterial({ name: "Udim", surface: surface({ textures: [udimTexture(twoTiles)] }) }, null, load);
    const first = build();
    await flush();
    const second = build();
    await flush();

    expect(seen).toHaveLength(2); // one decode per tile, not per material
    expect(atlasOf(second)).toBe(atlasOf(first));
  });

  it("keeps rendering the constants until the atlas resolves", async () => {
    const material = convertMaterial(
      {
        name: "Udim",
        surface: surface({
          diffuse_color: { type: "color3f", data: [0.5, 0.25, 0.125] },
          textures: [udimTexture(twoTiles)],
        }),
      },
      null,
      tileLoader({ "tex.1001.png": () => pixelTile(255, 0, 0), "tex.1002.png": () => pixelTile(0, 255, 0) }),
    );

    expect(material.color.r).toBeCloseTo(0.5);
    await flush();
    // Resolved: the atlas owns the pixels, so the constant drops to white.
    expect(material.color.r).toBeCloseTo(1);
  });

  it("drops a tile that failed to load", async () => {
    const material = convertMaterial(
      { name: "Udim", surface: surface({ textures: [udimTexture(twoTiles)] }) },
      null,
      tileLoader({ "tex.1001.png": () => pixelTile(255, 0, 0) }),
    );
    await flush();

    const atlas = atlasOf(material);
    expect(atlas.image.depth).toBe(1);
    expect(Array.from(atlas.image.data ?? [])).toEqual([255, 0, 0, 255]);
  });

  it("leaves the constant when every tile failed", async () => {
    const material = convertMaterial(
      {
        name: "Udim",
        surface: surface({
          diffuse_color: { type: "color3f", data: [0.5, 0.25, 0.125] },
          textures: [udimTexture(twoTiles)],
        }),
      },
      null,
      tileLoader({}),
    );
    await flush();

    expect(material.map).toBeNull();
    expect(atlasOf(material)).toBeUndefined();
    expect(material.color.r).toBeCloseTo(0.5);
  });

  it("rejects a tile whose size differs from the atlas", async () => {
    const material = convertMaterial(
      {
        name: "Udim",
        surface: surface({
          textures: [
            udimTexture([
              { tile: 1001, file_path: "/cache/tex.1001.png" },
              { tile: 1002, file_path: "/cache/tex.1002.png" },
            ]),
          ],
        }),
      },
      null,
      tileLoader({
        "tex.1001.png": () => pixelTile(255, 0, 0, 2, 2),
        "tex.1002.png": () => pixelTile(0, 255, 0, 1, 1),
      }),
    );
    await flush();

    const atlas = atlasOf(material);
    expect(atlas.image.depth).toBe(1);
    expect(atlas.image.width).toBe(2);
    expect(Array.from(atlas.image.data ?? []).slice(0, 4)).toEqual([255, 0, 0, 255]);
  });

  it("flips rows for a tile the loader marks flipped", async () => {
    const flipped = (): THREE.Texture => {
      const tile = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), 1, 2);
      // TextureLoader textures arrive flipY, i.e. bottom row first
      tile.flipY = true;
      return tile;
    };
    const material = convertMaterial(
      {
        name: "Udim",
        surface: surface({ textures: [udimTexture([{ tile: 1001, file_path: "/cache/tex.1001.png" }])] }),
      },
      null,
      tileLoader({ "tex.1001.png": flipped }),
    );
    await flush();

    expect(Array.from(atlasOf(material).image.data ?? [])).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
  });

  it("reads one tile for a slot the atlas does not cover", async () => {
    const seen: string[] = [];
    const material = convertMaterial(
      {
        name: "Udim",
        surface: surface({
          textures: [
            textureInput({ input: "roughness", file_path: "/cache/tex.<UDIM>.png", udim_tiles: twoTiles }),
          ],
        }),
      },
      null,
      tileLoader(
        { "tex.1001.png": () => pixelTile(255, 0, 0), "tex.1002.png": () => pixelTile(0, 255, 0) },
        seen,
      ),
    );
    await flush();

    expect(seen).toEqual(["/cache/tex.1001.png"]);
    expect(material.roughnessMap).toBeInstanceOf(THREE.Texture);
  });
});
