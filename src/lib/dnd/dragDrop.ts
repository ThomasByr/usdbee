import { getCurrentWebview } from "@tauri-apps/api/webview";

// Drag-and-drop opening (Task 12): dropped paths open through
// tabsState.openTab only when EVERY dropped path is a USD file — a mixed
// or non-USD drop refuses entirely and surfaces the shared error modal.

export const USD_DROP_EXTENSIONS = ["usd", "usda", "usdc", "usdz"];

export function isUsdFilePath(path: string): boolean {
  const ext = path.split(".").pop() ?? "";
  return ext.length > 0 && USD_DROP_EXTENSIONS.includes(ext.toLowerCase());
}

// All-or-nothing filter: the drop's USD paths in drop order, or an empty
// list when anything in the drop is not a USD file.
export function droppedUsdPaths(paths: string[]): string[] {
  return paths.length > 0 && paths.every(isUsdFilePath) ? paths : [];
}

export function dropRejectionMessage(paths: string[]): string {
  const refused = paths.filter((p) => !isUsdFilePath(p));
  return `Only USD files (.usd, .usda, .usdc, .usdz) can be opened by dropping them here.\n\nRefused: ${refused.join(", ") || paths.join(", ")}`;
}

// Subscribe to the webview's drag-drop events; returns the unlisten for
// the page's mount/dispose cycle. The open callback runs per path, in
// drop order; non-USD drops open nothing and report to the error surface.
export async function initDragDrop(
  open: (path: string) => Promise<void>,
  onError: (msg: string) => void,
): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    const paths = droppedUsdPaths(event.payload.paths);
    if (paths.length === 0) {
      onError(dropRejectionMessage(event.payload.paths));
      return;
    }
    void (async () => {
      for (const path of paths) {
        await open(path);
      }
    })();
  });
}
