<script lang="ts">
  import type { PrimNode } from "$lib/stage/types";
  import { stageState } from "$lib/stage/stageState.svelte";
  import PrimTreeNode from "./PrimTreeNode.svelte";

  let {
    node,
    depth,
    expandedPaths,
    forceOpen = false,
    onHighlight,
  }: {
    node: PrimNode;
    depth: number;
    expandedPaths: Record<string, boolean>;
    forceOpen?: boolean;
    onHighlight?: (node: PrimNode) => void;
  } = $props();

  const hasChildren = $derived(node.children.length > 0);
  const open = $derived(forceOpen || expandedPaths[node.path] === true);
  const selected = $derived(stageState.selectedPath === node.path);

  function select() {
    stageState.selectPrim(node.path);
    onHighlight?.(node);
  }
</script>

<div class="tree-node">
  <div
    class="tree-node-label"
    class:selected
    style="padding-left: {depth * 14}px;"
    role="button"
    tabindex="0"
    onclick={select}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    }}
  >
    {#if hasChildren}
      <button
        class="toggle-btn expand-btn"
        title={open ? "Collapse" : "Expand"}
        onclick={(e) => {
          e.stopPropagation();
          expandedPaths[node.path] = !expandedPaths[node.path];
        }}
      >
        {open ? "▼" : "▶"}
      </button>
    {:else}
      <span style="width: 20px; flex-shrink: 0;"></span>
    {/if}
    <span class="node-type" title={node.path}>[{node.type_name}]</span>
    <span class="node-name" title={node.path}>{node.name}</span>
    {#if node.is_instance}
      <span style="font-size: 9px; padding: 1px 4px; border-radius: 3px; background: #3a3a1f; color: #dcdcaa;"
        >instance</span
      >
    {/if}
    {#if !node.is_active}
      <span style="font-size: 9px; padding: 1px 4px; border-radius: 3px; background: #3a1f1f; color: #f48771;"
        >inactive</span
      >
    {/if}
  </div>
  {#if hasChildren && open}
    <div class="tree-node-children">
      {#each node.children as child (child.path)}
        <PrimTreeNode depth={depth + 1} {expandedPaths} {forceOpen} {onHighlight} node={child} />
      {/each}
    </div>
  {/if}
</div>
