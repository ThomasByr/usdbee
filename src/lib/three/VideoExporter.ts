import * as THREE from "three";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export interface ExportContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mixer: THREE.AnimationMixer | null;
  animationDuration: number;
  animationProgress: number;
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
  const { renderer, scene, camera, mixer, animationDuration, animationProgress } = context;
  const { format, quality, resolution, bgTransparent, loop } = config;
  const { onProgress, onComplete, onError } = callbacks;

  // Save current state
  const oldWidth = renderer.domElement.width;
  const oldHeight = renderer.domElement.height;
  const oldAspect = camera.aspect;
  const oldClearAlpha = renderer.getClearAlpha();
  const oldClearColor = renderer.getClearColor(new THREE.Color());
  const oldStyleWidth = renderer.domElement.style.width;
  const oldStyleHeight = renderer.domElement.style.height;
  const oldDisplay = renderer.domElement.style.display;

  // Apply export settings
  renderer.domElement.style.display = "none";
  renderer.setSize(resolution.width, resolution.height, false);
  camera.aspect = resolution.width / resolution.height;
  camera.updateProjectionMatrix();

  if (format === "png" && bgTransparent) {
    renderer.setClearAlpha(0);
  } else {
    renderer.setClearAlpha(1);
  }

  try {
    if (format === "jpg" || format === "png") {
      if (config.timestamp !== undefined && mixer) {
        mixer.setTime(config.timestamp);
      }
      renderer.render(scene, camera);

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
        const totalFrames = Math.ceil((endTime - startTime) * fps);

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

        for (let i = 0; i < totalFrames; i++) {
          const t = startTime + i / fps;
          if (mixer) mixer.setTime(t);
          renderer.render(scene, camera);

          const dataUrl = renderer.domElement.toDataURL("image/jpeg", 0.95);
          const base64Data = dataUrl.split(",")[1];
          const raw = window.atob(base64Data);
          const array = new Uint8Array(new ArrayBuffer(raw.length));
          for (let j = 0; j < raw.length; j++) array[j] = raw.charCodeAt(j);

          const frameName = `frame_${i.toString().padStart(5, "0")}.jpg`;
          await ffmpeg.writeFile(frameName, array);

          const pct = Math.floor((i / totalFrames) * 50);
          onProgress("Rendering Frames...", pct);

          // Yield cleanly to Svelte UI
          await new Promise((r) => setTimeout(r, 0));
        }

        onProgress("Encoding MP4...", 50);

        const ffmpegArgs = [
          "-framerate",
          `${fps}`,
          "-i",
          "frame_%05d.jpg",
          "-c:v",
          "libx264",
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
    const canvasParent = renderer.domElement.parentElement;
    if (canvasParent) {
      renderer.setSize(canvasParent.clientWidth, canvasParent.clientHeight, false);
      camera.aspect = canvasParent.clientWidth / canvasParent.clientHeight;
    } else {
      renderer.setSize(oldWidth, oldHeight, false);
      camera.aspect = oldAspect;
    }
    camera.updateProjectionMatrix();
    renderer.setClearAlpha(oldClearAlpha);
    renderer.setClearColor(oldClearColor, oldClearAlpha);
    renderer.domElement.style.width = oldStyleWidth;
    renderer.domElement.style.height = oldStyleHeight;
    renderer.domElement.style.display = oldDisplay;

    if (mixer) {
      mixer.setTime(animationProgress);
    }
  }
}
