// The WebKitGTK/NVIDIA fence-leak decision the backend made at startup, plus
// the preference the user picked. Only the file changes: the running web
// process already read the variable, so a new mode needs a restart.

import { invoke } from "@tauri-apps/api/core";

export type CompatMode = "auto" | "on" | "off";

export interface CompatReport {
  mode: CompatMode;
  applied: boolean;
  forced: boolean;
  reason: string;
  distro_label: string | null;
  nvidia_version: string | null;
  webkit_version: string;
  x11: boolean;
  debian_family: boolean;
}

export const compatState = $state({
  report: null as CompatReport | null,
  dismissed: false,
  pendingRestart: false,
});

// A rejected status must not disturb the UI: everything degrades to "no
// report", which hides the banner and the details row.
export async function loadCompatReport(): Promise<void> {
  try {
    compatState.report = await invoke<CompatReport>("compat_status");
  } catch {
    compatState.report = null;
  }
}

export async function setCompatMode(mode: CompatMode): Promise<string | null> {
  try {
    await invoke("set_compat_pref", { mode });
  } catch (error) {
    return String(error);
  }
  // The hint follows the stored mode, not the report: the process keeps what
  // it started with until the next launch.
  compatState.pendingRestart = mode !== compatState.report?.mode;
  return null;
}

export function dismissCompatNotice(): void {
  compatState.dismissed = true;
}

// Pure so the components and the tests can call it with any report.
export function compatNoticeVisible(report: CompatReport | null, dismissed: boolean): boolean {
  return report !== null && report.applied && report.mode === "auto" && !dismissed;
}
