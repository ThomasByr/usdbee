<script lang="ts">
  import type { ValuePayload } from "$lib/stage/types";
  import { formatValue } from "$lib/stage/valueFormat";

  let { value }: { value: ValuePayload } = $props();

  const text = $derived(formatValue(value));
</script>

<span class="value-view" class:multiline={text.includes("\n")} title={value.type}>{text}</span>
