<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import * as THREE from "three";
  import DependenciesTab from "$lib/components/DependenciesTab.svelte";
  import { filteredDependencies, loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import type { RendererKit } from "$lib/three/RendererKit.svelte";

  let { viewer }: { viewer: RendererKit } = $props();

  async function replaceWithColor(path: string, event: Event) {
    if (!loadOrchestrator.dependencies) return;
    const input = event.target as HTMLInputElement;
    const color = input.value;
    try {
      await invoke("set_fallback_color", { path, color });

      // Update local state to reflect the change
      loadOrchestrator.dependencies[path] = {
        ...loadOrchestrator.dependencies[path],
        resolved: true,
        fallback_color: color,
      };

      if (viewer.loadedGroup) {
        const threeColor = new THREE.Color(color);
        const searchName = path.split(/[\\/]/).pop()?.split(".")[0]?.toLowerCase() || "";

        viewer.loadedGroup.traverse((child: any) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
              if (!mat.map || (mat.name && mat.name.toLowerCase().includes(searchName))) {
                mat.color = threeColor;
                mat.needsUpdate = true;
              }
            }
          }
        });
      }
    } catch (e) {
      console.error("Failed to set fallback color", e);
    }
  }
</script>

<DependenciesTab
  rootFile={loadOrchestrator.rootFile}
  dependencies={loadOrchestrator.dependencies}
  filteredDependencies={filteredDependencies()}
  bind:filterText={loadOrchestrator.filterText}
  openErrorModal={loadOrchestrator.openErrorModal}
  {replaceWithColor}
/>
