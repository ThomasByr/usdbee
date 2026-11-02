<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import type { LayerInfo } from "$lib/stage/types";
  import { layerDisplayName } from "$lib/stage/layerText";

  // The Task 6 text layer editor: pick a stage layer, edit its usda text in
  // a plain textarea, save it back into the stage's in-memory layer. The
  // backend parses first and refuses malformed text without touching the
  // stage; a valid import never writes any file (saving stays the only
  // disk-writing flow).

  let layers = $state<LayerInfo[]>([]);
  let selectedId = $state<string | null>(null);
  let text = $state<string>("");
  let loading = $state(false);
  let saving = $state(false);
  // The inline parse/import error; null when the text is clean.
  let error = $state<string | null>(null);

  async function refreshLayers(): Promise<void> {
    try {
      const listed = await invoke<LayerInfo[]>("list_stage_layers");
      layers = listed;
      // The textarea reloads only when the selection must change: a stage
      // change must not wipe in-progress edits.
      if (selectedId === null || !listed.some((l) => l.identifier === selectedId)) {
        selectedId = listed[0]?.identifier ?? null;
        await loadText();
      }
    } catch {
      // No stage open (or it went away): nothing to edit.
      layers = [];
      selectedId = null;
      text = "";
    }
  }

  async function loadText(): Promise<void> {
    if (selectedId === null) {
      text = "";
      return;
    }
    loading = true;
    error = null;
    try {
      text = await invoke<string>("export_layer_text", { identifier: selectedId });
    } catch (e) {
      text = "";
      error = typeof e === "string" ? e : String(e);
    } finally {
      loading = false;
    }
  }

  async function saveToStage(): Promise<void> {
    if (selectedId === null) return;
    saving = true;
    error = null;
    try {
      await invoke("import_layer_text", { identifier: selectedId, text });
      // The backend emits usd-stage-changed, so the tree/manifest/edit
      // state refresh through their own listeners.
    } catch (e) {
      error = typeof e === "string" ? e : String(e);
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    void refreshLayers();
    const unlisten = listen("usd-stage-changed", () => {
      void refreshLayers();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  });
</script>

<div class="layer-editor">
  <div class="editor-header">
    <select
      class="layer-select"
      aria-label="Layer to edit"
      value={selectedId ?? ""}
      disabled={layers.length === 0}
      onchange={(e) => {
        selectedId = e.currentTarget.value || null;
        void loadText();
      }}
    >
      {#if layers.length === 0}
        <option value="">no stage open</option>
      {:else}
        {#each layers as layer (layer.identifier)}
          <option value={layer.identifier}>{layerDisplayName(layer)}</option>
        {/each}
      {/if}
    </select>
    <button
      class="save-btn"
      disabled={saving || loading || selectedId === null}
      onclick={() => void saveToStage()}
    >
      {saving ? "Saving…" : "Save to stage"}
    </button>
  </div>

  <textarea
    class="usda-text"
    spellcheck="false"
    placeholder={selectedId === null ? "Open a USD file to edit its layers" : "usda text"}
    bind:value={text}
    disabled={loading || selectedId === null}
  ></textarea>

  {#if error}
    <div class="error-text" role="alert">{error}</div>
  {/if}
</div>

<style>
  .layer-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 240px;
    gap: 8px;
  }

  .editor-header {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .layer-select {
    flex: 1 1 auto;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--bg-color, #1e1e1e);
    color: inherit;
    border: 1px solid #555;
    border-radius: 4px;
  }

  .save-btn {
    padding: 4px 10px;
    font-size: 12px;
  }

  .usda-text {
    flex: 1 1 auto;
    min-height: 180px;
    resize: vertical;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.4;
    padding: 8px;
    background: var(--bg-color, #1e1e1e);
    color: inherit;
    border: 1px solid #555;
    border-radius: 4px;
    white-space: pre;
    overflow: auto;
  }

  .error-text {
    color: #e05555;
    font-size: 12px;
    white-space: pre-wrap;
    max-height: 120px;
    overflow: auto;
  }
</style>
