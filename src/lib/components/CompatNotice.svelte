<script lang="ts">
  import { compatNoticeVisible, compatState, dismissCompatNotice } from "$lib/state/compatState.svelte";

  let { onOpenSettings }: { onOpenSettings?: () => void } = $props();
</script>

<!-- No timer: the camera notice is transient, this one is sticky, and the
     dismissal lives in the session-scoped compatState. -->
{#if compatNoticeVisible(compatState.report, compatState.dismissed)}
  <div class="compat-notice" role="status">
    <div class="compat-text">
      <p class="compat-reason">Hardware compositing is off: {compatState.report?.reason}</p>
      <p class="compat-hint">Change this in Settings. The new mode applies after a restart.</p>
    </div>
    <button class="compat-btn" onclick={() => onOpenSettings?.()}>Settings</button>
    <button class="compat-btn dismiss" aria-label="Dismiss" title="Dismiss" onclick={dismissCompatNotice}>
      &#215;
    </button>
  </div>
{/if}

<style>
  .compat-notice {
    /* Same absolute context as .camera-notice, but 104px: below the toolbar
       (62px is the camera notice's line) and clear of it, so both fit. */
    position: absolute;
    left: 50%;
    top: 104px;
    transform: translateX(-50%);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(640px, calc(100% - 24px));
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text-bright);
    font-size: 13px;
    box-shadow: 0 2px 8px var(--shadow);
  }

  .compat-text {
    min-width: 0;
  }

  .compat-reason {
    margin: 0;
  }

  .compat-hint {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text);
  }

  .compat-btn {
    flex: none;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-bright);
    font-size: 12px;
    cursor: pointer;
  }

  .compat-btn:hover {
    background: var(--row-hover);
  }

  .dismiss {
    padding: 3px 7px;
    line-height: 1;
  }
</style>
