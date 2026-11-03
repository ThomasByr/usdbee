import type { StageSummary } from "../stage/types";

// Pure close-confirmation logic (Phase 3, Task 5): an OS window close
// request needs a confirm dialog when any layer carries unsaved edits or
// an unapplied text draft exists. Pure so Vitest can pin it; +page.svelte wires it into the
// Tauri close-requested handler.
export function confirmCloseNeeded(dirtyLayerCount: number, hasUnappliedTextDraft = false): boolean {
  return dirtyLayerCount > 0 || hasUnappliedTextDraft;
}

// Task 11: the OS close request aggregates dirt across EVERY open stage
// (the list_stages summaries), plus the active stage's unapplied text
// draft. Pure so Vitest can pin it.
export function windowCloseConfirmNeeded(summaries: StageSummary[], hasUnappliedTextDraft = false): boolean {
  const totalDirty = summaries.reduce((total, summary) => total + Math.max(0, summary.dirty_count), 0);
  return confirmCloseNeeded(totalDirty, hasUnappliedTextDraft);
}
