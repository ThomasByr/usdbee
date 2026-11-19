// The in-app updater's state: one status line the About dialog renders and the
// only place a check or an install is started from. Menu clicks and the
// startup auto-check both land in `checkForUpdates`.

import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  "idle" | "checking" | "up-to-date" | "available" | "downloading" | "unsupported" | "error";

export const updateState = $state({
  status: "idle" as UpdateStatus,
  version: "",
  progress: 0,
  message: "",
});

// The support probe hits the Rust side once; the answer cannot change while
// the process runs.
let supported: Promise<boolean> | null = null;
// Concurrent callers (menu click plus the startup check) share one check: a
// second request while the first is in flight joins it.
let inFlight: Promise<void> | null = null;
// The update the last check found; `installUpdate` needs that handle.
let found: Update | null = null;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

export function selfUpdateSupported(): Promise<boolean> {
  supported ??= invoke<boolean>("is_self_update_supported").catch(() => false);
  return supported;
}

export function checkForUpdates(opts: { silent?: boolean } = {}): Promise<void> {
  inFlight ??= runCheck(opts.silent === true).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck(silent: boolean): Promise<void> {
  if (!(await selfUpdateSupported())) {
    updateState.status = "unsupported";
    updateState.message = "";
    return;
  }

  updateState.status = "checking";
  updateState.message = "";
  updateState.progress = 0;

  try {
    const update = await check();
    if (found && found !== update) void found.close().catch(() => {});
    found = update;
    if (!update) {
      updateState.status = "up-to-date";
      updateState.version = "";
      return;
    }
    updateState.version = update.version;
    updateState.status = "available";
  } catch (e) {
    // The startup check is silent: an offline launch must not surface an error
    // the user never asked for.
    if (silent) {
      updateState.status = "idle";
      return;
    }
    updateState.status = "error";
    updateState.message = errorMessage(e);
  }
}

export async function installUpdate(): Promise<void> {
  const update = found;
  if (!update) return;

  updateState.status = "downloading";
  updateState.progress = 0;
  let total = 0;
  let downloaded = 0;

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        downloaded = 0;
        return;
      }
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        updateState.progress = total ? downloaded / total : 0;
        return;
      }
      updateState.progress = 1;
    });
    // Windows runs the installer and exits on its own; macOS and Linux need
    // the relaunch. A relaunch that loses the race is not an error.
    await relaunch().catch(() => {});
  } catch (e) {
    updateState.status = "error";
    updateState.message = errorMessage(e);
  }
}
