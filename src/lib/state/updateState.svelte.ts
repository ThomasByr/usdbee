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
// second request while the first is in flight joins it. Visibility is sticky:
// once any joiner is not silent, the shared check reports its failures.
let inFlight: Promise<void> | null = null;
let silentRun = true;
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
  // A check during a download would close the update being installed.
  if (updateState.status === "downloading") return Promise.resolve();

  if (inFlight) {
    if (opts.silent !== true) silentRun = false;
    return inFlight;
  }

  silentRun = opts.silent === true;
  inFlight = runCheck().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck(): Promise<void> {
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
    // the user never asked for. A user who joined it reports the failure.
    if (silentRun) {
      updateState.status = "idle";
      return;
    }
    updateState.status = "error";
    updateState.message = errorMessage(e);
  }
}

// Startup gate: only a user who ticked the preference gets a silent check, and
// it waits for the first stage load. A missing or broken preference reads as off.
export async function startupAutoCheck(delayMs = 3000): Promise<void> {
  const enabled = await invoke<boolean>("get_update_auto_check").catch(() => false);
  if (!enabled) return;
  setTimeout(() => void checkForUpdates({ silent: true }), delayMs);
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
  } catch (e) {
    updateState.status = "error";
    updateState.progress = 0;
    updateState.message = errorMessage(e);
    return;
  }

  // Windows runs the installer and exits on its own; macOS and Linux need the
  // relaunch. A failed relaunch must not leave the dialog stuck on downloading.
  try {
    await relaunch();
  } catch (e) {
    updateState.status = "error";
    updateState.message = `Downloaded, but usdbee could not restart: ${errorMessage(e)}`;
  }
}
