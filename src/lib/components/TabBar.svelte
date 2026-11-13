<script lang="ts">
  import { tabsState, tabDisplayName } from "$lib/state/tabsState.svelte";
  import { editState } from "$lib/state/editState.svelte";
  import { layerTextState } from "$lib/state/layerTextState.svelte";
  import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import Icon from "./icons/Icon.svelte";
  import Modal from "./Modal.svelte";
  import { displacedShift, dragTargetIndex, type TabRect } from "./tabDrag";

  // Drag state lives on the bar, not the chips: the chips move in the DOM on
  // commit, the bar does not, so pointer capture cannot be lost to a reorder.
  interface DragState {
    id: number;
    from: number;
    startX: number;
    dx: number;
    width: number;
    rects: TabRect[];
    to: number;
    moved: boolean;
  }

  // Below this many pixels the gesture is a click, not a drag.
  const DRAG_THRESHOLD = 4;

  let drag = $state<DragState | null>(null);
  let bar = $state<HTMLDivElement | null>(null);

  function chipStyle(index: number, id: number): string {
    if (!drag || !drag.moved) return "";
    if (id === drag.id) return `transform: translateX(${drag.dx}px);`;
    const shift = displacedShift(index, drag.from, drag.to, drag.width);
    return shift === 0 ? "" : `transform: translateX(${shift}px);`;
  }

  function chipFrom(target: EventTarget | null): HTMLElement | null {
    const el = target instanceof Element ? target.closest<HTMLElement>(".stage-tab") : null;
    return el?.dataset.stageId === undefined ? null : el;
  }

  function onPointerDown(e: PointerEvent): void {
    const chip = chipFrom(e.target);
    if (!chip || !bar) return;
    const id = Number(chip.dataset.stageId);
    // Middle click closes through the guarded path (dirty tabs ask first).
    if (e.button === 1) {
      e.preventDefault();
      void tabsState.closeTab(id);
      return;
    }
    if (e.button !== 0) return;
    // The close x is its own control; a press there must not start a drag.
    if (e.target instanceof Element && e.target.closest(".stage-tab-close")) return;
    // Measured once, pre-transform: live re-measuring would feed the
    // animation back into the maths.
    const rects = Array.from(bar.querySelectorAll<HTMLElement>(".stage-tab")).map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    });
    const from = tabsState.stages.findIndex((tab) => tab.stage_id === id);
    if (from === -1) return;
    drag = {
      id,
      from,
      startX: e.clientX,
      dx: 0,
      width: rects[from]?.width ?? 0,
      rects,
      to: from,
      moved: false,
    };
    bar.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.dx = dx;
    drag.to = dragTargetIndex(drag.rects, e.clientX);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag) return;
    const { id, to, moved } = drag;
    // Clear before the splice so the transforms drop in the same flush as the
    // reorder: the chip lands in its new slot without a jump.
    drag = null;
    releaseCapture(e.pointerId);
    if (moved) tabsState.moveTab(id, to);
  }

  function onPointerCancel(e: PointerEvent): void {
    drag = null;
    releaseCapture(e.pointerId);
  }

  function releaseCapture(pointerId: number): void {
    if (bar?.hasPointerCapture?.(pointerId)) bar.releasePointerCapture(pointerId);
  }

  // The active tab's dot reads the live edit state (a save cleans it
  // immediately, without waiting for a summary refresh); inactive tabs
  // read their list_stages dirty snapshot.
  function dirty(tab: { stage_id: number; dirty_count: number }): boolean {
    if (tab.stage_id !== tabsState.activeId) return tab.dirty_count > 0;
    return editState.dirtyLayers.length > 0 || layerTextState.draftDirty;
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && drag?.moved) drag = null;
  }}
/>

<div
  class="stage-tab-bar"
  class:dragging={drag?.moved}
  role="tablist"
  aria-label="Stage tabs"
  tabindex="-1"
  bind:this={bar}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
>
  {#each tabsState.stages as tab, i (tab.stage_id)}
    <div
      class="stage-tab"
      class:active={tab.stage_id === tabsState.activeId}
      class:drag-source={drag?.id === tab.stage_id}
      data-stage-id={tab.stage_id}
      style={chipStyle(i, tab.stage_id)}
    >
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

  .stage-tab-bar.dragging {
    user-select: none;
    cursor: grabbing;
  }

  .stage-tab-bar.dragging .stage-tab {
    transition: transform 150ms ease;
  }

  .stage-tab-bar.dragging .stage-tab.drag-source {
    transition: none;
    z-index: 1;
    box-shadow: 0 2px 8px rgb(0 0 0 / 35%);
    opacity: 0.9;
  }

  .stage-tab-add:hover {
    color: var(--text);
    background: var(--row-hover);
  }
</style>
