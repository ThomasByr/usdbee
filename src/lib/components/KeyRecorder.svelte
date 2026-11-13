<script lang="ts">
  import { formatKeyName } from "$lib/utils/format";

  let {
    binding = $bindable(),
    onchange = () => {},
  }: { binding: string; onchange?: (binding: string) => void } = $props();

  // Modifier presses are bindings of their own (camera down is "shift").
  const MODIFIERS = ["shift", "control", "alt", "meta", "altgraph", "capslock"];

  let recording = $state(false);
  let root = $state<HTMLDivElement | null>(null);

  function toBinding(e: KeyboardEvent): string {
    const key = e.key.toLowerCase();
    if (MODIFIERS.includes(key)) return key;
    return e.ctrlKey || e.metaKey ? `mod+${key}` : key;
  }

  $effect(() => {
    if (!recording) return;

    function onKeydown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording = false;
        return;
      }
      binding = toBinding(e);
      recording = false;
      onchange(binding);
    }

    function onMousedown(e: MouseEvent) {
      if (!root?.contains(e.target as Node)) recording = false;
    }

    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("mousedown", onMousedown, true);
    return () => {
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("mousedown", onMousedown, true);
    };
  });
</script>

<div class="key-recorder" bind:this={root}>
  <button
    class="keybtn"
    class:recording
    title="Click, then press the keys for this action"
    onclick={() => (recording = !recording)}
  >
    {recording ? "Press keys…" : formatKeyName(binding)}
  </button>
  {#if recording}
    <div class="key-recorder-popup">Esc or click away to cancel</div>
  {/if}
</div>

<style>
  .key-recorder {
    position: relative;
  }

  .keybtn.recording {
    border-color: var(--accent);
    color: var(--text-bright);
  }

  .key-recorder-popup {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 10;
    white-space: nowrap;
    font-size: 11px;
    color: var(--text-dim);
    background: var(--bg-sunken);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 4px 6px;
  }
</style>
