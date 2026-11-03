<script lang="ts">
  // Test-only fixture: two stacked Modal shells that leave the DOM when
  // their own onClose fires, exactly like the page's `{#if}` modals.
  import Modal from "../Modal.svelte";

  let { onCloseA, onCloseB } = $props<{
    onCloseA: () => void;
    onCloseB: () => void;
  }>();

  let showA = $state(true);
  let showB = $state(true);
</script>

{#if showA}
  <Modal
    title="Modal A"
    onClose={() => {
      showA = false;
      onCloseA();
    }}
  >
    <button data-testid="a-button">A</button>
  </Modal>
{/if}

{#if showB}
  <Modal
    title="Modal B"
    onClose={() => {
      showB = false;
      onCloseB();
    }}
  >
    <button data-testid="b-button">B</button>
  </Modal>
{/if}
