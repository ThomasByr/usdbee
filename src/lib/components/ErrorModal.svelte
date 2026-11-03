<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";

  let { error, lines, onClose } = $props<{
    error?: string;
    lines?: string[] | null;
    onClose: () => void;
  }>();
</script>

<Modal title={lines && lines.length > 0 ? "Stage Errors" : "Resolution Error Details"} {onClose}>
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
</Modal>
