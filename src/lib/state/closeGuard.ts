// Pure close-confirmation logic (Phase 3, Task 5): an OS window close
// request needs a confirm dialog exactly when any layer still carries
// unsaved edits. Pure so Vitest can pin it; +page.svelte wires it into the
// Tauri close-requested handler.
export function confirmCloseNeeded(dirtyLayerCount: number): boolean {
  return dirtyLayerCount > 0;
}
