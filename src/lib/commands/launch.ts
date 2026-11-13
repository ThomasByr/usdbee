// Launch args (Task 9): files opened from the command line become tabs, and
// the camera options pin the view through the same command the palette runs.
// Runs once per app start, after the Viewport publishes its viewer.

import { invoke } from "@tauri-apps/api/core";
import { tabsState } from "$lib/state/tabsState.svelte";
import { dispatchCommand } from "./dispatch";
import { bridgeViewer } from "./viewerRef";

interface LaunchOptions {
  files: string[];
  camera_position: [number, number, number] | null;
  camera_target: [number, number, number] | null;
  camera_fov: number | null;
}

let consumed = false;

export async function consumeLaunchOptions(): Promise<void> {
  if (consumed) return;
  consumed = true;

  let options: LaunchOptions;
  try {
    options = await invoke<LaunchOptions>("get_launch_options");
  } catch {
    // No managed options (a dev server or an older backend): nothing to do.
    return;
  }

  for (const path of options.files) {
    await tabsState.openTab(path);
  }

  const viewer = bridgeViewer();
  const args: Record<string, unknown> = {};
  if (options.camera_position) args.position = options.camera_position;
  if (options.camera_target) args.target = options.camera_target;
  if (options.camera_fov != null) args.fov = options.camera_fov;
  if (!viewer || Object.keys(args).length === 0) return;
  await dispatchCommand(viewer, "set_camera", args);
}
