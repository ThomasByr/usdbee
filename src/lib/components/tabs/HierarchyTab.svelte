<script lang="ts">
  import * as THREE from "three";
  import PrimTree from "$lib/components/stage/PrimTree.svelte";
  import PropertyInspector from "$lib/components/stage/PropertyInspector.svelte";
  import { stageState } from "$lib/stage/stageState.svelte";
  import { bindSelectionBox } from "$lib/render/sceneIntegration";
  import type { RendererKit } from "$lib/three/RendererKit.svelte";

  let { viewer }: { viewer: RendererKit } = $props();

  let selectedNodeId = $state<string | null>(null);

  // Rust-path objects are named by their exact prim path.
  function highlightPrimObject(path: string) {
    if (!viewer.loadedGroup || !viewer.scene || !path) return;
    let found: THREE.Object3D | null = null;
    viewer.loadedGroup.traverse((o) => {
      if (!found && o.name === path) found = o;
    });
    if (found) updateSelection(found);
  }

  function updateSelection(node: any) {
    if (!viewer.scene) return;

    // Toggle off if already selected
    if (node && selectedNodeId === node.uuid) {
      selectedNodeId = null;
      bindSelectionBox(viewer, null);
      stageState.deselectPrim();
      return;
    }

    selectedNodeId = node ? node.uuid : null;
    bindSelectionBox(viewer, node ?? null);
  }
</script>

<div class="scene-split">
  <div class="scene-tree-wrap">
    <PrimTree onHighlight={(node) => highlightPrimObject(node.path)} />
  </div>
  <PropertyInspector />
</div>

<style>
  .scene-split {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .scene-tree-wrap {
    flex: 1;
    min-height: 60px;
    display: flex;
    flex-direction: column;
  }
</style>
