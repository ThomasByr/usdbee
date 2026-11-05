<script lang="ts">
  import * as THREE from "three";
  import PrimTree from "$lib/components/stage/PrimTree.svelte";
  import PropertyInspector from "$lib/components/stage/PropertyInspector.svelte";
  import { stageState } from "$lib/stage/stageState.svelte";
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
      viewer.selectedNode = null;
      stageState.deselectPrim();
      if (viewer.selectionHelper) {
        viewer.scene.remove(viewer.selectionHelper);
        viewer.selectionHelper.dispose();
        viewer.selectionHelper = null;
      }
      return;
    }

    selectedNodeId = node ? node.uuid : null;
    viewer.selectedNode = node ? node : null;

    // Remove previous selection helper
    if (viewer.selectionHelper) {
      viewer.scene.remove(viewer.selectionHelper);
      viewer.selectionHelper.dispose();
      viewer.selectionHelper = null;
    }

    if (node) {
      const box = new THREE.Box3();
      box.setFromObject(node, true);
      viewer.selectionHelper = new THREE.Box3Helper(box, new THREE.Color(0xffaa00)); // Orange highlight
      viewer.selectionHelper.visible = !box.isEmpty();
      viewer.scene.add(viewer.selectionHelper);
    }
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
