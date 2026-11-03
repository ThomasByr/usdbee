<script lang="ts">
  import { tabsState, tabDisplayName } from "$lib/state/tabsState.svelte";
  import { editState } from "$lib/state/editState.svelte";
  import { layerTextState } from "$lib/state/layerTextState.svelte";
  import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import Icon from "./icons/Icon.svelte";
  import Modal from "./Modal.svelte";

  // The active tab's dot reads the live edit state (a save cleans it
  // immediately, without waiting for a summary refresh); inactive tabs
  // read their list_stages dirty snapshot.
  function dirty(tab: { stage_id: number; dirty_count: number }): boolean {
    if (tab.stage_id !== tabsState.activeId) return tab.dirty_count > 0;
    return editState.dirtyLayers.length > 0 || layerTextState.draftDirty;
  }
</script>

{#if tabsState.stages.length > 0}
  <div class="stage-tab-bar" role="tablist" aria-label="Open stages">
    {#each tabsState.stages as tab (tab.stage_id)}
      <div class="stage-tab" class:active={tab.stage_id === tabsState.activeId}>
        <button
          class="stage-tab-btn"
          role="tab"
          aria-selected={tab.stage_id === tabsState.activeId}
          title={tab.root_file}
          onclick={() => void tabsState.setActive(tab.stage_id)}
        >
          <span class="stage-tab-name">{tabDisplayName(tab)}</span>
          {#if dirty(tab)}
            <span class="dirty-dot" title="Unsaved changes" aria-hidden="true"></span>
          {/if}
        </button>
        <button
          class="stage-tab-close"
          title="Close {tabDisplayName(tab)}"
          aria-label="Close {tabDisplayName(tab)}"
          onclick={() => void tabsState.closeTab(tab.stage_id)}
        >
          <Icon name="x" size={11} />
        </button>
      </div>
    {/each}
    <button
      class="stage-tab-add"
      title="Open a USD file in a new tab"
      aria-label="Open a USD file in a new tab"
      onclick={() => void loadOrchestrator.openUsdFile()}
    >
      +
    </button>
  </div>

  {#if tabsState.pendingCloseId !== null}
    {@const closeId = tabsState.pendingCloseId}
    {@const closeName = tabDisplayName(tabsState.find(closeId!) ?? { root_identifier: "stage" })}
    <Modal
      title="Unsaved changes"
      contentClass="close-confirm-box"
      closeOnBackdrop={false}
      onClose={() => tabsState.cancelClose()}
    >
      <p>
        {tabsState.pendingCloseDirty} unsaved change(s) in {closeName}. Close the tab anyway and lose them?
      </p>
      <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
        <button class="tool-btn" onclick={() => tabsState.cancelClose()}>Cancel</button>
        <button
          class="primary-btn"
          style="background: var(--danger-solid);"
          onclick={() => void tabsState.closeConfirmed(closeId!)}>Close tab</button
        >
      </div>
    </Modal>
  {/if}
{/if}

<style>
  .stage-tab-bar {
    display: flex;
    align-items: stretch;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 0;
  }

  .stage-tab {
    display: flex;
    align-items: stretch;
    border-right: 1px solid var(--border);
    background: var(--bg);
    max-width: 220px;
  }

  .stage-tab.active {
    background: var(--panel);
  }

  .stage-tab-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--text-dim);
    padding: 6px 4px 6px 12px;
    font-size: 12px;
    cursor: pointer;
  }

  .stage-tab-btn:hover {
    color: var(--text);
  }

  .stage-tab.active .stage-tab-btn {
    color: var(--text);
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  .stage-tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stage-tab-close {
    display: flex;
    align-items: center;
    background: transparent;
    border: none;
    color: var(--text-faint);
    padding: 0 6px;
    cursor: pointer;
  }

  .stage-tab-close:hover {
    color: var(--danger);
  }

  .stage-tab-add {
    background: transparent;
    border: none;
    color: var(--text-dim);
    padding: 4px 12px;
    font-size: 15px;
    cursor: pointer;
  }

  .stage-tab-add:hover {
    color: var(--text);
    background: var(--row-hover);
  }
</style>
