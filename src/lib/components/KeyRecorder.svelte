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
  // Modifier held since the last non-modifier key: it records as a lone
  // binding only if it is released before a chord key arrives.
  let pending: string | null = null;

  function toBinding(e: KeyboardEvent): string {
    const key = e.key.toLowerCase();
    return e.ctrlKey || e.metaKey ? `mod+${key}` : key;
  }

  // A binding string cannot carry alt next to another key, and matchesBinding
  // rejects alt-held presses, so such a chord is dropped and recording
  // continues rather than recording the plain key (Alt+G would fire on G).
  // Shift-held captures are fine: a single-key binding ignores shiftKey, so
  // Shift+1 on a French layout records "1" — the key that gets pressed.
  function unbindable(e: KeyboardEvent): boolean {
    if (MODIFIERS.includes(e.key.toLowerCase())) return false;
    return e.altKey;
  }

  $effect(() => {
    if (!recording) return;
    pending = null;

    function onKeydown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording = false;
        return;
      }
      // A modifier press alone is a binding of its own, but only once it is
      // released: recording it here would end the capture before a chord key
      // such as P in Ctrl+P arrives.
      const key = e.key.toLowerCase();
      if (MODIFIERS.includes(key)) {
        pending = key;
        return;
      }
      if (unbindable(e)) return;
      binding = toBinding(e);
      recording = false;
      onchange(binding);
    }

    function onKeyup(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== pending) return;
      binding = pending;
      recording = false;
      onchange(binding);
    }

    function onMousedown(e: MouseEvent) {
      if (!root?.contains(e.target as Node)) recording = false;
    }

    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("keyup", onKeyup, true);
    window.addEventListener("mousedown", onMousedown, true);
    return () => {
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("keyup", onKeyup, true);
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
