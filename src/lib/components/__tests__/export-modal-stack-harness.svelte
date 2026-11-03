<script lang="ts">
  import Modal from "../Modal.svelte";
  import ExportModal from "../ExportModal.svelte";

  let { onCloseLower, onCloseExport } = $props<{
    onCloseLower: () => void;
    onCloseExport: () => void;
  }>();

  let showLower = $state(true);
  let showExport = $state(true);
</script>

{#if showLower}
  <Modal
    title="Lower modal"
    onClose={() => {
      showLower = false;
      onCloseLower();
    }}
  >
    <button>Lower action</button>
  </Modal>
{/if}

{#if showExport}
  <ExportModal
    renderer={null}
    scene={null}
    camera={null}
    hasAnimation={false}
    animationDuration={0}
    animationProgress={0}
    previewAt={null}
    isExporting={false}
    exportProgress={0}
    exportStage="Exporting..."
    onClose={() => {
      showExport = false;
      onCloseExport();
    }}
    onExport={() => {}}
  />
{/if}
