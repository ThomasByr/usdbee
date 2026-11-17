import * as THREE from "three";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { renderWithShadowUpdate } from "$lib/three/shadowMapUpdate";

// Video frames: the drawing buffer is not preserved, so the copy must land in
// the render's task. A 2D canvas owns the copy, so the JPEG encode can be
// async and no base64 round-trip is needed.
async function captureJpeg(source: HTMLCanvasElement, scratch: HTMLCanvasElement): Promise<Uint8Array> {
  const ctx = scratch.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for frame capture");
  ctx.drawImage(source, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => scratch.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) throw new Error("Frame JPEG encoding failed");
  return new Uint8Array(await blob.arrayBuffer());
}

export interface ExportContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  animationDuration: number;
  animationProgress: number;
  // Task 6: playhead units advanced per real second (rust path: USD
  // time_codes_per_second — the only seconds->time-code conversion besides
  // viewport playback, spec §8).
  playbackRate?: number;
  // Steps the playhead (USD time codes on the rust path) to `t` before
  // each rendered frame; the viewport's setStageTime re-fetches animated
  // geometry. Absent = static export.
  onBeforeFrame?: (t: number) => void | Promise<void>;
}

export interface ExportConfig {
  format: string;
  quality?: number;
  resolution: { width: number; height: number };
  bgTransparent?: boolean;
  loop?: boolean;
  timestamp?: number;
  mp4Crop?: { start: number; end: number };
}

export interface ExportCallbacks {
  onProgress: (stage: string, percent: number) => void;
  onComplete: () => void;
  onError: (msg: string) => void;
}

export async function runExport(
  context: ExportContext,
  config: ExportConfig,
  callbacks: ExportCallbacks,
): Promise<void> {
  const { renderer, scene, camera, animationDuration, animationProgress, playbackRate, onBeforeFrame } =
    context;
  const { format, quality, resolution, bgTransparent, loop } = config;
  const { onProgress, onComplete, onError } = callbacks;

  // Save current state
  const oldSize = renderer.getSize(new THREE.Vector2());
  const oldPixelRatio = renderer.getPixelRatio();
  const oldAspect = camera.aspect;
  const oldClearAlpha = renderer.getClearAlpha();
  const oldClearColor = renderer.getClearColor(new THREE.Color());
  const oldStyleWidth = renderer.domElement.style.width;
  const oldStyleHeight = renderer.domElement.style.height;
  const oldDisplay = renderer.domElement.style.display;
  const oldSceneBackground = scene.background;

  // Apply export settings
  renderer.domElement.style.display = "none";
  // One exported pixel is one canvas pixel: the device ratio would otherwise
  // render (and encode) dpr² times the requested pixel count.
  renderer.setPixelRatio(1);
  renderer.setSize(resolution.width, resolution.height, false);
  camera.aspect = resolution.width / resolution.height;
  camera.updateProjectionMatrix();

  if (format === "png" && bgTransparent) {
    renderer.setClearAlpha(0);
    scene.background = null;
  } else {
    renderer.setClearAlpha(1);
    if (!scene.background) {
      scene.background = new THREE.Color(oldClearColor);
    }
  }

  // The viewport loop is parked while the export modal is open, so the
  // export draws the per-pose shadow map itself.
  const drawFrame = () => renderWithShadowUpdate(renderer, scene, camera);

  try {
    if (format === "jpg" || format === "png") {
      if (config.timestamp !== undefined && onBeforeFrame) {
        await onBeforeFrame(config.timestamp);
      }
      drawFrame();

      const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
      const dataUrl = renderer.domElement.toDataURL(mimeType, format === "jpg" ? quality : undefined);
      const base64Data = dataUrl.split(",")[1];

      const raw = window.atob(base64Data);
      const rawLength = raw.length;
      const array = new Uint8Array(new ArrayBuffer(rawLength));
      for (let i = 0; i < rawLength; i++) {
        array[i] = raw.charCodeAt(i);
      }

      const path = await save({
        filters: [
          {
            name: "Image",
            extensions: [format],
          },
        ],
      });

      if (path) {
        await invoke("save_file_bytes", {
          path,
          bytes: Array.from(array),
        });
      }
      onComplete();
    } else if (format === "mp4") {
      const path = await save({
        filters: [
          {
            name: "Video",
            extensions: ["mp4"],
          },
        ],
      });

      if (path) {
        onProgress("Preparing Video Engine...", 0);

        const startTime = config.mp4Crop ? config.mp4Crop.start : 0;
        const endTime = config.mp4Crop ? config.mp4Crop.end : animationDuration || 2;
        const fps = 30;
        // With a playhead driver the crop range is playhead units and the
        // rate converts frames to real-time seconds.
        const rate = onBeforeFrame && playbackRate ? playbackRate : 1;
        const totalFrames = Math.max(1, Math.ceil(((endTime - startTime) * fps) / rate));

        const ffmpeg = new FFmpeg();
        ffmpeg.on("progress", ({ progress }) => {
          const pct = 50 + Math.floor(progress * 50);
          onProgress("Encoding MP4...", pct);
        });

        const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
        });

        onProgress("Rendering Frames...", 0);

        const scratch = document.createElement("canvas");
        scratch.width = resolution.width;
        scratch.height = resolution.height;

        for (let i = 0; i < totalFrames; i++) {
          const t = startTime + (i * rate) / fps;
          if (onBeforeFrame) await onBeforeFrame(t);
          drawFrame();

          // The awaited blob encode turns the event loop, so the Svelte UI
          // still updates without an extra per-frame timeout.
          const array = await captureJpeg(renderer.domElement, scratch);

          const frameName = `frame_${i.toString().padStart(5, "0")}.jpg`;
          await ffmpeg.writeFile(frameName, array);

          const pct = Math.floor((i / totalFrames) * 50);
          onProgress("Rendering Frames...", pct);
        }

        onProgress("Encoding MP4...", 50);

        const ffmpegArgs = [
          "-framerate",
          `${fps}`,
          "-i",
          "frame_%05d.jpg",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
        ];

        if (loop) {
          ffmpegArgs.push("-movflags", "faststart+frag_keyframe+empty_moov");
          ffmpegArgs.push("-f", "mp4");
          ffmpegArgs.push("-metadata", "loop=1");
        }

        ffmpegArgs.push("output.mp4");

        await ffmpeg.exec(ffmpegArgs);

        const mp4Data = await ffmpeg.readFile("output.mp4");
        const array = new Uint8Array(mp4Data as Uint8Array);

        onProgress("Saving File...", 100);

        await invoke("save_file_bytes", {
          path,
          bytes: Array.from(array),
        });

        try {
          for (let i = 0; i < totalFrames; i++)
            await ffmpeg.deleteFile(`frame_${i.toString().padStart(5, "0")}.jpg`);
          await ffmpeg.deleteFile("output.mp4");
        } catch (e) {}

        onComplete();
      } else {
        onComplete();
      }
    }
  } catch (e: any) {
    onError(e.toString());
  } finally {
    // Restore
    renderer.setPixelRatio(oldPixelRatio);
    const canvasParent = renderer.domElement.parentElement;
    if (canvasParent) {
      renderer.setSize(canvasParent.clientWidth, canvasParent.clientHeight, false);
      camera.aspect = canvasParent.clientWidth / canvasParent.clientHeight;
    } else {
      renderer.setSize(oldSize.x, oldSize.y, false);
      camera.aspect = oldAspect;
    }
    camera.updateProjectionMatrix();
    renderer.setClearAlpha(oldClearAlpha);
    renderer.setClearColor(oldClearColor, oldClearAlpha);
    scene.background = oldSceneBackground;
    renderer.domElement.style.width = oldStyleWidth;
    renderer.domElement.style.height = oldStyleHeight;
    renderer.domElement.style.display = oldDisplay;

    if (onBeforeFrame) {
      await onBeforeFrame(animationProgress);
    }

    // The viewport loop is parked until the modal closes: put the restored
    // pose on the canvas now. A draw failure must not mask the export result.
    try {
      drawFrame();
    } catch {}
  }
}
