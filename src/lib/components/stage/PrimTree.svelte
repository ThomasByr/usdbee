<script lang="ts">
  import type { PrimNode } from "$lib/stage/types";
  import { stageState } from "$lib/stage/stageState.svelte";
  import { collectPaths, filterTree } from "$lib/stage/treeUtils";
  import PrimTreeNode from "./PrimTreeNode.svelte";

  let { onHighlight }: { onHighlight?: (node: PrimNode) => void } = $props();

  let filterText = $state("");
  let expandedPaths = $state<Record<string, boolean>>({});

  const filteredTree = $derived(filterTree(stageState.tree, filterText));
  const filtering = $derived(filterText.trim().length > 0);

  function setAllExpanded(expand: boolean) {
    if (expand) {
      expandedPaths = Object.fromEntries(collectPaths(stageState.tree).map((p) => [p, true]));
    } else {
      expandedPaths = {};
    }
  }
</script>

<div style="display: flex; flex-direction: column; height: 100%;">
  {#if stageState.status === "ready"}
    <div
      style="display: flex; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid #3e3e42; margin-bottom: 8px;"
    >
      <button class="action-btn" onclick={() => setAllExpanded(true)} style="flex: 1; padding: 4px;">
        Expand All
      </button>
      <button class="action-btn" onclick={() => setAllExpanded(false)} style="flex: 1; padding: 4px;">
        Collapse All
      </button>
    </div>
    <div class="filter-box">
      <input
        type="text"
        class="dependency-filter"
        placeholder="Filter prims by name, path, or type..."
        bind:value={filterText}
      />
    </div>
  {/if}
  <div style="flex: 1; overflow-y: auto;">
    {#if stageState.status === "ready"}
      {#each filteredTree as node (node.path)}
        <PrimTreeNode {node} depth={0} {expandedPaths} forceOpen={filtering} {onHighlight} />
      {/each}
    {:else if stageState.status === "loading"}
      <p style="color: #666; text-align: center;">Loading stage...</p>
    {:else if stageState.status === "error"}
      <p style="color: #a66; text-align: center;">Failed to load stage tree.</p>
    {:else}
      <p style="color: #666; text-align: center;">No USD scene loaded.</p>
    {/if}
  </div>
</div>
