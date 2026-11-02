<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import type { LayerInfo } from "$lib/stage/types";
  import { layerDisplayName, layerTextRevisionAction } from "$lib/stage/layerText";
  import { layerTextState } from "$lib/state/layerTextState.svelte";

  // The Task 6 text layer editor: pick a stage layer, edit its usda text in
  // a plain textarea, save it back into the stage's in-memory layer. The
  // backend parses first and refuses malformed text without touching the
  // stage; a valid import never writes any file (saving stays the only
  // disk-writing flow).

  let layers = $state<LayerInfo[]>([]);
  let selectedId = $state<string | null>(null);
  let text = $state<string>("");
  let loadedText = $state<string>("");
  let stageRevision = $state(0);
  let loadedRevision = $state(0);
  let conflict = $state<string | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  // The inline parse/import error; null when the text is clean.
  let error = $state<string | null>(null);

  async function refreshLayers(): Promise<void> {
    try {
      const listed = await invoke<LayerInfo[]>("list_stage_layers");
      layers = listed;
      // Selection changes load their layer; same-selection revision handling
      // decides whether a clean draft reloads or a dirty one conflicts.
      if (selectedId === null || !listed.some((l) => l.identifier === selectedId)) {
        selectedId = listed[0]?.identifier ?? null;
        await loadText();
      }
    } catch {
      // No stage open (or it went away): nothing to edit.
      layers = [];
      selectedId = null;
      text = "";
      loadedText = "";
      loadedRevision = stageRevision;
      conflict = null;
    }
  }

  async function loadText(): Promise<void> {
    if (selectedId === null) {
      text = "";
      loadedText = "";
      loadedRevision = stageRevision;
      conflict = null;
      return;
    }
    loading = true;
    error = null;
    try {
      const exported = await invoke<string>("export_layer_text", { identifier: selectedId });
      text = exported;
      loadedText = exported;
      loadedRevision = stageRevision;
      conflict = null;
    } catch (e) {
      text = "";
      loadedText = "";
      loadedRevision = stageRevision;
      error = typeof e === "string" ? e : String(e);
    } finally {
      loading = false;
    }
  }

  const conflictMessage =
    "The stage changed after this draft was loaded. Reload the layer text before saving, or copy your edits elsewhere.";

  async function saveToStage(): Promise<void> {
    if (selectedId === null) return;
    if (layerTextRevisionAction(loadedRevision, stageRevision, text !== loadedText) === "conflict") {
      conflict = conflictMessage;
      return;
    }
    saving = true;
    error = null;
    conflict = null;
    try {
      await invoke("import_layer_text", { identifier: selectedId, text });
      loadedText = text;
      loadedRevision = stageRevision;
      // The backend emits usd-stage-changed, so the tree/manifest/edit
      // state refresh through their own listeners.
    } catch (e) {
      error = typeof e === "string" ? e : String(e);
    } finally {
      saving = false;
    }
  }

  async function onStageChanged(): Promise<void> {
    stageRevision += 1;
    const selected = selectedId;
    await refreshLayers();
    if (selected === null || selected !== selectedId) return;
    const action = layerTextRevisionAction(loadedRevision, stageRevision, text !== loadedText);
    if (action === "reload") await loadText();
    if (action === "conflict") conflict = conflictMessage;
  }

  $effect(() => {
    layerTextState.draftDirty = selectedId !== null && text !== loadedText;
  });

  $effect(() => {
    void refreshLayers();
    const unlisten = listen("usd-stage-changed", () => {
      void onStageChanged();
    });
    return () => {
      layerTextState.draftDirty = false;
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

  {#if conflict}
    <div class="error-text" role="alert">
      {conflict}
      <button onclick={() => void loadText()}>Reload latest stage text</button>
    </div>
  {/if}
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
