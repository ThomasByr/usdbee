import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { stageState } from "../stage/stageState.svelte";
import type { EditTargetInfo, LayerInfo, LayerSaveRequest, UndoState } from "../stage/types";

// Editing state (Phase 3): the current edit target, the dirty layers and
// the undo/redo availability. Dirty layers and undo state re-query on every
// `usd-stage-changed`; `saveAll` is the only flow that writes USD content to
// disk, and the SaveDialog only calls it from its explicit confirm click —
// nothing here saves by itself.
export const editState = $state({
  editTarget: null as EditTargetInfo | null,
  dirtyLayers: [] as LayerInfo[],
  saveError: null as string | null,
  saving: false,
  // Mirrors get_undo_state; false whenever no stage is open.
  canUndo: false,
  canRedo: false,

  async refresh(): Promise<void> {
    const stageId = stageState.activeStageId;
    try {
      const [editTarget, dirtyLayers, undoState] = await Promise.all([
        invoke<EditTargetInfo>("get_edit_target", { stageId }),
        invoke<LayerInfo[]>("list_dirty_layers", { stageId }),
        invoke<UndoState>("get_undo_state", { stageId }),
      ]);
      // The active tab switched while the refresh was in flight: the answers
      // belong to the previous stage, so they must not land elsewhere.
      if (stageId !== stageState.activeStageId) return;
      this.editTarget = editTarget;
      this.dirtyLayers = dirtyLayers;
      this.canUndo = undoState.can_undo;
      this.canRedo = undoState.can_redo;
    } catch {
      // No stage open (or it went away): nothing to edit. A stale failure
      // after a tab switch must leave the new stage's state alone.
      if (stageId !== stageState.activeStageId) return;
      this.editTarget = null;
      this.dirtyLayers = [];
      this.canUndo = false;
      this.canRedo = false;
    }
  },

  // null selects the session layer; an identifier switches to that layer.
  async setEditTarget(identifier: string | null): Promise<string | null> {
    try {
      await invoke("set_edit_target", { stageId: stageState.activeStageId, identifier });
      await this.refresh();
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  // Save the given layers to their given paths. The backend enforces the
  // extension whitelist and the session-layer rules regardless of the caller.
  async saveAll(requests: LayerSaveRequest[]): Promise<string | null> {
    this.saving = true;
    this.saveError = null;
    try {
      await invoke("save_layers", { stageId: stageState.activeStageId, requests });
      await this.refresh();
      return null;
    } catch (e) {
      this.saveError = typeof e === "string" ? e : String(e);
      return this.saveError;
    } finally {
      this.saving = false;
    }
  },

  // Save As usdz: repack the composed stage (session edits included) into
  // a NEW .usdz archive. Not a layer save — the backend never marks layers
  // clean and emits no usd-stage-changed, so no refresh is needed on
  // success (the dirty layers stay dirty).
  async saveAsUsdz(path: string): Promise<string | null> {
    this.saving = true;
    this.saveError = null;
    try {
      await invoke("save_stage_as_usdz", { stageId: stageState.activeStageId, path });
      return null;
    } catch (e) {
      this.saveError = typeof e === "string" ? e : String(e);
      return this.saveError;
    } finally {
      this.saving = false;
    }
  },

  // Revert the most recent mutation. The backend emits usd-stage-changed for
  // the affected path, so the usual refresh listeners follow; the explicit
  // refresh keeps canUndo/canRedo and the dirty layers current even if the
  // event races.
  async undo(): Promise<string | null> {
    try {
      await invoke("undo_stage_edit", { stageId: stageState.activeStageId });
      await this.refresh();
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  // Re-apply the newest undone mutation.
  async redo(): Promise<string | null> {
    try {
      await invoke("redo_stage_edit", { stageId: stageState.activeStageId });
      await this.refresh();
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  // Subscribe to backend events; returns the unlisten fn for cleanup.
  // Only the active stage's events refresh (Task 11 filters per tab).
  async init(): Promise<() => void> {
    const unlisten = await listen("usd-stage-changed", (event) => {
      const payload = event.payload as { stage_id?: number } | null;
      if (payload?.stage_id !== stageState.activeStageId) return;
      void this.refresh();
    });
    await this.refresh();
    return unlisten;
  },
});
