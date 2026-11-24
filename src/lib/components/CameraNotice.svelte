<script lang="ts">
  import { CAMERA_NOTICE_MS, cameraNotice } from "$lib/state/cameraNotice.svelte";

  // The viewport's timeline overlay has its own band, so the card clears it
  // only when the stage actually shows one.
  let { aboveTimeline = false }: { aboveTimeline?: boolean } = $props();
</script>

{#if cameraNotice.text !== null}
  {#key cameraNotice.seq}
    <div
      class="camera-notice"
      class:above-timeline={aboveTimeline}
      role="status"
      aria-live="polite"
      style="--notice-ms: {CAMERA_NOTICE_MS}ms"
    >
      {cameraNotice.text}
    </div>
  {/key}
{/if}

<style>
  /* The fade-out is part of the run, not a transition: the state drops the
     text, so the element unmounts instead of animating out. */
  .camera-notice {
    position: fixed;
    left: 50%;
    /* 24px with nothing under it; the raised band clears the viewport
       timeline, which sits 20px from the bottom and is about 46px tall. */
    bottom: 24px;
    transform: translateX(-50%);
    z-index: 20;
    pointer-events: none;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text-bright);
    font-size: 13px;
    box-shadow: 0 2px 8px var(--shadow);
    animation: camera-notice var(--notice-ms) ease-out both;
  }

  .camera-notice.above-timeline {
    bottom: 80px;
  }

  @keyframes camera-notice {
    0% {
      opacity: 0;
      transform: translateX(-50%) translateY(4px);
    }
    8% {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    85% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
</style>
