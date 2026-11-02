import { invoke } from "@tauri-apps/api/core";
import type { PrimDetails, PrimNode, StageInfo, ValuePayload } from "./types";
import { renderState } from "../render/renderState.svelte";

let loadGeneration = 0;
let selectionGeneration = 0;

export const stageState = $state({
  stageInfo: null as StageInfo | null,
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
      this.stageInfo = stageInfo;
      const tree = await invoke<PrimNode[]>("get_stage_tree");
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
    this.stageInfo = stageInfo;
    this.tree = [];
    this.selectedPath = null;
    this.details = null;
    this.status = "loading";
    this.error = null;
    try {
      const tree = await invoke<PrimNode[]>("get_stage_tree");
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
      const details = await invoke<PrimDetails>("get_prim_details", { path, time: renderState.time });
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

  // Author an attribute value on the selected prim (session layer); returns
  // the backend error string, or null on success. Time is the viewer's
  // current USD time code so sampled edits land where the user is looking.
  async setAttributeValue(name: string, value: ValuePayload): Promise<string | null> {
    if (!this.selectedPath) return "no prim selected";
    try {
      await invoke("set_attribute_value", {
        path: this.selectedPath,
        name,
        value,
        time: renderState.time,
      });
      await this.selectPrim(this.selectedPath);
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  // Author a metadata field on the selected prim; metadata can change the
  // tree (e.g. active), so the tree refetches on success.
  async setPrimMetadata(key: string, value: ValuePayload): Promise<string | null> {
    if (!this.selectedPath) return "no prim selected";
    try {
      await invoke("set_prim_metadata", { path: this.selectedPath, key, value });
      const tree = await invoke<PrimNode[]>("get_stage_tree");
      this.tree = tree;
      await this.selectPrim(this.selectedPath);
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },
});
