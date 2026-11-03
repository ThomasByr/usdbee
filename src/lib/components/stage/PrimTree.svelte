<script lang="ts">
  import type { PrimNode } from "$lib/stage/types";
  import { stageState } from "$lib/stage/stageState.svelte";
  import { collectPaths, filterTree } from "$lib/stage/treeUtils";
  import { untrack } from "svelte";
  import {
    OVERSCAN,
    ROW_HEIGHT,
    ancestorPaths,
    ensureRowVisible,
    flattenTree,
    visibleRange,
  } from "$lib/stage/treeWindowing";
  import PrimTreeNode from "./PrimTreeNode.svelte";

  let { onHighlight }: { onHighlight?: (node: PrimNode) => void } = $props();

  let filterText = $state("");
  let expandedPaths = $state<Record<string, boolean>>({});
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let scrollEl = $state<HTMLDivElement | null>(null);

  const filteredTree = $derived(filterTree(stageState.tree, filterText));
  const filtering = $derived(filterText.trim().length > 0);

  // The windowed render list — the scroll container stays mounted across
  // `usd-stage-changed` tree rebuilds, so its scrollTop (and therefore the
  // visible window) survives structural edits unless the selection moves it.
  const rows = $derived(flattenTree(filteredTree, expandedPaths, filtering));
  const range = $derived(visibleRange(rows.length, scrollTop, viewportHeight, ROW_HEIGHT, OVERSCAN));
  const rowIndexByPath = $derived.by(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) map.set(rows[i].node.path, i);
    return map;
  });

  // Selection can arrive from elsewhere (viewport click, inspector). Run
  // ONLY on selectedPath transitions (previous value tracked in a plain
  // variable) so scrolling never re-triggers it; DOM metrics are read
  // inside untrack. Ancestors of a collapsed selection are expanded first
  // so the row exists in the flat list; the scroll itself waits a
  // microtask so the spacer grows before scrollTop is clamped by it.
  let prevSelected: string | null = null;

  $effect(() => {
    const selected = stageState.selectedPath;
    if (selected === prevSelected) return;
    prevSelected = selected;
    if (!selected) return;
    untrack(() => {
      for (const ancestor of ancestorPaths(selected)) expandedPaths[ancestor] = true;
      queueMicrotask(() => scrollSelectionIntoView(selected));
    });
  });

  function scrollSelectionIntoView(selected: string) {
    const el = scrollEl;
    if (!el) return;
    const index = rowIndexByPath.get(selected);
    if (index === undefined) return;
    const target = ensureRowVisible(rows.length, index, el.scrollTop, el.clientHeight, ROW_HEIGHT);
    if (target === null) return;
    el.scrollTop = target;
    scrollTop = target;
  }

  // The scroll container is keyboard-reachable: windowing unmounts
  // off-screen rows, so arrows/page keys here are how keyboard users
  // reach rows outside the mounted window.
  function onScrollKey(event: KeyboardEvent) {
    const el = scrollEl;
    if (!el) return;
    const page = Math.max(el.clientHeight - ROW_HEIGHT, ROW_HEIGHT);
    let target: number;
    switch (event.key) {
      case "ArrowDown":
        target = el.scrollTop + ROW_HEIGHT;
        break;
      case "ArrowUp":
        target = el.scrollTop - ROW_HEIGHT;
        break;
      case "PageDown":
        target = el.scrollTop + page;
        break;
      case "PageUp":
        target = el.scrollTop - page;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = el.scrollHeight;
        break;
      default:
        return;
    }
    event.preventDefault();
    el.scrollTop = target;
  }

  function setAllExpanded(expand: boolean) {
    if (expand) {
      expandedPaths = Object.fromEntries(collectPaths(stageState.tree).map((p) => [p, true]));
    } else {
      expandedPaths = {};
    }
  }

  function onScroll(event: Event) {
    scrollTop = (event.currentTarget as HTMLDivElement).scrollTop;
  }
</script>

<div style="display: flex; flex-direction: column; height: 100%;">
  {#if stageState.status === "ready"}
    <div
      style="display: flex; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border-split); margin-bottom: 8px;"
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
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- Scrollable region with keyboard scrolling: ARIA has no role for this
       pattern, and a full role="tree" would require treeitem rows. -->
  <div
    class="tree-scroll"
    style="flex: 1; overflow-y: auto;"
    role="region"
    aria-label="Prim tree"
    tabindex="0"
    bind:this={scrollEl}
    bind:clientHeight={viewportHeight}
    onscroll={onScroll}
    onkeydown={onScrollKey}
  >
    {#if stageState.status === "ready"}
      <div style="position: relative; height: {rows.length * ROW_HEIGHT}px;">
        {#each rows.slice(range.start, range.end) as row, i (row.node.path)}
          <div class="tree-row" style="top: {(range.start + i) * ROW_HEIGHT}px; height: {ROW_HEIGHT}px;">
            <PrimTreeNode
              node={row.node}
              depth={row.depth}
              {expandedPaths}
              forceOpen={filtering}
              {onHighlight}
            />
          </div>
        {/each}
      </div>
    {:else if stageState.status === "loading"}
      <p style="color: var(--text-faint); text-align: center;">Loading stage...</p>
    {:else if stageState.status === "error"}
      <p style="color: var(--danger-faint); text-align: center;">Failed to load stage tree.</p>
    {:else}
      <p style="color: var(--text-faint); text-align: center;">No USD scene loaded.</p>
    {/if}
  </div>
</div>
