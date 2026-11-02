// Pure close-confirmation logic (Phase 3, Task 5): an OS window close
// request needs a confirm dialog when any layer carries unsaved edits or
// an unapplied text draft exists. Pure so Vitest can pin it; +page.svelte wires it into the
// Tauri close-requested handler.
export function confirmCloseNeeded(dirtyLayerCount: number, hasUnappliedTextDraft = false): boolean {
  return dirtyLayerCount > 0 || hasUnappliedTextDraft;
}
