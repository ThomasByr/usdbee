// Canvas-read discipline: the drawing buffer is not preserved, so every
// toDataURL must be preceded by a render in the same JS task or the capture
// reads a cleared buffer.

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

// `log` is the read/write order across one export; a read without an
// immediately preceding render is the bug this pins.
function makeContext(log: string[]): ExportContext {
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

    expect(log).toEqual(["render", "read", "render", "read"]);
  });
});
