<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";

  let { error, notices, lines, onClose } = $props<{
    error?: string;
    notices?: string[] | null;
    lines?: string[] | null;
    onClose: () => void;
  }>();

  const hasNotices = $derived((notices ?? []).length > 0);
  const hasLines = $derived((lines ?? []).length > 0);
</script>

<Modal title={hasNotices || hasLines ? "Stage messages" : "Resolution Error Details"} {onClose}>
  {#if hasNotices}
    <h3 class="message-section">Notices</h3>
    <div class="notice-text">
      {#each notices ?? [] as notice}
        <div>{notice}</div>
      {/each}
    </div>
  {/if}
  {#if hasLines}
    {#if hasNotices}<h3 class="message-section">Errors</h3>{/if}
    <div class="error-text">
      {#each lines ?? [] as line}
        <div>{line}</div>
      {/each}
    </div>
  {:else if !hasNotices}
    <div class="error-text">{error}</div>
  {/if}
  <button class="close-btn" onclick={onClose}>Close</button>
</Modal>

<style>
  .message-section {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
</style>
