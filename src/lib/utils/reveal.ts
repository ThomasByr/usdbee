import { revealItemInDir } from "@tauri-apps/plugin-opener";

// Reveal a file in the OS file manager (Recent Files entries, the active
// stage's root file). The opener plugin throws on permission or platform
// errors; those surface through the shared error modal.
export async function openContainingFolder(path: string, onError: (msg: string) => void): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    onError("Failed to open containing folder:\n\n" + (typeof e === "string" ? e : String(e)));
  }
}
