<script lang="ts">
  import type { PrimNode } from "$lib/stage/types";
  import PrimTreeNode from "../PrimTreeNode.svelte";

  let { node } = $props<{ node: PrimNode }>();

  export function rebuild(): void {
    node = { ...node };
  }
</script>

<PrimTreeNode {node} depth={0} expandedPaths={{}} />
