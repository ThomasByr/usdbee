<script lang="ts">
  import type { ValuePayload } from "$lib/stage/types";
  import AttributeEditor from "$lib/components/stage/AttributeEditor.svelte";

  let {
    value,
    oncommit,
  }: { value: ValuePayload; oncommit: (value: ValuePayload) => Promise<string | null> } = $props();
</script>

<AttributeEditor {value} {oncommit} />
