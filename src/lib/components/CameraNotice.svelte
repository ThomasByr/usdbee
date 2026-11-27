<script lang="ts">
  import { CAMERA_NOTICE_MS, cameraNotice } from "$lib/state/cameraNotice.svelte";
</script>

{#if cameraNotice.text !== null}
  {#key cameraNotice.seq}
    <div class="camera-notice" role="status" aria-live="polite" style="--notice-ms: {CAMERA_NOTICE_MS}ms">
      {cameraNotice.text}
    </div>
  {/key}
{/if}

<style>
  /* The fade-out is part of the run, not a transition: the state drops the
     text, so the element unmounts instead of animating out. */
  .camera-notice {
    /* Absolute inside the viewport section, so the card centres on the view and
       not on the window: the sidebar would otherwise pull it off centre. */
    position: absolute;
    left: 50%;
    /* Clear of the viewport toolbar: 10px top, 6px padding, a ~28px button
       row and a 6px padding, plus a 12px gap. */
    top: 62px;
    transform: translateX(-50%);
    z-index: 20;
    /* Kept to one line so it cannot wrap into the compat notice below it: the
       compat bar's 104px top assumes this card is one line tall. */
    max-width: min(60ch, 90%);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

  @keyframes camera-notice {
    0% {
      opacity: 0;
      transform: translateX(-50%) translateY(-4px);
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
