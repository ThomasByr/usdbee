<script lang="ts">
  import * as THREE from "three";
  import PrimTree from "$lib/components/stage/PrimTree.svelte";
  import PropertyInspector from "$lib/components/stage/PropertyInspector.svelte";
  import type { RendererKit } from "$lib/three/RendererKit.svelte";

  let { viewer }: { viewer: RendererKit } = $props();

  // Hierarchy Tree State
  let expandedNodes = $state<Record<string, boolean>>({});
  let visibilityMap = $state<Record<string, boolean>>({});
  let colorUpdateMap = $state<Record<string, number>>({});
  let selectedNodeId = $state<string | null>(null);

  // Format bytes conditionally
  function traverseWithLockCheck(node: any, callback: (n: any) => void) {
    if (node.userData.locked) return;
    callback(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], callback);
      }
    }
  }

  function getCurrentNodeColorHex(node: any): string {
    if (node.userData.branchColorHex) {
      return node.userData.branchColorHex;
    }
    if (node.isMesh && node.material) {
      let mat = Array.isArray(node.material) ? node.material[0] : node.material;
      if (mat && mat.color) {
        return "#" + mat.color.getHexString();
      }
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        if (node.children[i].isMesh && node.children[i].material) {
          let mat = Array.isArray(node.children[i].material)
            ? node.children[i].material[0]
            : node.children[i].material;
          if (mat && mat.color) {
            return "#" + mat.color.getHexString();
          }
        }
      }
    }
    return "#dedede";
  }

  function applyBranchColor(node: any, hexColor: string) {
    if (!node) return;

    const color = new THREE.Color(hexColor);

    const applyColorToNode = (n: any) => {
      n.userData.branchColorHex = hexColor;
      colorUpdateMap[n.uuid] = (colorUpdateMap[n.uuid] || 0) + 1;

      if (n.isMesh && n.material) {
        let mats = Array.isArray(n.material) ? n.material : [n.material];
        if (!n.userData.originalMaterials) {
          n.userData.originalMaterials = mats.map((m: any) => m.clone());
        }
        const newMats = n.userData.originalMaterials.map((m: any) => {
          let newMat = m.clone();
          newMat.color = color;
          return newMat;
        });
        n.material = newMats.length === 1 ? newMats[0] : newMats;
      }
    };

    applyColorToNode(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], applyColorToNode);
      }
    }
  }

  function resetBranchColor(node: any) {
    if (!node) return;

    const resetColorOnNode = (n: any) => {
      delete n.userData.branchColorHex;
      colorUpdateMap[n.uuid] = (colorUpdateMap[n.uuid] || 0) + 1;

      if (n.isMesh && n.userData.originalMaterials) {
        n.material =
          n.userData.originalMaterials.length === 1
            ? n.userData.originalMaterials[0]
            : n.userData.originalMaterials;
        delete n.userData.originalMaterials;
      }
    };
    resetColorOnNode(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], resetColorOnNode);
      }
    }
  }

  // Rust-path objects are named by their exact prim path.
  function highlightPrimObject(path: string) {
    if (!viewer.loadedGroup || !viewer.scene || !path) return;
    let found: THREE.Object3D | null = null;
    viewer.loadedGroup.traverse((o) => {
      if (!found && o.name === path) found = o;
    });
    if (found) updateSelection(found);
  }

  function toggleBranchLock(node: any, locked: boolean) {
    if (!node) return;
    node.userData.locked = locked;
    colorUpdateMap[node.uuid] = (colorUpdateMap[node.uuid] || 0) + 1;
    viewer.selectedNode = viewer.selectedNode;
  }

  function updateSelection(node: any) {
    if (!viewer.scene) return;

    // Toggle off if already selected
    if (node && selectedNodeId === node.uuid) {
      selectedNodeId = null;
      viewer.selectedNode = null;
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
      viewer.scene.add(viewer.selectionHelper);
    }
  }

  // Expand / Collapse All
  function toggleAllExpanded(expand: boolean) {
    if (!viewer.loadedGroup) return;
    const applyExpand = (node: any) => {
      expandedNodes[node.uuid] = expand;
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          applyExpand(node.children[i]);
        }
      }
    };
    applyExpand(viewer.loadedGroup);
  }

  function toggleVisibility(node: any) {
    if (!node) return;
    const targetVisible = (visibilityMap[node.uuid] ?? node.visible) ? false : true;

    const applyVisToNode = (n: any) => {
      n.visible = targetVisible;
      visibilityMap[n.uuid] = targetVisible;
    };

    applyVisToNode(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], applyVisToNode);
      }
    }
  }
</script>

{#snippet treeNode(node: any, depth: number = 0)}
  <div class="tree-node">
    <div
      class="tree-node-label {selectedNodeId === node.uuid ? 'selected' : ''}"
      style="padding-left: {depth * 15}px;"
      onclick={(e) => {
        e.stopPropagation();
        updateSelection(node);
      }}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          updateSelection(node);
        }
      }}
      role="button"
      tabindex="0"
    >
      {#if node.children && node.children.length > 0}
        <!-- Expand/collapse chevron -->
        <button
          class="toggle-btn expand-btn"
          onclick={(e) => {
            e.stopPropagation();
            expandedNodes[node.uuid] = !expandedNodes[node.uuid];
          }}
        >
          {expandedNodes[node.uuid] ? "▼" : "▶"}
        </button>
      {/if}
      <span class="node-type">[{node.type}]</span>
      <span class="node-name" title={node.name}>{node.name || "Unnamed"}</span>

      <!-- Spacer to push eye button to the right -->
      <div style="flex: 1;"></div>

      <!-- Branch color tools -->
      <div style="display: flex; gap: 4px; align-items: center; margin-right: 6px;">
        <input
          type="color"
          value={(() => {
            let _ = colorUpdateMap[node.uuid];
            return getCurrentNodeColorHex(node);
          })()}
          oninput={(e) => {
            e.stopPropagation();
            applyBranchColor(node, e.currentTarget.value);
          }}
          onclick={(e) => e.stopPropagation()}
          style="width: 14px; height: 14px; padding: 0; border: none; background: transparent; cursor: pointer;"
          title="Set Branch Color"
        />
        <button
          class="tree-action-btn"
          style="font-size: 11px;"
          onclick={(e) => {
            e.stopPropagation();
            resetBranchColor(node);
          }}
          title="Reset Branch Color">Reset</button
        >
        <button
          class="tree-action-btn {(() => {
            let _ = colorUpdateMap[node.uuid];
            return node.userData.locked ? 'active-lock' : '';
          })()}"
          style="font-size: 11px;"
          onclick={(e) => {
            e.stopPropagation();
            toggleBranchLock(node, !node.userData.locked);
          }}
          title="Lock Branch (Ignore parent color)"
          >{(() => {
            let _ = colorUpdateMap[node.uuid];
            return node.userData.locked ? "🔒 Locked" : "🔓 Lock";
          })()}</button
        >
      </div>

      <!-- Visibility toggle -->
      <button
        class="tree-action-btn {(visibilityMap[node.uuid] ?? node.visible) ? 'active-vis' : 'inactive-vis'}"
        style="font-size: 11px; min-width: 24px;"
        onclick={(e) => {
          e.stopPropagation();
          toggleVisibility(node);
        }}
        title="Toggle Visibility"
      >
        {(visibilityMap[node.uuid] ?? node.visible) ? "👁" : "👁‍🗨"}
      </button>
    </div>
    {#if node.children && node.children.length > 0 && expandedNodes[node.uuid]}
      <div class="tree-node-children">
        {#each node.children as child}
          {@render treeNode(child, depth + 1)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="scene-split">
  <div class="scene-tree-wrap">
    <PrimTree onHighlight={(node) => highlightPrimObject(node.path)} />
  </div>
  <PropertyInspector />
</div>
<details>
  <summary>Viewport Objects</summary>
  {#if viewer.loadedGroup}
    <div>
      <button class="tree-action-btn" onclick={() => toggleAllExpanded(true)}>Expand all</button>
      <button class="tree-action-btn" onclick={() => toggleAllExpanded(false)}>Collapse all</button>
    </div>
    {@render treeNode(viewer.loadedGroup)}
  {:else}
    <p>No viewport objects loaded.</p>
  {/if}
</details>

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
