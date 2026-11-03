import { invoke } from "@tauri-apps/api/core";
import type { MaterialInfo, PrimDetails, PrimNode, StageInfo, ValuePayload } from "./types";
import { renderState } from "../render/renderState.svelte";

let loadGeneration = 0;
let selectionGeneration = 0;

export const stageState = $state({
  stageInfo: null as StageInfo | null,
  // The keyed stage map's id of the stage the UI works with (Task 11 adds
  // the tab bar that switches it); 0 = no stage. Every stage-scoped
  // command invoke carries it.
  activeStageId: 0,
  tree: [] as PrimNode[],
  selectedPath: null as string | null,
  details: null as PrimDetails | null,
  status: "idle" as "idle" | "loading" | "ready" | "error",
  error: null as string | null,

  async loadStage(path: string): Promise<void> {
    const generation = ++loadGeneration;
    selectionGeneration += 1;
    this.status = "loading";
    this.error = null;
    this.selectedPath = null;
    this.details = null;
    try {
      const stageInfo = await invoke<StageInfo>("open_usd_path", { path });
      if (generation !== loadGeneration) return;
      this.activeStageId = stageInfo.stage_id;
      this.stageInfo = stageInfo;
      const tree = await invoke<PrimNode[]>("get_stage_tree", {
        stageId: this.activeStageId,
      });
      if (generation !== loadGeneration) return;
      this.tree = tree;
      this.status = "ready";
    } catch (e) {
      if (generation !== loadGeneration) return;
      this.stageInfo = null;
      this.tree = [];
      this.status = "error";
      this.error = typeof e === "string" ? e : String(e);
    }
  },

  async adoptOpenedStage(stageInfo: StageInfo): Promise<void> {
    const generation = ++loadGeneration;
    selectionGeneration += 1;
    this.activeStageId = stageInfo.stage_id;
    this.stageInfo = stageInfo;
    this.tree = [];
    this.selectedPath = null;
    this.details = null;
    this.status = "loading";
    this.error = null;
    try {
      const tree = await invoke<PrimNode[]>("get_stage_tree", {
        stageId: this.activeStageId,
      });
      if (generation !== loadGeneration) return;
      this.tree = tree;
      this.status = "ready";
    } catch (e) {
      if (generation !== loadGeneration) return;
      this.tree = [];
      this.status = "error";
      this.error = typeof e === "string" ? e : String(e);
    }
  },

  async selectPrim(path: string): Promise<void> {
    const generation = ++selectionGeneration;
    this.selectedPath = path;
    this.details = null;
    if (this.status !== "ready") return;
    try {
      const details = await invoke<PrimDetails>("get_prim_details", {
        stageId: this.activeStageId,
        path,
        time: renderState.time,
      });
      if (generation === selectionGeneration) this.details = details;
    } catch (e) {
      if (generation !== selectionGeneration) return;
      this.details = null;
      this.error = typeof e === "string" ? e : String(e);
    }
  },

  async refreshSelectedDetails(): Promise<void> {
    if (this.selectedPath) await this.selectPrim(this.selectedPath);
  },

  // The usd-stage-changed refresh: an edit can reshape the composed tree
  // (metadata, variants), so the tree refetches and the current prim
  // re-selects for fresh details. The viewport manifest rebuild lives in
  // the page (it owns scene integration).
  async refreshAfterEdit(): Promise<void> {
    if (this.status !== "ready") return;
    try {
      const tree = await invoke<PrimNode[]>("get_stage_tree", {
        stageId: this.activeStageId,
      });
      if (this.status !== "ready") return;
      this.tree = tree;
    } catch {
      // The tree refetch is best-effort; details still refresh below.
    }
    if (this.selectedPath) await this.selectPrim(this.selectedPath);
  },

  // Composed details for an arbitrary prim, without moving the selection —
  // the appearance popover reads non-selected rows through this.
  async fetchPrimDetails(path: string): Promise<PrimDetails | null> {
    try {
      return await invoke<PrimDetails>("get_prim_details", {
        stageId: this.activeStageId,
        path,
        time: renderState.time,
      });
    } catch {
      return null;
    }
  },

  // The prim's bound-material report (get_material_data); null when the
  // command fails. Unbound answers the prim's own name with a null surface.
  async getMaterialInfo(path: string): Promise<MaterialInfo | null> {
    try {
      return await invoke<MaterialInfo>("get_material_data", {
        stageId: this.activeStageId,
        path,
      });
    } catch {
      return null;
    }
  },

  // Author an attribute value on the selected prim (session layer); returns
  // the backend error string, or null on success. Time is the viewer's
  // current USD time code so sampled edits land where the user is looking;
  // uniform attributes (xformOpOrder) pass null to author the default.
  // An explicit `path` (appearance popover, branch application) authors
  // that prim instead, without moving the selection.
  async setAttributeValue(
    name: string,
    value: ValuePayload,
    time: number | null = renderState.time,
    path: string | null = null,
  ): Promise<string | null> {
    const target = path ?? this.selectedPath;
    if (!target) return "no prim selected";
    try {
      await invoke("set_attribute_value", {
        stageId: this.activeStageId,
        path: target,
        name,
        value,
        time,
      });
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  // Author a metadata field on the selected prim; an explicit `path`
  // (appearance popover, branch application) authors that prim instead.
  // The usd-stage-changed event drives the tree/details/manifest refresh.
  async setPrimMetadata(
    key: string,
    value: ValuePayload,
    path: string | null = null,
  ): Promise<string | null> {
    const target = path ?? this.selectedPath;
    if (!target) return "no prim selected";
    try {
      await invoke("set_prim_metadata", {
        stageId: this.activeStageId,
        path: target,
        key,
        value,
      });
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  // Author (or clear, with null) one variant-set selection on the selected
  // prim; a switch reshapes the composed tree, so the usd-stage-changed
  // event drives the refresh.
  async setVariantSelection(variantSet: string, selection: string | null): Promise<string | null> {
    if (!this.selectedPath) return "no prim selected";
    try {
      await invoke("set_variant_selection", {
        stageId: this.activeStageId,
        path: this.selectedPath,
        variantSet,
        selection,
      });
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  // Author (or clear, with null) a texture material for `path`: the backend
  // builds a /Looks/<Name>_Mat PreviewSurface network under a Looks scope
  // and binds it to the prim. The explicit path (not the selection) serves
  // branch application, which loops over many gprims.
  async setPrimTexture(path: string, texture: string | null): Promise<string | null> {
    try {
      await invoke("set_prim_texture", {
        stageId: this.activeStageId,
        path,
        texturePath: texture,
      });
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },
});
