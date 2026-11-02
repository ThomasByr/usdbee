<script lang="ts">
  import { save } from "@tauri-apps/plugin-dialog";
  import { editState } from "$lib/state/editState.svelte";
  import type { LayerSaveRequest, LayerInfo } from "$lib/stage/types";

  let { onClose } = $props<{ onClose: () => void }>();

  // usdz-opened stages cannot save layers (the backend refuses); the only
  // write path is Save As usdz — repack the composed stage into a NEW
  // archive, leaving the original untouched.
  const isUsdzStage = $derived(editState.editTarget?.is_usdz_stage ?? false);
  let usdzPath = $state("");

  // Per-layer save paths, seeded once per dialog mount: regular layers
  // default to the file they were read from, session layers start empty
  // (they must save to a NEW .usda path, never over an existing one).
  let paths = $state<Record<string, string>>({});
  for (const layer of editState.dirtyLayers) {
    paths[layer.identifier] = layer.is_session ? "" : (layer.original_path ?? layer.identifier);
  }

  const regularLayers = $derived(editState.dirtyLayers.filter((l) => !l.is_session));
  const sessionLayers = $derived(editState.dirtyLayers.filter((l) => l.is_session));

  function isUsda(path: string): boolean {
    return path.toLowerCase().endsWith(".usda");
  }

  // A layer is savable when its path is filled in; session layers
  // additionally need a .usda spelling (the backend re-checks both).
  function savable(layer: LayerInfo): boolean {
    const path = paths[layer.identifier] ?? "";
    if (path.trim() === "") return false;
    return !layer.is_session || isUsda(path);
  }

  function requests(): LayerSaveRequest[] {
    return editState.dirtyLayers
      .filter(savable)
      .map((layer) => ({ identifier: layer.identifier, path: paths[layer.identifier].trim() }));
  }

  // The confirm click is the ONLY thing that writes to disk.
  async function onConfirm() {
    if (isUsdzStage) {
      const path = usdzPath.trim();
      if (!isUsdz(path)) return;
      const error = await editState.saveAsUsdz(path);
      if (error === null) onClose();
      return;
    }
    const toSave = requests();
    if (toSave.length === 0) return;
    const error = await editState.saveAll(toSave);
    if (error === null) onClose();
  }

  function isUsdz(path: string): boolean {
    return path.toLowerCase().endsWith(".usdz");
  }

  // Native save dialog where the platform plugin is available; a failure
  // (unsupported platform, headless test) leaves the text input as-is.
  async function browse(layer: LayerInfo) {
    try {
      const path = await save({
        title: layer.is_session ? "Save session layer as new .usda" : "Save layer",
        defaultPath: paths[layer.identifier] || undefined,
        filters: layer.is_session
          ? [{ name: "USD ASCII Layer", extensions: ["usda"] }]
          : [{ name: "USD Layer", extensions: ["usda", "usdc", "usd"] }],
      });
      if (path) paths[layer.identifier] = path;
    } catch (e) {
      console.warn("native save dialog unavailable:", e);
    }
  }

  async function browseUsdz() {
    try {
      const path = await save({
        title: "Save stage as usdz package",
        defaultPath: usdzPath || undefined,
        filters: [{ name: "USDZ Package", extensions: ["usdz"] }],
      });
      if (path) usdzPath = path;
    } catch (e) {
      console.warn("native save dialog unavailable:", e);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter") void onConfirm();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="modal-overlay" role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-content save-dialog" onclick={(e) => e.stopPropagation()}>
    <h3>{isUsdzStage ? "Save As usdz" : "Save Layers"}</h3>

    {#if isUsdzStage}
      <div class="error-text">
        This stage was opened from a .usdz package — its layers cannot be saved in place.
        Save As usdz repacks the stage (session edits included) into a new .usdz archive;
        the original file is never modified.
      </div>
      <div class="save-row">
        <div class="save-layer-name">usdz destination</div>
        <input
          type="text"
          class="save-path-input"
          bind:value={usdzPath}
          placeholder="new .usdz package path"
        />
        <button class="save-browse-btn" onclick={() => void browseUsdz()}>Browse…</button>
      </div>
      {#if usdzPath.trim() !== "" && !isUsdz(usdzPath.trim())}
        <span class="save-warning">must be .usdz</span>
      {/if}
    {:else if editState.dirtyLayers.length === 0}
      <div class="error-text">No layers with unsaved edits.</div>
    {:else}
      {#if regularLayers.length > 0}
        <div class="save-section">Layers</div>
        {#each regularLayers as layer (layer.identifier)}
          <div class="save-row">
            <div class="save-layer-name" title={layer.identifier}>
              {layer.identifier}
            </div>
            <input
              type="text"
              class="save-path-input"
              bind:value={paths[layer.identifier]}
              placeholder="destination path (.usda / .usdc / .usd)"
            />
            <button class="save-browse-btn" onclick={() => browse(layer)}>Browse…</button>
          </div>
        {/each}
      {/if}

      {#if sessionLayers.length > 0}
        <div class="save-section">Session layers (save as a new .usda file)</div>
        {#each sessionLayers as layer (layer.identifier)}
          <div class="save-row">
            <div class="save-layer-name" title={layer.identifier}>
              {layer.identifier}
            </div>
            <input
              type="text"
              class="save-path-input"
              bind:value={paths[layer.identifier]}
              placeholder="new .usda path — session layers never overwrite a composed file"
            />
            {#if paths[layer.identifier] !== "" && !isUsda(paths[layer.identifier])}
              <span class="save-warning">must be .usda</span>
            {:else}
              <button class="save-browse-btn" onclick={() => browse(layer)}>Browse…</button>
            {/if}
          </div>
        {/each}
      {/if}
    {/if}

    {#if editState.saveError}
      <div class="error-text">{editState.saveError}</div>
    {/if}

    <div class="save-actions">
      <button class="close-btn" onclick={onClose}>Cancel</button>
      <button
        class="primary-btn"
        disabled={editState.saving || (isUsdzStage ? !isUsdz(usdzPath.trim()) : requests().length === 0)}
        onclick={() => void onConfirm()}
      >
        {editState.saving ? "Saving…" : isUsdzStage ? "Save As usdz" : "Save"}
      </button>
    </div>
  </div>
</div>

<style>
  .save-dialog {
    min-width: 480px;
    max-width: 720px;
  }

  .save-section {
    margin: 12px 0 4px;
    font-weight: 600;
    font-size: 13px;
  }

  .save-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
  }

  .save-layer-name {
    flex: 0 0 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .save-path-input {
    flex: 1 1 auto;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--bg-color, #1e1e1e);
    color: inherit;
    border: 1px solid #555;
    border-radius: 4px;
  }

  .save-browse-btn {
    padding: 4px 8px;
    font-size: 12px;
  }

  .save-warning {
    color: #e6a23c;
    font-size: 12px;
    white-space: nowrap;
  }

  .save-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
  }
</style>
