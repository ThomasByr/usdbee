<script lang="ts">
  import {
    compatNoticeVisible,
    compatState,
    dismissCompatNotice,
    setBannerEnabled,
  } from "$lib/state/compatState.svelte";

  let { onOpenSettings }: { onOpenSettings?: () => void } = $props();

  // The persistent half of the dismissal: the bar stays away across restarts.
  function hideForGood() {
    dismissCompatNotice();
    setBannerEnabled(false);
  }

  // The backend reason already starts with "Hardware compositing is off:".
  const reasonText = $derived(compatState.report?.reason || "Hardware compositing is off.");
</script>

<!-- No timer: the camera notice is transient, this one is sticky, and the
     dismissal lives in the session-scoped compatState, and the persisted
     bannerEnabled preference hides it across restarts. -->
{#if compatNoticeVisible(compatState.report, compatState.dismissed, compatState.bannerEnabled)}
  <div class="compat-notice">
    <div class="compat-text" role="status" aria-live="polite">
      <p class="compat-reason">{reasonText}</p>
      <p class="compat-hint">Change this in Settings. Applies after a restart.</p>
    </div>
    <button class="compat-btn" onclick={() => onOpenSettings?.()}>Settings</button>
    <button class="compat-btn" onclick={hideForGood}>Do not show again</button>
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
    /* A fixed frame, not max-width: the flex row would otherwise shrink the
       reason column to its longest word and wrap it over five lines. */
    width: min(760px, calc(100% - 24px));
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text-bright);
    font-size: 13px;
    box-shadow: 0 2px 8px var(--shadow);
  }

  .compat-text {
    flex: 1 1 auto;
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
    white-space: nowrap;
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
