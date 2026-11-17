// Canvas-read discipline: the drawing buffer is not preserved, so every
// capture must be preceded by a render in the same JS task or the capture
// reads a cleared buffer. Stills read a data URL; video frames are copied into
// a 2D canvas and JPEG-encoded asynchronously.

// @vitest-environment happy-dom
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/out" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));
vi.mock("@ffmpeg/util", () => ({ toBlobURL: async (url: string) => url }));
vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    on() {}
    async load() {}
    async writeFile() {}
    async exec() {}
    async readFile() {
      return new Uint8Array([0]);
    }
    async deleteFile() {}
  },
}));

import { runExport, type ExportContext } from "./VideoExporter";

// happy-dom has no 2D context and no asynchronous JPEG encode: stand in for the
// copy (which is the canvas read) and hand back a tiny blob.
let captureLog: string[] = [];
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({ drawImage: () => captureLog.push("read") }),
});
Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
  configurable: true,
  value: (callback: BlobCallback) => callback(new Blob([new Uint8Array([1, 2, 3])])),
});

// `log` is the read/write order across one export; a read without an
// immediately preceding render is the bug this pins.
function makeContext(log: string[]): ExportContext {
  captureLog = log;
  const renderer = {
    domElement: {
      style: {},
      width: 1,
      height: 1,
      toDataURL: () => {
        log.push("read");
        return "data:image/png;base64,AA==";
      },
    },
    shadowMap: { autoUpdate: false, needsUpdate: false },
    render: () => {
      log.push("render");
    },
    setSize: () => {},
    getSize: (target: THREE.Vector2) => target.set(1, 1),
    getPixelRatio: () => 1,
    setPixelRatio: () => {},
    getClearAlpha: () => 1,
    getClearColor: (target: THREE.Color) => target,
    setClearAlpha: () => {},
    setClearColor: () => {},
  } as unknown as THREE.WebGLRenderer;

  return {
    renderer,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    animationDuration: 0,
    animationProgress: 0,
  };
}

const callbacks = {
  onProgress: () => {},
  onComplete: () => {},
  onError: (msg: string) => {
    throw new Error(msg);
  },
};

function expectEveryReadRendered(log: string[]) {
  expect(log.filter((entry) => entry === "read").length).toBeGreaterThan(0);
  log.forEach((entry, i) => {
    if (entry === "read") expect(log[i - 1]).toBe("render");
  });
}

describe("runExport canvas reads", () => {
  it("renders before the still-image read", async () => {
    const log: string[] = [];
    const context = makeContext(log);
    context.onBeforeFrame = async () => {
      log.push("before");
    };

    await runExport(
      context,
      { format: "png", resolution: { width: 2, height: 2 }, bgTransparent: true, timestamp: 0 },
      callbacks,
    );

    // The trailing entry is the restore's playhead reset, not a capture.
    expect(log.slice(0, 3)).toEqual(["before", "render", "read"]);
    expectEveryReadRendered(log);
  });

  it("renders before every video frame read", async () => {
    const log: string[] = [];

    await runExport(
      makeContext(log),
      {
        format: "mp4",
        resolution: { width: 2, height: 2 },
        mp4Crop: { start: 0, end: 0.05 },
      },
      callbacks,
    );

    expect(log).toEqual(["render", "read", "render", "read", "render"]);
  });

  it("draws one exported pixel per canvas pixel and restores the ratio", async () => {
    const log: string[] = [];
    const context = makeContext(log);
    const ratios: number[] = [];
    const renderer = context.renderer as unknown as {
      getPixelRatio: () => number;
      setPixelRatio: (ratio: number) => void;
    };
    renderer.getPixelRatio = () => 2;
    renderer.setPixelRatio = (ratio: number) => ratios.push(ratio);

    await runExport(
      context,
      { format: "mp4", resolution: { width: 2, height: 2 }, mp4Crop: { start: 0, end: 0.05 } },
      callbacks,
    );

    expect(ratios).toEqual([1, 2]);
  });

  it("restores the starting playhead and draws once after it", async () => {
    const log: string[] = [];
    const context = makeContext(log);
    context.animationProgress = 5;
    const treads: number[] = [];
    context.onBeforeFrame = (t: number) => {
      treads.push(t);
      log.push("before");
    };

    await runExport(
      context,
      { format: "mp4", resolution: { width: 2, height: 2 }, mp4Crop: { start: 0, end: 0.05 } },
      callbacks,
    );

    // Two captured frames, then the restore step and its redraw.
    expect(treads).toEqual([0, 1 / 30, 5]);
    expect(log.slice(-2)).toEqual(["before", "render"]);
    expect(log.filter((e) => e === "render")).toHaveLength(3);
  });

  it("restores the starting playhead on the error path too", async () => {
    const log: string[] = [];
    const context = makeContext(log);
    context.animationProgress = 5;
    const treads: number[] = [];
    context.onBeforeFrame = (t: number) => {
      treads.push(t);
    };
    (context.renderer.domElement as unknown as { toDataURL: () => string }).toDataURL = () => {
      throw new Error("capture failed");
    };
    const errors: string[] = [];

    await runExport(
      context,
      { format: "png", resolution: { width: 2, height: 2 }, timestamp: 1 },
      { ...callbacks, onError: (msg) => errors.push(msg) },
    );

    expect(errors).toHaveLength(1);
    expect(treads).toEqual([1, 5]);
    expect(log.filter((e) => e === "render")).toHaveLength(2);
  });
});
