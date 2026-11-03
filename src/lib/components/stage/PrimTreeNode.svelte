<script lang="ts">
  import type { PrimNode } from "$lib/stage/types";
  import { stageState } from "$lib/stage/stageState.svelte";
  import { isGprim } from "$lib/stage/treeUtils";
  import Icon from "$lib/components/icons/Icon.svelte";
  import AppearancePopover from "./AppearancePopover.svelte";

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
  // Open state drives the toggle glyph only — PrimTree owns the windowed
  // render list, so no recursive child rendering here.
  const open = $derived(forceOpen || expandedPaths[node.path] === true);
  const selected = $derived(stageState.selectedPath === node.path);
  // Appearance targets are non-instanced gprims; the backend edit arms
  // reject instance prims ("edit the prototype").
  const appearanceTarget = $derived(isGprim(node) && !node.is_instance);

  let popoverOpen = $state(false);
  let popoverAnchor = $state<HTMLButtonElement | null>(null);
  let rowInvisible = $state(false);
  let rowError = $state<string | null>(null);
  let visibilityPending = $state(false);
  let visibilityGeneration = 0;

  $effect(() => {
    void node;
    visibilityGeneration += 1;
    rowInvisible = false;
    rowError = null;
    visibilityPending = false;
  });

  // The eye reflects visibility state that is already loaded: the selected
  // prim's details (the inspector's fetch) or the value this row's own
  // toggle just authored. Unloaded rows keep the neutral eye — no per-row
  // fetching.
  const authoredInvisible = $derived.by(() => {
    const details = stageState.details;
    if (details && details.path === node.path) {
      return (details.metadata.find(([field]) => field === "visibility")?.[1].data as string) === "invisible";
    }
    return rowInvisible;
  });

  function select() {
    stageState.selectPrim(node.path);
    onHighlight?.(node);
  }

  // The row button toggles the authored visibility through the same
  // metadata wrapper the popover uses; the current opinion comes from a
  // details fetch (the tree carries no authored state).
  async function toggleVisibility() {
    if (visibilityPending) return;
    const generation = visibilityGeneration;
    visibilityPending = true;
    rowError = null;
    try {
      const details = await stageState.fetchPrimDetails(node.path);
      if (generation !== visibilityGeneration) return;
      if (!details) {
        rowError = `Could not read visibility for ${node.path}`;
        return;
      }
      const invisible =
        (details.metadata.find(([field]) => field === "visibility")?.[1].data as string) === "invisible";
      const next = invisible ? "inherited" : "invisible";
      const error = await stageState.setPrimMetadata("visibility", { type: "token", data: next }, node.path);
      if (generation !== visibilityGeneration) return;
      if (error !== null) {
        rowError = error;
        return;
      }
      rowInvisible = next === "invisible";
    } finally {
      if (generation === visibilityGeneration) visibilityPending = false;
    }
  }

  // The row's Enter/Space selection must not fire from the action buttons.
  function keepRowKeys(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }
</script>

<div class="tree-node">
  <div
    class="tree-node-label"
    class:selected
    style="padding-left: {depth * 14}px;"
    role="treeitem"
    aria-selected={selected}
    aria-level={depth + 1}
    aria-expanded={hasChildren ? open : undefined}
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
      <span
        style="font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--badge-instance-bg); color: var(--syntax-yellow);"
        >instance</span
      >
    {/if}
    {#if !node.is_active}
      <span
        style="font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--badge-off-bg); color: var(--danger-soft);"
        >inactive</span
      >
    {/if}
    {#if appearanceTarget}
      <span class="row-actions">
        <button
          class="row-action-btn"
          title="Appearance (color, texture, visibility)"
          onclick={(e) => {
            e.stopPropagation();
            popoverAnchor = e.currentTarget as HTMLButtonElement;
            popoverOpen = !popoverOpen;
          }}
          onkeydown={keepRowKeys}
        >
          <Icon name="palette" size={13} />
        </button>
        <button
          class="row-action-btn"
          title="Toggle visibility"
          onclick={(e) => {
            e.stopPropagation();
            void toggleVisibility();
          }}
          onkeydown={keepRowKeys}
          disabled={visibilityPending}
          aria-pressed={authoredInvisible}
        >
          <Icon name={authoredInvisible ? "eye-off" : "eye"} size={13} />
        </button>
      </span>
    {/if}
    {#if rowError}
      <span class="row-error" role="alert" title={rowError}>Visibility: {rowError}</span>
    {/if}
  </div>
  {#if popoverOpen && popoverAnchor}
    <AppearancePopover primPath={node.path} anchor={popoverAnchor} onClose={() => (popoverOpen = false)} />
  {/if}
</div>
