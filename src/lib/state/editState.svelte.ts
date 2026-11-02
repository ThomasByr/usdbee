import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EditTargetInfo, LayerInfo, LayerSaveRequest } from "../stage/types";

// Editing state (Phase 3): the current edit target and the dirty layers.
// Dirty layers re-query on every `usd-stage-changed`; `saveAll` is the only
// flow that writes USD content to disk, and the SaveDialog only calls it
// from its explicit confirm click — nothing here saves by itself.
export const editState = $state({
  editTarget: null as EditTargetInfo | null,
  dirtyLayers: [] as LayerInfo[],
  saveError: null as string | null,
  saving: false,

  async refresh(): Promise<void> {
    try {
      const [editTarget, dirtyLayers] = await Promise.all([
        invoke<EditTargetInfo>("get_edit_target"),
        invoke<LayerInfo[]>("list_dirty_layers"),
      ]);
      this.editTarget = editTarget;
      this.dirtyLayers = dirtyLayers;
    } catch {
      // No stage open (or it went away): nothing to edit.
      this.editTarget = null;
      this.dirtyLayers = [];
    }
  },

  // null selects the session layer; an identifier switches to that layer.
  async setEditTarget(identifier: string | null): Promise<string | null> {
    try {
      await invoke("set_edit_target", { identifier });
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
      await invoke("save_layers", { requests });
      await this.refresh();
      return null;
    } catch (e) {
      this.saveError = typeof e === "string" ? e : String(e);
      return this.saveError;
    } finally {
      this.saving = false;
    }
  },

  // Subscribe to backend events; returns the unlisten fn for cleanup.
  async init(): Promise<() => void> {
    const unlisten = await listen("usd-stage-changed", () => {
      void this.refresh();
    });
    await this.refresh();
    return unlisten;
  },
});
