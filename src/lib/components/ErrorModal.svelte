<script lang="ts">
  let { error, lines, onClose } = $props<{
    error?: string;
    lines?: string[] | null;
    onClose: () => void;
  }>();
</script>

<div
  class="modal-overlay"
  onclick={onClose}
  role="button"
  tabindex="0"
  onkeypress={(e) => e.key === "Escape" && onClose()}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-content" onclick={(e) => e.stopPropagation()}>
    <h3>{lines && lines.length > 0 ? "Stage Errors" : "Resolution Error Details"}</h3>
    {#if lines && lines.length > 0}
      <div class="error-text">
        {#each lines as line}
          <div>{line}</div>
        {/each}
      </div>
    {:else}
      <div class="error-text">{error}</div>
    {/if}
    <button class="close-btn" onclick={onClose}>Close</button>
  </div>
</div>
