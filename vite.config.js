import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // Vitest resolves bare imports with SSR conditions, which lands on
  // svelte's server runtime (mount is unavailable there). Pin the browser
  // condition so component tests can mount real components.
  ...(process.env.VITEST ? { resolve: { conditions: ["browser"] } } : {}),

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        /** @param {string} id */
        manualChunks(id) {
          if (id.includes("node_modules/svelte/")) {
            return "svelte";
          }
          if (id.includes("node_modules/three/")) {
            return "three";
          }
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
}));
