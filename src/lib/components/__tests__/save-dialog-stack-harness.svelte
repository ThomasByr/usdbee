<script lang="ts">
  import Modal from "../Modal.svelte";
  import SaveDialog from "../SaveDialog.svelte";

  let { onCloseSave, onCloseTop } = $props<{
    onCloseSave: () => void;
    onCloseTop: () => void;
  }>();

  let showTop = $state(true);
</script>

<SaveDialog onClose={onCloseSave} />

{#if showTop}
  <Modal
    title="Top modal"
    onClose={() => {
      showTop = false;
      onCloseTop();
    }}
  >
    <button>Top action</button>
  </Modal>
{/if}
