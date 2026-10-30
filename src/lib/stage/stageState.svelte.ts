import { invoke } from "@tauri-apps/api/core";
import type { PrimDetails, PrimNode, StageInfo } from "./types";

export const stageState = $state({
  stageInfo: null as StageInfo | null,
  tree: [] as PrimNode[],
  selectedPath: null as string | null,
  details: null as PrimDetails | null,
  status: "idle" as "idle" | "loading" | "ready" | "error",
  error: null as string | null,

  async loadStage(path: string): Promise<void> {
    this.status = "loading";
    this.error = null;
    try {
      this.stageInfo = await invoke<StageInfo>("open_usd_path", { path });
      this.tree = await invoke<PrimNode[]>("get_stage_tree");
      this.status = "ready";
    } catch (e) {
      this.stageInfo = null;
      this.tree = [];
      this.status = "error";
      this.error = typeof e === "string" ? e : String(e);
    }
  },

  async selectPrim(path: string): Promise<void> {
    this.selectedPath = path;
    if (this.status !== "ready") return;
    try {
      this.details = await invoke<PrimDetails>("get_prim_details", { path });
    } catch (e) {
      this.details = null;
      this.error = typeof e === "string" ? e : String(e);
    }
  },
});
