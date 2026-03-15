<script lang="ts">
  import type { Snippet } from "svelte";
  let { loadedGroup, toggleAllExpanded, updateSelection, treeNode } = $props<{
    loadedGroup: any;
    toggleAllExpanded: (expand: boolean) => void;
    updateSelection: (node: any) => void;
    treeNode: Snippet<[any, number]>;
  }>();
</script>

<div style="display: flex; flex-direction: column; height: 100%;">
  {#if loadedGroup}
    <div
      style="display: flex; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid #3e3e42; margin-bottom: 8px;"
    >
      <button class="action-btn" onclick={() => toggleAllExpanded(true)} style="flex: 1; padding: 4px;">
        Expand All
      </button>
      <button class="action-btn" onclick={() => toggleAllExpanded(false)} style="flex: 1; padding: 4px;">
        Collapse All
      </button>
    </div>
  {/if}
  <div
    style="flex: 1; overflow-y: auto;"
    onclick={() => updateSelection(null)}
    onkeydown={(e) => {
      if (e.key === "Escape") updateSelection(null);
    }}
    role="presentation"
  >
    {#if loadedGroup}
      {@render treeNode(loadedGroup, 0)}
    {:else}
      <p style="color: #666; text-align: center;">No USD scene loaded.</p>
    {/if}
  </div>
</div>
