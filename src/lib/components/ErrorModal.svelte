<script lang="ts">
  let { error, onClose } = $props<{
    error: string;
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
    <h3>Resolution Error Details</h3>
    <div class="error-text">{error}</div>
    <button class="close-btn" onclick={onClose}>Close</button>
  </div>
</div>
